import { afterEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { routeStdioMcpLogsToStderr } from "../src/cursor/stdio-logs";

const children: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  const pending = children.splice(0);
  await Promise.allSettled(pending.map(child => child.close()));
});

function stdioEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  env.CURSOR_CHATGPT_WEB_SIMULATE = "1";
  return env;
}

test("cursor-mcp answers empty resource catalogs instead of Method not found", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(import.meta.dir, "../src/cli.ts"), "cursor-mcp"],
    env: stdioEnv(),
    stderr: "pipe",
  });
  const client = new Client({ name: "cursor-chatgpt-web-test", version: "0" });
  children.push(client);
  await client.connect(transport);

  const initialize = client.getServerCapabilities();
  expect(initialize?.tools).toBeDefined();
  expect(initialize?.resources).toBeDefined();

  const resources = await client.listResources();
  expect(resources.resources).toEqual([]);
  const templates = await client.listResourceTemplates();
  expect(templates.resourceTemplates).toEqual([]);
  const tools = await client.listTools();
  expect(tools.tools.map(tool => tool.name)).toEqual([
    "chatgpt_web_turn",
    "chatgpt_web_batch",
    "chatgpt_web_status",
    "chatgpt_web_cancel",
  ]);
});

test("Codex docs explain Desktop status-list teardown versus durable thread MCP", () => {
  const docs = readFileSync(new URL("../docs/codex.md", import.meta.url), "utf8");
  expect(docs).toContain("mcpServerStatus/list");
  expect(docs).toContain("cursor-mcp");
  expect(docs).toContain("ChatGPT.exe");
  expect(docs).toContain("codex.exe app-server");
  expect(docs).toContain("Do not install a second daemon");
  expect(docs).not.toMatch(/^\s*openai_base_url\s*=/m);
});

test("cursor-mcp routes diagnostic console output to stderr before stdio JSON-RPC starts", () => {
  const mcpSource = readFileSync(new URL("../src/cursor/mcp.ts", import.meta.url), "utf8");
  const routeAt = mcpSource.indexOf("routeStdioMcpLogsToStderr()");
  const connectAt = mcpSource.indexOf("await server.connect(transport)");
  expect(routeAt).toBeGreaterThan(-1);
  expect(connectAt).toBeGreaterThan(routeAt);
});

test("MCP diagnostic logs go to stderr instead of stdout", () => {
  const stderrChunks: string[] = [];
  const restore = routeStdioMcpLogsToStderr({
    write(chunk: string | Uint8Array) {
      stderrChunks.push(String(chunk));
      return true;
    },
  } as NodeJS.WritableStream);
  try {
    console.info("[chatgpt-web] browser diagnostic trace=job-1 checkpoint=prompt_attachment");
    console.log("[chatgpt-web] browser turn job-1 stage=prompt_attachment started");
    expect(stderrChunks.join("")).toContain("[chatgpt-web] browser diagnostic");
    expect(stderrChunks.join("")).toContain("stage=prompt_attachment started");
  } finally {
    restore();
  }
});
