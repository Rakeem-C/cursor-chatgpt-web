import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectCodexMcpIntegration } from "../src/codex/inspect";
import {
  installCodexMcpIntegration,
  removeCodexMcpConfig,
  uninstallCodexMcpIntegration,
  upsertCodexMcpConfig,
} from "../src/codex/mcp-installer";
import { CODEX_GPT_WEB_MCP_NAME, codexGptWebAgentToml, codexGptWebSkillMarkdown } from "../src/codex/policy";

test("install-codex writes MCP, agent, and skill without clobbering other servers or openai_base_url", () => {
  const codexHome = mkdtempSync(join(tmpdir(), "cursor-chatgpt-web-codex-mcp-"));
  try {
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, "config.toml"), [
      "model = \"gpt-5.6-terra\"",
      "",
      "[mcp_servers.node_repl]",
      "command = \"node_repl.exe\"",
      "args = []",
      "",
      "[mcp_servers.node_repl.env]",
      "FOO = \"bar\"",
      "",
    ].join("\n"));

    const first = installCodexMcpIntegration({ codexHome });
    const config = readFileSync(first.configPath, "utf8");
    expect(config).toContain("model = \"gpt-5.6-terra\"");
    expect(config).toContain("[mcp_servers.node_repl]");
    expect(config).toContain("[mcp_servers.node_repl.env]");
    expect(config).toContain("FOO = \"bar\"");
    expect(config).toContain(`[mcp_servers.${CODEX_GPT_WEB_MCP_NAME}]`);
    expect(config).toContain("cursor-mcp");
    expect(config).not.toMatch(/^\s*openai_base_url\s*=/m);
    expect(readFileSync(first.agentPath, "utf8")).toContain("chatgpt_web_turn");
    expect(readFileSync(first.agentPath, "utf8")).toContain(codexGptWebAgentToml().trim());
    expect(readFileSync(first.skillPath, "utf8")).toContain("awaitingTools");
    expect(readFileSync(first.skillPath, "utf8")).toBe(`${codexGptWebSkillMarkdown()}\n`);
    expect(inspectCodexMcpIntegration(codexHome).installed).toBe(true);
    expect(inspectCodexMcpIntegration(codexHome).openaiBaseUrlPresent).toBe(false);
    expect(first.mcpCommand.at(-1)).toBe("cursor-mcp");

    installCodexMcpIntegration({ codexHome });
    const merged = readFileSync(first.configPath, "utf8");
    expect(merged.match(/\[mcp_servers\.chatgpt-web\]/g)?.length).toBe(1);
    expect(merged).toContain("[mcp_servers.node_repl.env]");

    uninstallCodexMcpIntegration({ codexHome });
    const after = readFileSync(first.configPath, "utf8");
    expect(after).not.toContain("[mcp_servers.chatgpt-web]");
    expect(after).toContain("[mcp_servers.node_repl]");
    expect(after).toContain("FOO = \"bar\"");
    expect(after).not.toMatch(/^\s*openai_base_url\s*=/m);
    expect(existsSync(first.agentPath)).toBe(false);
    expect(existsSync(first.skillPath)).toBe(false);
    expect(inspectCodexMcpIntegration(codexHome).installed).toBe(false);
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("Codex MCP TOML upsert never injects openai_base_url", () => {
  const command = ["bun.exe", "cli.ts", "cursor-mcp"];
  const next = upsertCodexMcpConfig("model = \"gpt-5.6-terra\"\n", command);
  expect(next).toContain("command = \"bun.exe\"");
  expect(next).toContain("cursor-mcp");
  expect(next).not.toMatch(/^\s*openai_base_url\s*=/m);
  expect(removeCodexMcpConfig(next)).not.toContain("chatgpt-web");
});
