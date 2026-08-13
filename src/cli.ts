#!/usr/bin/env bun
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { timingSafeEqual } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { isAbsolute } from "node:path";
import { stdin, stdout } from "node:process";
import { applyCapturedLoginCapabilities, checkBrowserEngine, loginToChatGpt } from "./browser-login";
import { CHATGPT_CONNECTOR_NAME, defaultConfig, getConfigDir, getConfigPath, loadConfig, loadConfigForSetup, saveConfig } from "./config";
import { inspectLauncherBrowserHost, readLauncherBrowserHostDescriptor } from "./launcher-browser-host";
import {
  activateCodexIntegration,
  deactivateCodexIntegration,
  inspectCodexIntegration,
  uninstallCodexIntegration,
} from "./codex-integration";
import { formatDoctorReport, runDoctor } from "./doctor";
import { runChatGptMcpMain } from "./adapters/chatgpt-web/mcp-main";
import { runCursorChatGptWebMcpServer } from "./cursor/mcp";
import { installCursorIntegration, uninstallCursorIntegration } from "./cursor/installer";
import { inspectCursorIntegration } from "./cursor/inspect";
import { installCodexMcpIntegration, uninstallCodexMcpIntegration } from "./codex/mcp-installer";
import { detectChatGptWebCapabilities } from "./cursor/capabilities";
import { startCursorProtocolServer } from "./cursor/protocol";
import { getCursorSpecialistRuntime, resetCursorSpecialistRuntime } from "./cursor/runtime";
import { runCommand } from "./process";
import { startServer } from "./server";
import { assertServiceIdle, cancelBrowserTurns, getServiceStatus, installService, restartService, startService, stopService, uninstallService } from "./service";
import { existingFullSetupCredentials, setup, type SetupOptions } from "./setup";
import { installRuntimeKeyBytes, managedRuntimeKeyPath, stopTunnel, tunnelStatus, waitForTunnelReady } from "./tunnel";
import { getTunnelServiceStatus, restartTunnelService, startTunnelService, stopTunnelService, uninstallTunnelService } from "./tunnel-service";
import { VERSION } from "./version";

const HELP = `cursor-chatgpt-web ${VERSION}

ChatGPT Web specialist for Cursor. Default path is MCP delegation to GPT-5.6 Sol High.

Usage:
  cursor-chatgpt-web setup --browser-only [options]
  cursor-chatgpt-web login
  cursor-chatgpt-web doctor [--json]
  cursor-chatgpt-web cursor-mcp
  cursor-chatgpt-web install-cursor [--cursor-home PATH] [--dry-run]
  cursor-chatgpt-web uninstall-cursor [--cursor-home PATH]
  cursor-chatgpt-web install-codex [--codex-home PATH] [--dry-run]
  cursor-chatgpt-web uninstall-codex [--codex-home PATH]
  cursor-chatgpt-web cursor-status [--cursor-home PATH]
  cursor-chatgpt-web test-gpt-web [--simulate] [--live] [--prompt TEXT]
  cursor-chatgpt-web cursor-serve [--port NUMBER]
  cursor-chatgpt-web probe [--port NUMBER] [--checklist]
  cursor-chatgpt-web probe-subagent
  cursor-chatgpt-web mcp [--broker-socket PATH]
  cursor-chatgpt-web mcp-codex [--broker-socket PATH]
  cursor-chatgpt-web setup --full --tunnel-id ID --runtime-key-file PATH [options]
  cursor-chatgpt-web route <status|connect|disconnect>
  cursor-chatgpt-web browser check
  cursor-chatgpt-web serve
  cursor-chatgpt-web service <status|install|start|restart|stop|cancel-turns>
  cursor-chatgpt-web tunnel <status|start|restart|stop|key-import>
  cursor-chatgpt-web open <tunnels|runtime-keys|connectors>
  cursor-chatgpt-web uninstall --yes

Cursor specialist:
  cursor-mcp                   Stdio MCP server: chatgpt_web_turn, chatgpt_web_batch, chatgpt_web_status, chatgpt_web_cancel
  install-cursor               Write ~/.cursor/mcp.json, agents/chatgpt-web.md, and rules/chatgpt-web.mdc
  uninstall-cursor             Remove the Cursor MCP specialist without touching ChatGPT login
  install-codex                Write ~/.codex/config.toml MCP, agents/chatgpt-web.toml, and gpt-web-use skill
  uninstall-codex              Remove the Codex MCP specialist without touching ChatGPT login or openai_base_url
  cursor-status                Show Cursor MCP install, account modes, and live specialist slots 0/5
  test-gpt-web                 Run one High specialist turn (default --simulate; --live uses ChatGPT)
  cursor-serve                 Experimental OpenAI-compatible picker bridge (127.0.0.1)
  probe                        Capture real Cursor BYOK requests; --checklist prints the Phase 0 matrix
  probe-subagent               Print the Grok/Composer Task(model=chatgpt-web-high) probe template
  mcp / mcp-codex              Original ChatGPT-side Codex Native connector (full harness)

Setup options:
  --browser-only               Account-eligible Web models, full context/images, no local tools or tunnel
  --full                       Account-eligible Web models with tools; Pro remains read-only
  --port NUMBER                Loopback Responses port (default: 17841)
  --chrome PATH                Google Chrome/Chromium executable used for account login
  --browser-host-descriptor PATH
                               Use the embedded launcher browser described by this owner-only file
  --refresh-account-capabilities
                               Re-read the authenticated account's available Web models
  --app-name NAME              ChatGPT connector name (default: ${CHATGPT_CONNECTOR_NAME})
  --tunnel-id ID               Existing OpenAI tunnel id (full mode)
  --runtime-key-file PATH      File containing a Tunnels Read+Use runtime key
  --replace-codex-route        Reversibly replace an existing openai_base_url
  --restart-service            Explicitly restart this project's daemon after an update
  --login                      Refresh the stored ChatGPT login even if one exists
  --auto-approve-tool-calls    Opt in to per-call browser clicks on "Allow once" prompts
  --acknowledge-unofficial     Accept the one-time unofficial-browser-automation notice
  --skip-cursor-install        Do not write ~/.cursor/mcp.json during setup
  --skip-codex-install         Do not write ~/.codex MCP specialist during setup
  --cursor-home PATH           Cursor config directory for install-cursor / setup
  --codex-home PATH            Codex config directory for install-codex / setup

Global:
  --home PATH                  Override ~/.cursor-chatgpt-web
  -h, --help
  -v, --version
`;

function takeOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  args.splice(index, 2);
  return value;
}

function takeFlag(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

async function confirm(question: string): Promise<boolean> {
  if (!stdin.isTTY || !stdout.isTTY) return false;
  const reader = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await reader.question(`${question} [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    reader.close();
  }
}

async function prompt(question: string): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY) return "";
  const reader = createInterface({ input: stdin, output: stdout });
  try { return (await reader.question(question)).trim(); }
  finally { reader.close(); }
}

async function secretPrompt(question: string): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY) return "";
  stdout.write(question);
  const muted = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const reader = createInterface({ input: stdin, output: muted, terminal: true });
  try { return (await reader.question("")).trim(); }
  finally {
    reader.close();
    stdout.write("\n");
  }
}

function assertNoArgs(args: string[]): void {
  if (args.length > 0) throw new Error(`Unknown arguments: ${args.join(" ")}`);
}

function authorizeLauncherControl(operation: string): void {
  const descriptorPath = process.env.CODEX_CHATGPT_WEB_BROWSER_HOST_DESCRIPTOR?.trim();
  const supplied = process.env.CODEX_WEB_GPT_LAUNCHER_CONTROL_TOKEN?.trim();
  delete process.env.CODEX_WEB_GPT_LAUNCHER_CONTROL_TOKEN;
  if (!descriptorPath || !supplied) {
    throw new Error(`Launcher-controlled ${operation} requires a live launcher authorization`);
  }
  const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
  const expectedBytes = Buffer.from(descriptor.control.token);
  const suppliedBytes = Buffer.from(supplied);
  if (expectedBytes.length !== suppliedBytes.length || !timingSafeEqual(expectedBytes, suppliedBytes)) {
    throw new Error(`Launcher-controlled ${operation} authorization is invalid`);
  }
}

async function loginCommand(args: string[]): Promise<void> {
  const launcherControl = takeFlag(args, "--launcher-control");
  if (!launcherControl) {
    assertNoArgs(args);
    const config = loadConfig();
    if (config.browserHost === "launcher") {
      throw new Error("ChatGPT login is owned by the launcher; open Codex Web GPT and use its Sign in step");
    }
    const result = await loginToChatGpt(config);
    saveConfig(applyCapturedLoginCapabilities(config, result));
    stdout.write(`ChatGPT login stored at ${result.storageStatePath}\n`);
    stdout.write(`Account capabilities: sol=${result.solAvailable} pro=${result.proAvailable}\n`);
    return;
  }

  const chromeExecutablePath = takeOption(args, "--chrome");
  const storageStatePath = takeOption(args, "--storage-state");
  assertNoArgs(args);
  authorizeLauncherControl("login");
  if (!chromeExecutablePath || !isAbsolute(chromeExecutablePath)) {
    throw new Error("Launcher-controlled login requires --chrome with an absolute executable path");
  }
  if (!storageStatePath || !isAbsolute(storageStatePath)) {
    throw new Error("Launcher-controlled login requires --storage-state with an absolute path");
  }
  await loginToChatGpt({
    ...defaultConfig(),
    chromeExecutablePath,
    storageStatePath,
  });
  stdout.write("Launcher-controlled ChatGPT login captured for private-profile verification.\n");
}

async function setupCommand(args: string[]): Promise<void> {
  const browserOnly = takeFlag(args, "--browser-only");
  const full = takeFlag(args, "--full");
  if (browserOnly === full) throw new Error("Choose exactly one setup mode: --browser-only or --full");
  const portRaw = takeOption(args, "--port");
  let acknowledged = takeFlag(args, "--acknowledge-unofficial");
  const options: SetupOptions = {
    mode: full ? "full" : "browser-only",
    ...(portRaw ? { port: Number(portRaw) } : {}),
  };
  const appName = takeOption(args, "--app-name");
  const tunnelId = takeOption(args, "--tunnel-id");
  const runtimeKeyFile = takeOption(args, "--runtime-key-file");
  const chrome = takeOption(args, "--chrome");
  const browserHostDescriptorPath = takeOption(args, "--browser-host-descriptor");
  if (chrome) options.chromeExecutablePath = chrome;
  if (browserHostDescriptorPath) options.browserHostDescriptorPath = browserHostDescriptorPath;
  options.refreshAccountCapabilities = takeFlag(args, "--refresh-account-capabilities");
  if (appName) options.appName = appName;
  if (tunnelId) options.tunnelId = tunnelId;
  if (runtimeKeyFile) options.runtimeKeyFile = runtimeKeyFile;
  options.forceLogin = takeFlag(args, "--login");
  options.autoApproveToolCalls = takeFlag(args, "--auto-approve-tool-calls");
  options.replaceCodexRoute = takeFlag(args, "--replace-codex-route");
  options.restartService = takeFlag(args, "--restart-service");
  const skipCursorInstall = takeFlag(args, "--skip-cursor-install");
  const skipCodexInstall = takeFlag(args, "--skip-codex-install");
  const cursorHome = takeOption(args, "--cursor-home");
  const codexHome = takeOption(args, "--codex-home");
  assertNoArgs(args);

  if (!acknowledged) {
    stdout.write(
      "This is independent, unofficial software. It automates your ChatGPT web session, can break when the UI changes, "
      + "and must not be used to evade usage limits or access controls.\n",
    );
    acknowledged = await confirm("Continue and store this acknowledgement?");
  }
  if (!acknowledged) throw new Error("Setup cancelled: acknowledgement was not provided");
  options.acknowledgedUnofficial = true;

  const existing = existsSync(getConfigPath()) ? loadConfigForSetup() : undefined;
  const reusableCredentials = existingFullSetupCredentials(existing);
  const needsTunnelId = !options.tunnelId && !reusableCredentials.tunnelId;
  const needsRuntimeKey = !options.runtimeKeyFile
    && !reusableCredentials.runtimeKey
    && !existsSync(managedRuntimeKeyPath());

  if (full && (needsTunnelId || needsRuntimeKey) && stdin.isTTY) {
    stdout.write("Full mode needs an OpenAI tunnel and a runtime key with Tunnels Read + Use.\n");
    stdout.write("Tunnels: https://platform.openai.com/settings/organization/tunnels\n");
    stdout.write("Runtime keys: https://platform.openai.com/settings/organization/api-keys\n");
    if (needsTunnelId) options.tunnelId = await prompt("Tunnel id: ");
    if (needsRuntimeKey) {
      options.runtimeKeyValue = await secretPrompt("Runtime key (hidden): ");
    }
  }

  const result = await setup(options);
  stdout.write(`Setup complete: ${result.mode}\n`);
  stdout.write(`Config: ${result.configPath}\n`);
  if (result.connectorSetupRequired) {
    stdout.write("One account-level step remains: attach the tunnel to the ChatGPT connector named in config.\n");
    stdout.write("Open: https://chatgpt.com/#settings/Plugins\n");
  }
  if (skipCursorInstall) {
    stdout.write("Skipped Cursor MCP install. Run: cursor-chatgpt-web install-cursor\n");
  } else {
    const installed = installCursorIntegration(cursorHome ? { cursorHome } : {});
    stdout.write(`Installed Cursor MCP specialist: ${installed.mcpPath}\n`);
    stdout.write("Restart Cursor so it loads chatgpt_web_turn / chatgpt_web_batch.\n");
  }
  if (skipCodexInstall) {
    stdout.write("Skipped Codex MCP install. Run: cursor-chatgpt-web install-codex\n");
  } else {
    const installed = installCodexMcpIntegration(codexHome ? { codexHome } : {});
    stdout.write(`Installed Codex MCP specialist: ${installed.configPath}\n`);
    stdout.write("Restart Codex so it loads chatgpt_web_turn / chatgpt_web_batch.\n");
  }
}

async function doctorCommand(args: string[]): Promise<void> {
  const json = takeFlag(args, "--json");
  assertNoArgs(args);
  const report = await runDoctor();
  stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : formatDoctorReport(report));
  if (!report.ok) process.exitCode = 1;
}

async function routeCommand(args: string[]): Promise<void> {
  const action = args.shift() ?? "status";
  assertNoArgs(args);
  const result = action === "status"
    ? (() => {
        const status = inspectCodexIntegration();
        return {
          installed: status.installed,
          active: status.active,
          ...(status.routeUrl ? { routeUrl: status.routeUrl } : {}),
          errors: status.errors,
        };
      })()
    : action === "connect"
      ? activateCodexIntegration()
      : action === "disconnect"
        ? deactivateCodexIntegration()
        : undefined;
  if (!result) throw new Error(`Unknown route action: ${action}`);
  stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function serviceCommand(args: string[]): Promise<void> {
  const action = args.shift() ?? "status";
  assertNoArgs(args);
  const config = action === "status" ? undefined : loadConfig();
  if (action === "cancel-turns") {
    const cancelled = await cancelBrowserTurns(config!);
    stdout.write(`${JSON.stringify({ cancelledBrowserTurns: cancelled }, null, 2)}\n`);
    return;
  }
  const status = action === "status" ? getServiceStatus()
    : action === "install" ? installService(config!)
      : action === "start" ? startService()
        : action === "restart" ? await restartService(config!)
          : action === "stop" ? await stopService(config!)
            : undefined;
  if (!status) throw new Error(`Unknown service action: ${action}`);
  stdout.write(`${JSON.stringify(status, null, 2)}\n`);
}

async function tunnelCommand(args: string[]): Promise<void> {
  const action = args.shift() ?? "status";
  assertNoArgs(args);
  if (action === "key-import") {
    const key = await secretPrompt("Runtime key (hidden): ");
    if (!key) throw new Error("A non-empty runtime key is required");
    installRuntimeKeyBytes(key);
    stdout.write(`Runtime key stored privately at ${managedRuntimeKeyPath()}\n`);
    return;
  }
  const config = loadConfig();
  if (action === "start") startTunnelService();
  else if (action === "restart") {
    await assertServiceIdle(config);
    await restartTunnelService();
  }
  else if (action === "stop") {
    await assertServiceIdle(config);
    await stopTunnelService();
    stopTunnel(config);
  }
  else if (action !== "status") throw new Error(`Unknown tunnel action: ${action}`);
  const status = action === "start" || action === "restart"
    ? await waitForTunnelReady(config)
    : tunnelStatus(config);
  const service = getTunnelServiceStatus();
  stdout.write(`${JSON.stringify({ service, runtime: status }, null, 2)}\n`);
  if (action !== "stop" && (!service.running || !status.ok)) process.exitCode = 1;
}

async function openCommand(args: string[]): Promise<void> {
  const target = args.shift();
  assertNoArgs(args);
  const urls: Record<string, string> = {
    tunnels: "https://platform.openai.com/settings/organization/tunnels",
    "runtime-keys": "https://platform.openai.com/settings/organization/api-keys",
    connectors: "https://chatgpt.com/#settings/Plugins",
  };
  const url = target ? urls[target] : undefined;
  if (!url) throw new Error("Choose one of: tunnels, runtime-keys, connectors");
  if (process.platform === "darwin") {
    const result = runCommand("open", [url]);
    if (result.status !== 0) throw new Error(result.stderr.trim() || `Could not open ${url}`);
  } else {
    stdout.write(`${url}\n`);
  }
}

async function installCursorCommand(args: string[]): Promise<void> {
  const cursorHome = takeOption(args, "--cursor-home");
  const dryRun = takeFlag(args, "--dry-run");
  const portRaw = takeOption(args, "--port");
  assertNoArgs(args);
  const result = installCursorIntegration({
    ...(cursorHome ? { cursorHome } : {}),
    dryRun,
    ...(portRaw ? { port: Number(portRaw) } : {}),
  });
  stdout.write(`${JSON.stringify({
    dryRun,
    mcpPath: result.mcpPath,
    agentPath: result.agentPath,
    rulesPath: result.rulesPath,
    mcpCommand: result.mcpCommand,
    experimentalPicker: result.experimentalPicker,
  }, null, 2)}\n`);
}

async function cursorStatusCommand(args: string[]): Promise<void> {
  const cursorHome = takeOption(args, "--cursor-home");
  assertNoArgs(args);
  const cursor = inspectCursorIntegration(cursorHome);
  let capabilities: ReturnType<typeof detectChatGptWebCapabilities> | undefined;
  try {
    const config = loadConfig();
    capabilities = detectChatGptWebCapabilities({
      solAvailable: config.solAvailable,
      proAvailable: config.proAvailable,
    });
  } catch {
    capabilities = undefined;
  }
  const simulate = process.env.CURSOR_CHATGPT_WEB_SIMULATE === "1";
  const specialist = simulate ? getCursorSpecialistRuntime().status() : undefined;
  stdout.write(`${JSON.stringify({
    cursor,
    ...(capabilities ? { capabilities } : { capabilities: "run setup to detect ChatGPT account modes" }),
    pool: specialist
      ? { active: specialist.pool.active, max: specialist.pool.max }
      : { note: "Live 0/5 slots are reported by MCP chatgpt_web_status while cursor-mcp is running" },
  }, null, 2)}\n`);
}

async function testGptWebCommand(args: string[]): Promise<void> {
  const live = takeFlag(args, "--live");
  const simulate = takeFlag(args, "--simulate") || !live;
  const prompt = takeOption(args, "--prompt") || "Return a one-sentence confirmation that GPT Web High is reachable.";
  assertNoArgs(args);
  if (simulate) process.env.CURSOR_CHATGPT_WEB_SIMULATE = "1";
  else delete process.env.CURSOR_CHATGPT_WEB_SIMULATE;
  resetCursorSpecialistRuntime();
  const result = await getCursorSpecialistRuntime().turn({ prompt, mode: "high" });
  stdout.write(`${JSON.stringify({
    simulated: simulate,
    mode: result.mode,
    modelId: result.modelId,
    backendModel: result.backendModel,
    adapterEffort: result.adapterEffort,
    jobId: result.jobId,
    answer: result.answer,
  }, null, 2)}\n`);
}

async function uninstallCursorCommand(args: string[]): Promise<void> {
  const cursorHome = takeOption(args, "--cursor-home");
  assertNoArgs(args);
  const result = uninstallCursorIntegration(cursorHome ? { cursorHome } : {});
  stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function installCodexCommand(args: string[]): Promise<void> {
  const codexHome = takeOption(args, "--codex-home");
  const dryRun = takeFlag(args, "--dry-run");
  assertNoArgs(args);
  const result = installCodexMcpIntegration({
    ...(codexHome ? { codexHome } : {}),
    dryRun,
  });
  stdout.write(`${JSON.stringify({
    dryRun,
    configPath: result.configPath,
    agentPath: result.agentPath,
    skillPath: result.skillPath,
    mcpCommand: result.mcpCommand,
  }, null, 2)}\n`);
}

async function uninstallCodexCommand(args: string[]): Promise<void> {
  const codexHome = takeOption(args, "--codex-home");
  assertNoArgs(args);
  const result = uninstallCodexMcpIntegration(codexHome ? { codexHome } : {});
  stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function cursorServeCommand(args: string[]): Promise<void> {
  const portRaw = takeOption(args, "--port");
  assertNoArgs(args);
  const server = startCursorProtocolServer({
    host: "127.0.0.1",
    port: portRaw ? Number(portRaw) : 17842,
  });
  stdout.write(`cursor-chatgpt-web ${VERSION} experimental picker bridge on http://127.0.0.1:${server.port}/v1\n`);
  const { reviewCapturedFixtures } = await import("./cursor/fixtures/review");
  const review = reviewCapturedFixtures();
  stdout.write(`pickerMode=${review.pickerMode}; nativeTaskMode=${review.nativeTaskMode}\n`);
  if (review.pickerMode !== "supported") {
    stdout.write("Picker stays experimental until probe fixtures prove Cursor sent chatgpt-web-* traffic.\n");
  }
  await new Promise<void>(() => {});
}

async function uninstallCommand(args: string[]): Promise<void> {
  const yes = takeFlag(args, "--yes");
  const keepData = takeFlag(args, "--keep-data");
  const launcherControl = takeFlag(args, "--launcher-control");
  assertNoArgs(args);
  if (launcherControl) authorizeLauncherControl("uninstall");
  if (!yes && !await confirm("Restore Codex config, stop services, and remove this installation?")) {
    throw new Error("Uninstall cancelled");
  }
  const config = existsSync(getConfigPath()) ? loadConfig() : undefined;
  if (config?.browserHost === "launcher" && !launcherControl) {
    throw new Error(
      "Launcher-owned integration must be removed from Codex Web GPT Settings so the active runtime can be drained safely.",
    );
  }
  if (!config && process.platform === "darwin" && getServiceStatus().installed) {
    throw new Error("Service exists but configuration is missing; refusing an unverifiable uninstall");
  }
  const launcherRuntimeStopped = config?.browserHost === "launcher" && launcherControl;
  if (config && process.platform === "darwin" && !launcherRuntimeStopped) await assertServiceIdle(config);
  if (config?.mode === "full" && !launcherRuntimeStopped) {
    if (process.platform === "darwin") await uninstallTunnelService();
    stopTunnel(config);
  }
  if (config && process.platform === "darwin" && !launcherRuntimeStopped) await uninstallService(config);
  uninstallCodexIntegration();
  uninstallCodexMcpIntegration();
  if (!keepData) rmSync(getConfigDir(), { recursive: true, force: true });
  stdout.write(keepData ? "Uninstalled; private application data was preserved.\n" : "Uninstalled and removed private application data.\n");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const home = takeOption(args, "--home");
  if (home) process.env.CURSOR_CHATGPT_WEB_HOME = home;
  if (home) process.env.CODEX_CHATGPT_WEB_HOME = home;
  if (takeFlag(args, "--help") || takeFlag(args, "-h")) {
    stdout.write(HELP);
    return;
  }
  if (takeFlag(args, "--version") || takeFlag(args, "-v")) {
    stdout.write(`${VERSION}\n`);
    return;
  }
  const command = args.shift() ?? "help";
  if (command === "help") stdout.write(HELP);
  else if (command === "setup") await setupCommand(args);
  else if (command === "login") await loginCommand(args);
  else if (command === "doctor" || command === "status") await doctorCommand(args);
  else if (command === "route") await routeCommand(args);
  else if (command === "browser") {
    const action = args.shift();
    assertNoArgs(args);
    if (action !== "check") throw new Error("Browser command must be: browser check");
    const config = loadConfig();
    if (config.browserHost === "launcher") {
      await inspectLauncherBrowserHost(config.browserHostDescriptorPath!);
      stdout.write("Playwright can reach the authenticated ChatGPT surface embedded in the launcher.\n");
    } else {
      await checkBrowserEngine(config);
      stdout.write("Playwright can launch the configured Chrome executable.\n");
    }
  } else if (command === "serve") {
    assertNoArgs(args);
    const config = loadConfig();
    const server = startServer(config);
    stdout.write(`cursor-chatgpt-web ${VERSION} listening on http://${config.host}:${server.port}/v1 (${config.mode})\n`);
    await new Promise<void>(() => {});
  } else if (command === "mcp" || command === "mcp-codex") await runChatGptMcpMain(args);
  else if (command === "cursor-mcp") await runCursorChatGptWebMcpServer();
  else if (command === "install-cursor") await installCursorCommand(args);
  else if (command === "uninstall-cursor") await uninstallCursorCommand(args);
  else if (command === "install-codex") await installCodexCommand(args);
  else if (command === "uninstall-codex") await uninstallCodexCommand(args);
  else if (command === "cursor-status") await cursorStatusCommand(args);
  else if (command === "test-gpt-web") await testGptWebCommand(args);
  else if (command === "cursor-serve") await cursorServeCommand(args);
  else if (command === "probe") {
    const portRaw = takeOption(args, "--port");
    const checklist = takeFlag(args, "--checklist");
    assertNoArgs(args);
    const { printCursorProbeChecklist, startCursorProbeServer } = await import("./cursor/fixtures/capture-server");
    if (checklist) {
      stdout.write(printCursorProbeChecklist());
      return;
    }
    startCursorProbeServer(portRaw ? { port: Number(portRaw) } : {});
    await new Promise<void>(() => {});
  }
  else if (command === "probe-subagent") {
    assertNoArgs(args);
    const { printCursorSubagentProbeReport } = await import("./cursor/subagent-probe");
    stdout.write(printCursorSubagentProbeReport());
  }
  else if (command === "service") await serviceCommand(args);
  else if (command === "tunnel") await tunnelCommand(args);
  else if (command === "open") await openCommand(args);
  else if (command === "uninstall") await uninstallCommand(args);
  else throw new Error(`Unknown command: ${command}\n\n${HELP}`);
}

main().catch(error => {
  process.stderr.write(`cursor-chatgpt-web: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
