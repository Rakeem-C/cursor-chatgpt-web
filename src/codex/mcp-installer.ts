import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteFile, expandUserPath } from "../config";
import {
  CODEX_GPT_WEB_AGENT_NAME,
  CODEX_GPT_WEB_MCP_NAME,
  CODEX_GPT_WEB_SKILL_NAME,
  CODEX_GPT_WEB_STARTUP_TIMEOUT_SEC,
  codexGptWebAgentToml,
  codexGptWebSkillMarkdown,
  codexGptWebSkillYaml,
} from "./policy";

export const CODEX_GPT_WEB_TABLE = `mcp_servers.${CODEX_GPT_WEB_MCP_NAME}`;
const MANAGED_COMMENT = "# Managed by cursor-chatgpt-web install-codex; uninstall-codex removes this table.";

export interface CodexMcpInstallPaths {
  codexHome: string;
  configPath: string;
  agentsDir: string;
  agentPath: string;
  skillDir: string;
  skillPath: string;
  skillYamlPath: string;
}

export interface CodexMcpInstallResult {
  configPath: string;
  agentPath: string;
  skillPath: string;
  mcpCommand: string[];
}

export function resolveCodexHome(codexHome?: string): string {
  if (codexHome?.trim()) return resolve(codexHome.trim());
  const configured = process.env.CODEX_HOME?.trim();
  return resolve(expandUserPath(configured || join(homedir(), ".codex")));
}

export function codexMcpInstallPaths(codexHome?: string): CodexMcpInstallPaths {
  const home = resolveCodexHome(codexHome);
  const skillDir = join(home, "skills", CODEX_GPT_WEB_SKILL_NAME);
  const agentsDir = join(home, "agents");
  return {
    codexHome: home,
    configPath: join(home, "config.toml"),
    agentsDir,
    agentPath: join(agentsDir, `${CODEX_GPT_WEB_AGENT_NAME}.toml`),
    skillDir,
    skillPath: join(skillDir, "SKILL.md"),
    skillYamlPath: join(skillDir, "agents", "openai.yaml"),
  };
}

export function mcpCommand(): string[] {
  const entry = fileURLToPath(new URL("../cli.ts", import.meta.url));
  return [process.execPath, entry, "cursor-mcp"];
}

function tableName(line: string): string | undefined {
  const match = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line);
  return match?.[1];
}

function tableRange(lines: string[], name: string): { start: number; end: number } | undefined {
  const start = lines.findIndex(line => tableName(line) === name);
  if (start < 0) return undefined;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (tableName(lines[index]!) !== undefined) {
      end = index;
      break;
    }
  }
  return { start, end };
}

function lineEnding(text: string): "\n" | "\r\n" {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function splitLines(text: string): { lines: string[]; ending: "\n" | "\r\n"; trailingNewline: boolean } {
  return {
    lines: text.length > 0 ? text.replace(/\r?\n$/, "").split(/\r?\n/) : [],
    ending: lineEnding(text),
    trailingNewline: text.length === 0 || /\r?\n$/.test(text),
  };
}

function renderLines(lines: string[], ending: "\n" | "\r\n", trailingNewline: boolean): string {
  if (lines.length === 0) return trailingNewline ? ending : "";
  const body = lines.join(ending);
  return trailingNewline ? `${body}${ending}` : body;
}

function managedTableLines(command: string[]): string[] {
  return [
    MANAGED_COMMENT,
    `[${CODEX_GPT_WEB_TABLE}]`,
    `command = ${JSON.stringify(command[0])}`,
    `args = ${JSON.stringify(command.slice(1))}`,
    `startup_timeout_sec = ${CODEX_GPT_WEB_STARTUP_TIMEOUT_SEC}`,
  ];
}

function removeManagedTables(lines: string[]): string[] {
  const next: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const name = tableName(lines[index]!);
    const managed = name === CODEX_GPT_WEB_TABLE || name?.startsWith(`${CODEX_GPT_WEB_TABLE}.`);
    const managedComment = lines[index] === MANAGED_COMMENT
      && tableName(lines[index + 1] ?? "") === CODEX_GPT_WEB_TABLE;
    if (managedComment) {
      index += 1;
      continue;
    }
    if (managed) {
      const range = tableRange(lines, name!);
      index = range?.end ?? index + 1;
      continue;
    }
    next.push(lines[index]!);
    index += 1;
  }
  while (next.length > 0 && next[next.length - 1] === "") next.pop();
  return next;
}

export function upsertCodexMcpConfig(text: string, command: string[]): string {
  const document = splitLines(text);
  const without = removeManagedTables(document.lines);
  if (without.length > 0 && without[without.length - 1] !== "") without.push("");
  without.push(...managedTableLines(command));
  return renderLines(without, document.ending, true);
}

export function removeCodexMcpConfig(text: string): string {
  const document = splitLines(text);
  return renderLines(removeManagedTables(document.lines), document.ending, document.trailingNewline || document.lines.length > 0);
}

export function parseCodexMcpCommand(text: string): string[] | undefined {
  const { lines } = splitLines(text);
  const range = tableRange(lines, CODEX_GPT_WEB_TABLE);
  if (!range) return undefined;
  const body = lines.slice(range.start + 1, range.end);
  let command: string | undefined;
  let args: string[] | undefined;
  for (const line of body) {
    if (/^\s*#/.test(line) || !line.trim()) continue;
    const commandMatch = /^\s*command\s*=\s*(.+?)\s*$/.exec(line);
    if (commandMatch) {
      command = JSON.parse(commandMatch[1]!.trim()) as string;
      continue;
    }
    const argsMatch = /^\s*args\s*=\s*(.+?)\s*$/.exec(line);
    if (argsMatch) {
      args = JSON.parse(argsMatch[1]!.trim()) as string[];
    }
  }
  if (!command) return undefined;
  return [command, ...(args ?? [])];
}

export function installCodexMcpIntegration(options: {
  codexHome?: string;
  dryRun?: boolean;
} = {}): CodexMcpInstallResult {
  const paths = codexMcpInstallPaths(options.codexHome);
  const command = mcpCommand();
  if (!options.dryRun) {
    mkdirSync(paths.agentsDir, { recursive: true, mode: 0o700 });
    mkdirSync(dirname(paths.skillYamlPath), { recursive: true, mode: 0o700 });
    const current = existsSync(paths.configPath) ? readFileSync(paths.configPath, "utf8") : "";
    atomicWriteFile(paths.configPath, upsertCodexMcpConfig(current, command));
    atomicWriteFile(paths.agentPath, `${codexGptWebAgentToml()}\n`);
    atomicWriteFile(paths.skillPath, `${codexGptWebSkillMarkdown()}\n`);
    atomicWriteFile(paths.skillYamlPath, `${codexGptWebSkillYaml()}\n`);
  }
  return {
    configPath: paths.configPath,
    agentPath: paths.agentPath,
    skillPath: paths.skillPath,
    mcpCommand: command,
  };
}

export function uninstallCodexMcpIntegration(options: { codexHome?: string } = {}): {
  configPath: string;
  agentPath: string;
  skillPath: string;
} {
  const paths = codexMcpInstallPaths(options.codexHome);
  if (existsSync(paths.configPath)) {
    const current = readFileSync(paths.configPath, "utf8");
    atomicWriteFile(paths.configPath, removeCodexMcpConfig(current));
  }
  if (existsSync(paths.agentPath)) unlinkSync(paths.agentPath);
  if (existsSync(paths.skillPath)) unlinkSync(paths.skillPath);
  if (existsSync(paths.skillYamlPath)) unlinkSync(paths.skillYamlPath);
  return {
    configPath: paths.configPath,
    agentPath: paths.agentPath,
    skillPath: paths.skillPath,
  };
}
