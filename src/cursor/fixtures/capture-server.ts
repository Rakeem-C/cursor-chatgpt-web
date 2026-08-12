#!/usr/bin/env bun
/**
 * Phase 0 probe listener. Point Cursor's Override OpenAI Base URL here, send Ask and Agent
 * prompts, then inspect the captured JSON before enabling the experimental picker route.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

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
