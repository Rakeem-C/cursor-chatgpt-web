#!/usr/bin/env bun
/**
 * Phase 0 probe listener. Point Cursor's Override OpenAI Base URL here, send Ask and Agent
 * prompts, then inspect the captured JSON before enabling the experimental picker route.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const CURSOR_PROBE_CHECKLIST = [
  "Ask mode with custom model chatgpt-web-high",
  "Agent mode with custom model chatgpt-web-high",
  "Streaming",
  "Cancel",
  "Images",
  "Tools",
  "Follow-up / previous_response_id",
  "Custom models listed in /v1/models",
  "Subagent Task(model=chatgpt-web-high) from a Grok parent",
  "Subagent Task(model=chatgpt-web-high) from a Composer parent",
] as const;

export function printCursorProbeChecklist(): string {
  return [
    "Phase 0 — capture real Cursor traffic before treating the picker as supported.",
    "",
    ...CURSOR_PROBE_CHECKLIST.map((item, index) => `${index + 1}. ${item}`),
    "",
    "Also detect the ChatGPT account: Sol? High? Extra High? Pro? Luna-only?",
    "Do not invent request shapes. Point Cursor at http://127.0.0.1:17843/v1 and inspect src/cursor/fixtures/captured/.",
    "",
  ].join("\n");
}

export function startCursorProbeServer(options: { port?: number; dir?: string } = {}): { port: number; dir: string; stop: () => void } {
  const port = options.port ?? Number(process.env.CURSOR_CHATGPT_WEB_PROBE_PORT || 17843);
  const dir = resolve(options.dir || process.env.CURSOR_CHATGPT_WEB_CAPTURE_DIR || join(process.cwd(), "src/cursor/fixtures/captured"));
  mkdirSync(dir, { recursive: true });

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(req) {
      const url = new URL(req.url);
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      let body: unknown = null;
      const text = await req.text();
      if (text) {
        try { body = JSON.parse(text); }
        catch { body = text; }
      }
      const payload = {
        capturedAt: new Date().toISOString(),
        method: req.method,
        path: url.pathname,
        headers: Object.fromEntries(req.headers.entries()),
        body,
      };
      writeFileSync(join(dir, `${stamp}${url.pathname.replaceAll("/", "_") || "_root"}.json`), `${JSON.stringify(payload, null, 2)}\n`);
      writeFileSync(join(dir, "CHECKLIST.md"), printCursorProbeChecklist());
      if (url.pathname.endsWith("/models")) {
        return Response.json({
          object: "list",
          data: [{ id: "chatgpt-web-high", object: "model", owned_by: "cursor-chatgpt-web-probe" }],
        });
      }
      return new Response(JSON.stringify({
        error: {
          message: "Probe captured this request. The experimental picker is not enabled until fixtures are reviewed.",
          type: "invalid_request_error",
          code: "probe_only",
        },
      }), { status: 418, headers: { "content-type": "application/json" } });
    },
  });

  process.stdout.write(`cursor-chatgpt-web probe listening on http://127.0.0.1:${server.port}/v1\n`);
  process.stdout.write(`Capturing to ${dir}\n`);
  return { port: server.port ?? port, dir, stop: () => server.stop(true) };
}

if (import.meta.main) startCursorProbeServer();
