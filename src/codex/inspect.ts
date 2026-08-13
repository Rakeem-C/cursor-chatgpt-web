import { existsSync, readFileSync } from "node:fs";
import {
  CODEX_GPT_WEB_TABLE,
  codexMcpInstallPaths,
  parseCodexMcpCommand,
} from "./mcp-installer";

export interface CodexMcpSnapshot {
  installed: boolean;
  configPath: string;
  agentPath: string;
  skillPath: string;
  mcpCommand?: string[];
  agentPresent: boolean;
  skillPresent: boolean;
  openaiBaseUrlPresent: boolean;
  errors: string[];
}

export function inspectCodexMcpIntegration(codexHome?: string): CodexMcpSnapshot {
  const paths = codexMcpInstallPaths(codexHome);
  const errors: string[] = [];
  let mcpCommand: string[] | undefined;
  let openaiBaseUrlPresent = false;
  let installed = false;

  if (!existsSync(paths.configPath)) {
    errors.push(`Codex config is missing: ${paths.configPath}`);
  } else {
    const text = readFileSync(paths.configPath, "utf8");
    openaiBaseUrlPresent = /^\s*openai_base_url\s*=/m.test(text);
    mcpCommand = parseCodexMcpCommand(text);
    if (!mcpCommand) {
      errors.push(`Codex config does not define [${CODEX_GPT_WEB_TABLE}]`);
    } else {
      if (!mcpCommand[0]) errors.push("chatgpt-web MCP command is empty");
      if (mcpCommand.at(-1) !== "cursor-mcp") {
        errors.push("chatgpt-web MCP args must end with cursor-mcp");
      }
      installed = errors.length === 0;
    }
  }

  const agentPresent = existsSync(paths.agentPath);
  const skillPresent = existsSync(paths.skillPath);
  if (installed && !agentPresent) {
    errors.push(`Codex agent policy is missing: ${paths.agentPath}`);
    installed = false;
  }
  if (installed && !skillPresent) {
    errors.push(`Codex GPT Web skill is missing: ${paths.skillPath}`);
    installed = false;
  }

  return {
    installed,
    configPath: paths.configPath,
    agentPath: paths.agentPath,
    skillPath: paths.skillPath,
    ...(mcpCommand ? { mcpCommand } : {}),
    agentPresent,
    skillPresent,
    openaiBaseUrlPresent,
    errors,
  };
}
