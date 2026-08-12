import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cursorGptWebAgentMarkdown, installCursorIntegration, uninstallCursorIntegration } from "../src/cursor/installer";
import { inspectCursorIntegration } from "../src/cursor/inspect";

test("install-cursor writes MCP and the specialist agent without clobbering other servers", () => {
  const cursorHome = mkdtempSync(join(tmpdir(), "cursor-chatgpt-web-install-"));
  try {
    const first = installCursorIntegration({ cursorHome });
    const mcp = JSON.parse(readFileSync(first.mcpPath, "utf8")) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(mcp.mcpServers["chatgpt-web"]?.args.at(-1)).toBe("cursor-mcp");
    expect(readFileSync(first.agentPath, "utf8")).toContain("awaitingTools");
    expect(readFileSync(first.agentPath, "utf8")).toBe(cursorGptWebAgentMarkdown());
    expect(readFileSync(first.rulesPath, "utf8")).toContain("chatgpt_web_turn");
    expect(first.experimentalPicker.some(line => line.includes("chatgpt-web-high"))).toBe(true);
    expect(inspectCursorIntegration(cursorHome).installed).toBe(true);

    const withOther = {
      mcpServers: {
        other: { command: "echo", args: ["ok"] },
        "chatgpt-web": mcp.mcpServers["chatgpt-web"],
      },
    };
    writeFileSync(first.mcpPath, `${JSON.stringify(withOther, null, 2)}\n`);
    installCursorIntegration({ cursorHome });
    const merged = JSON.parse(readFileSync(first.mcpPath, "utf8")) as { mcpServers: Record<string, unknown> };
    expect(merged.mcpServers.other).toEqual({ command: "echo", args: ["ok"] });
    expect(merged.mcpServers["chatgpt-web"]).toBeDefined();

    uninstallCursorIntegration({ cursorHome });
    const after = JSON.parse(readFileSync(first.mcpPath, "utf8")) as { mcpServers: Record<string, unknown> };
    expect(after.mcpServers["chatgpt-web"]).toBeUndefined();
    expect(after.mcpServers.other).toEqual({ command: "echo", args: ["ok"] });
    expect(existsSync(first.agentPath)).toBe(false);
    expect(existsSync(first.rulesPath)).toBe(false);
    expect(inspectCursorIntegration(cursorHome).installed).toBe(false);
  } finally {
    rmSync(cursorHome, { recursive: true, force: true });
  }
});
