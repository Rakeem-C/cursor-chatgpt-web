import { existsSync, readFileSync } from "node:fs";
import { CURSOR_GPT_WEB_AGENT_NAME, CURSOR_GPT_WEB_MCP_NAME, cursorInstallPaths } from "./installer";

export interface CursorIntegrationSnapshot {
  installed: boolean;
  mcpPath: string;
  agentPath: string;
  rulesPath: string;
  mcpCommand?: string[];
  agentPresent: boolean;
  rulesPresent: boolean;
  errors: string[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function inspectCursorIntegration(cursorHome?: string): CursorIntegrationSnapshot {
  const paths = cursorInstallPaths(cursorHome);
  const errors: string[] = [];
  let mcpCommand: string[] | undefined;
  let installed = false;

  if (!existsSync(paths.mcpPath)) {
    errors.push(`Cursor MCP config is missing: ${paths.mcpPath}`);
  } else {
    try {
      const parsed = record(JSON.parse(readFileSync(paths.mcpPath, "utf8")));
      const servers = record(parsed?.mcpServers);
      const server = record(servers?.[CURSOR_GPT_WEB_MCP_NAME]);
      if (!server) {
        errors.push(`Cursor MCP config does not define ${CURSOR_GPT_WEB_MCP_NAME}`);
      } else {
        const command = typeof server.command === "string" ? server.command : "";
        const args = Array.isArray(server.args) ? server.args.map(String) : [];
        if (!command) errors.push("chatgpt-web MCP command is empty");
        if (args.at(-1) !== "cursor-mcp") errors.push("chatgpt-web MCP args must end with cursor-mcp");
        mcpCommand = [command, ...args];
        installed = errors.length === 0;
      }
    } catch (error) {
      errors.push(`Cursor MCP config is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const agentPresent = existsSync(paths.agentPath);
  const rulesPresent = existsSync(paths.rulesPath);
  if (installed && !agentPresent) {
    errors.push(`Cursor agent policy is missing: ${paths.agentPath}`);
    installed = false;
  }

  return {
    installed,
    mcpPath: paths.mcpPath,
    agentPath: paths.agentPath,
    rulesPath: paths.rulesPath,
    ...(mcpCommand ? { mcpCommand } : {}),
    agentPresent,
    rulesPresent,
    errors,
  };
}

export function cursorAgentFileName(): string {
  return `${CURSOR_GPT_WEB_AGENT_NAME}.md`;
}
