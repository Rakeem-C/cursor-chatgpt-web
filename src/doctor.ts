import { existsSync, readFileSync, statSync } from "node:fs";
import type { AppConfig } from "./config";
import { getConfigDir, getConfigPath, loadConfig } from "./config";
import { join } from "node:path";
import { inspectCodexIntegration } from "./codex-integration";
import { inspectCodexMcpIntegration } from "./codex/inspect";
import { detectChatGptWebCapabilities } from "./cursor/capabilities";
import { inspectCursorIntegration } from "./cursor/inspect";
import { browserLoginStateExists, loginVerificationMarkerPath } from "./browser-login";
import { getServiceStatus } from "./service";
import { tunnelStatus } from "./tunnel";
import { getTunnelServiceStatus } from "./tunnel-service";
import { inspectLauncherBrowserHost, readLauncherBrowserHostDescriptor } from "./launcher-browser-host";
import { processRunning } from "./process";

export type CheckStatus = "ok" | "warning" | "error";

export interface DoctorCheck {
  id: string;
  status: CheckStatus;
  message: string;
  detail?: string;
}

export interface DoctorReport {
  ok: boolean;
  mode?: AppConfig["mode"];
  checks: DoctorCheck[];
}

function secureFile(path: string): boolean {
  if (process.platform === "win32") return true;
  return (statSync(path).mode & 0o077) === 0;
}

function launcherOwnershipError(config: AppConfig, health: Record<string, unknown>): string | undefined {
  if (config.browserHost !== "launcher") return undefined;
  const path = join(getConfigDir(), "runtime", "launcher-supervisor.json");
  if (!existsSync(path)) return `Launcher runtime ownership marker is missing: ${path}`;
  let state: Record<string, unknown>;
  try {
    state = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    return `Launcher runtime ownership marker is invalid: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (state.version !== 1
    || !Number.isInteger(state.ownerPid)
    || (state.ownerPid as number) < 1
    || !Number.isInteger(state.daemonPid)
    || (state.daemonPid as number) < 1
    || state.status !== "ready") {
    return "Launcher runtime ownership marker is incomplete or not ready";
  }
  if (!processRunning(state.ownerPid)) {
    return `Launcher owner process is not running (pid ${String(state.ownerPid)})`;
  }
  if (health.pid !== state.daemonPid) {
    return `Responses proxy pid ${String(health.pid)} does not match launcher-owned pid ${String(state.daemonPid)}`;
  }
  return undefined;
}

async function proxyCheck(config: AppConfig): Promise<DoctorCheck> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetch(`http://${config.host}:${config.port}/healthz`, { signal: controller.signal });
    if (!response.ok) return { id: "proxy", status: "error", message: `Responses proxy returned HTTP ${response.status}` };
    const body = await response.json() as Record<string, unknown>;
    if (body.service !== "codex-chatgpt-web" || body.status !== "ok") {
      return { id: "proxy", status: "error", message: "The configured port belongs to another service" };
    }
    if (body.mode !== config.mode) {
      return { id: "proxy", status: "error", message: `Daemon is running in ${String(body.mode)} mode; config requires ${config.mode}` };
    }
    if (body.version !== config.releaseVersion) {
      return { id: "proxy", status: "error", message: `Daemon version is ${String(body.version)}; config requires ${config.releaseVersion}` };
    }
    if (body.accepting_turns !== true) {
      return {
        id: "proxy",
        status: "error",
        message: "Responses proxy is still drained and is not accepting Codex turns",
      };
    }
    const ownershipError = launcherOwnershipError(config, body);
    if (ownershipError) {
      return { id: "proxy", status: "error", message: "Responses proxy ownership could not be verified", detail: ownershipError };
    }
    return { id: "proxy", status: "ok", message: `Responses proxy is healthy on 127.0.0.1:${config.port}` };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { id: "proxy", status: "error", message: "Responses proxy is not reachable", detail };
  } finally {
    clearTimeout(timeout);
  }
}

export async function runDoctor(): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  let config: AppConfig;
  try {
    config = loadConfig();
    checks.push({ id: "config", status: "ok", message: `Configuration is valid (${getConfigPath()})` });
  } catch (error) {
    checks.push({ id: "config", status: "error", message: "Configuration is invalid", detail: error instanceof Error ? error.message : String(error) });
    return { ok: false, checks };
  }

  if (config.browserHost === "launcher") {
    try {
      const descriptor = readLauncherBrowserHostDescriptor(config.browserHostDescriptorPath!);
      await inspectLauncherBrowserHost(config.browserHostDescriptorPath!, { timeoutMs: 30_000 });
      checks.push({
        id: "browser-host",
        status: "ok",
        message: `Embedded launcher browser is authenticated and reachable (pid ${descriptor.pid})`,
      });
    } catch (error) {
      checks.push({
        id: "browser-host",
        status: "error",
        message: "Embedded launcher browser is unavailable",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  } else {
    if (!existsSync(config.chromeExecutablePath)) {
      checks.push({ id: "chrome", status: "error", message: `Chrome executable is missing: ${config.chromeExecutablePath}` });
    } else {
      checks.push({ id: "chrome", status: "ok", message: `Chrome executable found: ${config.chromeExecutablePath}` });
    }
    if (!browserLoginStateExists(config)) {
      checks.push({ id: "login", status: "error", message: "ChatGPT login state is missing or unverified; run `cursor-chatgpt-web login`" });
    } else if (!secureFile(config.storageStatePath)) {
      checks.push({ id: "login", status: "error", message: `ChatGPT login state is readable by other users: ${config.storageStatePath}` });
    } else if (!secureFile(loginVerificationMarkerPath(config.storageStatePath))) {
      checks.push({ id: "login", status: "error", message: "ChatGPT login verification marker is readable by other users" });
    } else {
      checks.push({ id: "login", status: "ok", message: "ChatGPT login state has authenticated browser evidence" });
    }
  }

  const cursor = inspectCursorIntegration();
  checks.push(cursor.installed
    ? { id: "cursor-mcp", status: "ok", message: `Cursor MCP specialist is installed (${cursor.mcpPath})` }
    : {
        id: "cursor-mcp",
        status: "warning",
        message: "Cursor MCP specialist is not installed; run `cursor-chatgpt-web install-cursor`",
        detail: cursor.errors.join("; ") || undefined,
      });

  const codexMcp = inspectCodexMcpIntegration();
  checks.push(codexMcp.installed
    ? { id: "codex-mcp", status: "ok", message: `Codex MCP specialist is installed (${codexMcp.configPath})` }
    : {
        id: "codex-mcp",
        status: "warning",
        message: "Codex MCP specialist is not installed; run `cursor-chatgpt-web install-codex`",
        detail: codexMcp.errors.join("; ") || undefined,
      });

  const codex = inspectCodexIntegration();
  if (!codex.installed) {
    checks.push({
      id: "codex",
      status: "warning",
      message: "Codex BYOK openai_base_url route is not installed (optional; MCP specialist is the supported Codex path)",
    });
  } else if (codex.errors.length > 0) {
    checks.push({ id: "codex", status: "error", message: "Codex BYOK route is inconsistent", detail: codex.errors.join("; ") });
  } else {
    checks.push({ id: "codex", status: "ok", message: "Codex BYOK Responses route is installed" });
  }
  const requireCodexRuntime = codex.installed;

  const detected = detectChatGptWebCapabilities({
    solAvailable: config.solAvailable,
    proAvailable: config.proAvailable,
  });
  checks.push({
    id: "account-modes",
    status: detected.highAvailable || detected.lunaOnly ? "ok" : "error",
    message: detected.lunaOnly
      ? "ChatGPT account is Luna-only; default specialist is chatgpt-web-luna"
      : detected.extraHighAvailable
        ? "ChatGPT High, Extra High, and Pro are available; default specialist is chatgpt-web-high"
        : "ChatGPT High is available; default specialist is chatgpt-web-high",
    detail: detected.modes.filter(mode => mode.available).map(mode => mode.cursorId).join(", "),
  });
  checks.push({
    id: "picker",
    status: detected.pickerMode === "supported" ? "ok" : "warning",
    message: detected.pickerMode === "supported"
      ? "Captured Cursor fixtures prove the experimental picker route"
      : "Model picker stays experimental until `cursor-chatgpt-web probe` captures chatgpt-web-* traffic",
    detail: detected.fixtures.notes.join(" ") || undefined,
  });
  checks.push({
    id: "native-task",
    status: detected.nativeTaskMode === "supported" ? "ok" : "warning",
    message: detected.nativeTaskMode === "supported"
      ? "Captured Cursor fixtures prove Task(model=chatgpt-web-high)"
      : "Native Task(model=chatgpt-web-high) stays probe-only; MCP remains the supported path",
  });

  const service = getServiceStatus();
  if (config.browserHost === "launcher") {
    checks.push(service.installed || service.loaded
      ? {
          id: "service",
          status: "warning",
          message: "A legacy OS background service still exists; rerun launcher setup to migrate ownership",
          detail: JSON.stringify(service),
        }
      : { id: "service", status: "ok", message: "Launcher owns the background runtime" });
  } else if (!service.supported) {
    checks.push({
      id: "service",
      status: requireCodexRuntime ? "warning" : "ok",
      message: requireCodexRuntime
        ? "Managed service is unavailable on this OS; keep `serve` running manually for the Codex proxy"
        : "Managed OS service is not required for the Cursor MCP specialist",
    });
  } else if (!service.installed || !service.loaded) {
    checks.push({
      id: "service",
      status: requireCodexRuntime ? "error" : "warning",
      message: requireCodexRuntime
        ? "macOS background service is not installed and loaded"
        : "macOS background service is not installed (optional for the Cursor MCP specialist)",
    });
  } else {
    checks.push({ id: "service", status: "ok", message: "macOS background service is loaded" });
  }
  const proxy = await proxyCheck(config);
  checks.push(!requireCodexRuntime && proxy.status === "error"
    ? {
        ...proxy,
        status: "warning",
        message: `${proxy.message} (optional unless you use the Codex Responses proxy)`,
      }
    : proxy);

  if (config.mode === "full") {
    const settings = config.tunnel!;
    if (!existsSync(settings.binaryPath)) {
      checks.push({ id: "tunnel-binary", status: "error", message: `tunnel-client is missing: ${settings.binaryPath}` });
    } else {
      checks.push({ id: "tunnel-binary", status: "ok", message: "Pinned openai/tunnel-client binary is installed" });
    }
    if (!existsSync(settings.runtimeKeyFile)) {
      checks.push({ id: "tunnel-key", status: "error", message: "Tunnel runtime key file is missing" });
    } else if (!secureFile(settings.runtimeKeyFile)) {
      checks.push({ id: "tunnel-key", status: "error", message: "Tunnel runtime key file has unsafe permissions" });
    } else {
      checks.push({ id: "tunnel-key", status: "ok", message: "Tunnel runtime key is stored privately" });
    }
    const tunnelService = getTunnelServiceStatus();
    if (config.browserHost === "launcher") {
      checks.push(tunnelService.installed || tunnelService.loaded
        ? {
            id: "tunnel-service",
            status: "warning",
            message: "A legacy OS tunnel service still exists; rerun launcher MCP setup to migrate ownership",
            detail: JSON.stringify(tunnelService),
          }
        : { id: "tunnel-service", status: "ok", message: "Launcher owns the tunnel runtime" });
    } else {
      checks.push(tunnelService.installed && tunnelService.loaded && tunnelService.running
        ? { id: "tunnel-service", status: "ok", message: "macOS tunnel service is installed, loaded, and running" }
        : { id: "tunnel-service", status: "error", message: "macOS tunnel service is not fully running", detail: JSON.stringify(tunnelService) });
    }
    const runtime = tunnelStatus(config);
    checks.push(runtime.ok
      ? { id: "tunnel-runtime", status: "ok", message: "Tunnel runtime reports healthy and ready" }
      : { id: "tunnel-runtime", status: "error", message: "Tunnel runtime is not ready", detail: runtime.detail });
    checks.push({
      id: "connector",
      status: "warning",
      message: `Local checks cannot prove that ChatGPT connector ${JSON.stringify(config.appName)} is attached to this tunnel`,
      detail: "Verify it once at https://chatgpt.com/#settings/Plugins while the tunnel is ready.",
    });
  } else {
    checks.push({ id: "tools", status: "warning", message: "Browser-only mode intentionally has no local tools or MCP tunnel" });
  }

  return {
    ok: !checks.some(check => check.status === "error"),
    mode: config.mode,
    checks,
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const icon: Record<CheckStatus, string> = { ok: "✓", warning: "!", error: "✗" };
  const lines = report.checks.flatMap(check => [
    `${icon[check.status]} ${check.message}`,
    ...(check.detail ? [`  ${check.detail}`] : []),
  ]);
  lines.push(report.ok ? "Doctor result: ready" : "Doctor result: not ready");
  return `${lines.join("\n")}\n`;
}
