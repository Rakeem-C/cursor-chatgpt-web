import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { createServer } from "node:net";
import { chromium, type Browser, type ConnectOverCDPTransport } from "playwright-core";

export interface ManagedChromeCdpSession {
  browser: Browser;
  close: () => Promise<void>;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms));
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string" || address.address !== "127.0.0.1" || address.port < 1) {
    await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    throw new Error("Could not reserve a private loopback port for managed Chrome");
  }
  const port = address.port;
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close(error => error ? rejectClose(error) : resolveClose());
  });
  return port;
}

async function waitForDevToolsEndpoint(port: number, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { cache: "no-store" });
      if (response.ok) {
        const payload = await response.json() as { webSocketDebuggerUrl?: string };
        if (typeof payload.webSocketDebuggerUrl === "string" && payload.webSocketDebuggerUrl.startsWith("ws://")) {
          return payload.webSocketDebuggerUrl;
        }
        lastError = "missing webSocketDebuggerUrl";
      } else {
        lastError = `HTTP ${response.status}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(100);
  }
  throw new Error(`Managed Chrome did not expose DevTools on 127.0.0.1:${port} within ${timeoutMs}ms (${lastError})`);
}

async function openNativeCdpTransport(endpoint: string, timeoutMs: number): Promise<ConnectOverCDPTransport> {
  const socket = new WebSocket(endpoint);
  await new Promise<void>((resolveOpen, rejectOpen) => {
    const timer = setTimeout(() => {
      socket.close();
      rejectOpen(new Error("Managed Chrome DevTools connection timed out"));
    }, timeoutMs);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolveOpen();
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      rejectOpen(new Error("Managed Chrome rejected its loopback DevTools connection"));
    }, { once: true });
  });

  const transport: ConnectOverCDPTransport = {
    send(message) {
      socket.send(JSON.stringify(message));
    },
    close() {
      socket.close();
    },
  };
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") {
      transport.onclose?.("Managed Chrome returned a non-text DevTools message");
      socket.close();
      return;
    }
    try {
      transport.onmessage?.(JSON.parse(event.data) as object);
    } catch {
      transport.onclose?.("Managed Chrome returned malformed DevTools JSON");
      socket.close();
    }
  });
  socket.addEventListener("close", event => transport.onclose?.(event.reason));
  return transport;
}

function terminateChromeTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (process.platform === "win32" && Number.isInteger(pid) && pid && pid > 0) {
    const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
    spawnSync(win32.join(systemRoot, "System32", "taskkill.exe"), ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
      timeout: 10_000,
    });
    return;
  }
  child.kill("SIGTERM");
}

export function shouldLaunchChromeOverCdp(platform = process.platform): boolean {
  return platform === "win32";
}

export async function launchManagedChromeOverCdp(options: {
  chromeExecutablePath: string;
  headed: boolean;
  timeoutMs?: number;
}): Promise<ManagedChromeCdpSession> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const profileDir = join(tmpdir(), `cursor-chatgpt-web-chrome-${process.pid}-${Date.now()}`);
  mkdirSync(profileDir, { recursive: true });
  const port = await reserveLoopbackPort();
  const child = spawn(options.chromeExecutablePath, [
    `--user-data-dir=${profileDir}`,
    "--new-window",
    "--disable-background-mode",
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${port}`,
    "--no-first-run",
    "--no-default-browser-check",
    ...(options.headed ? [] : ["--headless=new"]),
    "about:blank",
  ], {
    detached: process.platform !== "win32",
    env: process.env,
    stdio: "ignore",
  });
  let spawnError: Error | undefined;
  child.once("error", error => {
    spawnError = error;
  });
  try {
    if (spawnError) throw spawnError;
    const endpoint = await waitForDevToolsEndpoint(port, timeoutMs);
    if (spawnError) throw spawnError;
    const transport = await openNativeCdpTransport(endpoint, timeoutMs);
    const browser = await chromium.connectOverCDP(transport, { timeout: timeoutMs });
    return {
      browser,
      async close() {
        try {
          if (browser.isConnected()) {
            const session = await browser.newBrowserCDPSession();
            await session.send("Browser.close").catch(() => {});
          }
        } catch {
          // Process teardown below is authoritative.
        }
        try {
          await browser.close();
        } catch {
          // Ignore disconnect races.
        }
        terminateChromeTree(child);
        try {
          rmSync(profileDir, { recursive: true, force: true });
        } catch {
          // Windows can keep the profile locked briefly after taskkill.
        }
      },
    };
  } catch (error) {
    terminateChromeTree(child);
    try {
      rmSync(profileDir, { recursive: true, force: true });
    } catch {
      // Preserve the original DevTools error.
    }
    throw error;
  }
}
