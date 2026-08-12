import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CURSOR_GPT_WEB_AGENT_NAME = "chatgpt-web";
export const CURSOR_GPT_WEB_MCP_NAME = "chatgpt-web";

export interface CursorInstallPaths {
  cursorHome: string;
  mcpPath: string;
  agentsDir: string;
  agentPath: string;
}

export interface CursorInstallResult {
  mcpPath: string;
  agentPath: string;
  mcpCommand: string[];
  experimentalPicker: string[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function resolveCursorHome(cursorHome?: string): string {
  return resolve(cursorHome?.trim() || join(homedir(), ".cursor"));
}

export function cursorInstallPaths(cursorHome?: string): CursorInstallPaths {
  const home = resolveCursorHome(cursorHome);
  const agentsDir = join(home, "agents");
  return {
    cursorHome: home,
    mcpPath: join(home, "mcp.json"),
    agentsDir,
    agentPath: join(agentsDir, `${CURSOR_GPT_WEB_AGENT_NAME}.md`),
  };
}

export function cursorGptWebAgentMarkdown(): string {
  return `---
name: ${CURSOR_GPT_WEB_AGENT_NAME}
description: ChatGPT Web specialist (GPT-5.6 Sol High by default). Use for independent architecture review, hard root-cause analysis, authorization/security second opinions, and ambiguous implementation choices. Prefer chatgpt_web_turn / chatgpt_web_batch MCP tools. Do not assume Task(model=chatgpt-web-high) works.
---

You are the Cursor-side policy for GPT Web, an expensive senior specialist.

Call GPT Web High when:
- architecture is ambiguous
- root cause is difficult
- several plausible implementations exist
- security or authorization needs independent review
- a large refactor needs a second opinion
- repeated tests are failing without an obvious cause
- the task benefits from a strong independent reasoning pass

Do not use GPT Web for:
- trivial edits
- formatting
- simple searches
- obvious one-line fixes
- tasks you can solve confidently yourself

Delegation rules:
- Compile a focused envelope (task, goal, relevant files/context, constraints, deliverable).
- Omit threadId for a fresh Temporary Chat per job.
- Pass threadId only when the user asked to continue a named specialist thread.
- Use chatgpt_web_batch for independent parallel reviews (max 5).
- You keep Read, Search, Shell, ApplyPatch, git, and tests. GPT Web reasons; you act.
`;
}

export function experimentalPickerInstructions(port = 17842): string[] {
  return [
    "Experimental model-picker route (unsupported until your Cursor build is probed):",
    "1. Cursor Settings → Models → Add Custom Model for each of: chatgpt-web-instant, chatgpt-web-medium, chatgpt-web-high, chatgpt-web-extra-high, chatgpt-web-pro",
    "2. Enable those models in the picker. Never name them gpt-5.5 / gpt-5.6 — unique IDs only.",
    "3. OpenAI API Key = any local token you generated for the daemon (not a real OpenAI key).",
    `4. Override OpenAI Base URL = http://127.0.0.1:${port}/v1 — only if you are not already using OpenAI BYOK.`,
    "5. Network → HTTP Compatibility Mode → HTTP/1.1",
    "6. Restart Cursor, select GPT Web — High, send a short probe prompt.",
    "If a built-in Cursor model is selected, it must never hit this daemon.",
  ];
}

function mcpCommand(): string[] {
  const entry = fileURLToPath(new URL("../cli.ts", import.meta.url));
  return [process.execPath, entry, "cursor-mcp"];
}

export function installCursorIntegration(options: {
  cursorHome?: string;
  dryRun?: boolean;
  port?: number;
} = {}): CursorInstallResult {
  const paths = cursorInstallPaths(options.cursorHome);
  const command = mcpCommand();
  const mcpConfig = {
    mcpServers: {
      [CURSOR_GPT_WEB_MCP_NAME]: {
        command: command[0],
        args: command.slice(1),
      },
    },
  };

  if (!options.dryRun) {
    mkdirSync(paths.agentsDir, { recursive: true });
    let existing: Record<string, unknown> = {};
    if (existsSync(paths.mcpPath)) {
      const parsed = record(JSON.parse(readFileSync(paths.mcpPath, "utf8")));
      if (!parsed) throw new Error(`Cursor MCP config is not a JSON object: ${paths.mcpPath}`);
      existing = parsed;
    }
    const servers = record(existing.mcpServers) ?? {};
    existing.mcpServers = {
      ...servers,
      [CURSOR_GPT_WEB_MCP_NAME]: mcpConfig.mcpServers[CURSOR_GPT_WEB_MCP_NAME],
    };
    writeFileSync(paths.mcpPath, `${JSON.stringify(existing, null, 2)}\n`);
    writeFileSync(paths.agentPath, cursorGptWebAgentMarkdown());
  }

  return {
    mcpPath: paths.mcpPath,
    agentPath: paths.agentPath,
    mcpCommand: command,
    experimentalPicker: experimentalPickerInstructions(options.port),
  };
}

export function uninstallCursorIntegration(options: { cursorHome?: string } = {}): { mcpPath: string; agentPath: string } {
  const paths = cursorInstallPaths(options.cursorHome);
  if (existsSync(paths.mcpPath)) {
    const parsed = record(JSON.parse(readFileSync(paths.mcpPath, "utf8"))) ?? {};
    const servers = record(parsed.mcpServers) ?? {};
    delete servers[CURSOR_GPT_WEB_MCP_NAME];
    parsed.mcpServers = servers;
    writeFileSync(paths.mcpPath, `${JSON.stringify(parsed, null, 2)}\n`);
  }
  if (existsSync(paths.agentPath)) unlinkSync(paths.agentPath);
  return { mcpPath: paths.mcpPath, agentPath: paths.agentPath };
}
