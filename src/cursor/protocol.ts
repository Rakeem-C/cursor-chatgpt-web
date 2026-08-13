import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { availableCursorChatGptWebRoutes, parseCursorChatGptWebMode } from "../chatgpt-web-models";
import { CursorChatGptWebError, isCursorChatGptWebError, UnknownCursorModelError } from "./errors";
import { getCursorSpecialistRuntime } from "./runtime";
import type { SpecialistImage, SpecialistToolCall, SpecialistToolResult, SpecialistToolSpec, SpecialistTurnResult } from "./task-session";

export interface CursorTurn {
  model: string;
  input: string;
  images?: SpecialistImage[];
  previousResponseId?: string;
  stream: boolean;
  abortSignal: AbortSignal;
  ignoredToolCount: number;
  tools?: SpecialistToolSpec[];
  toolResults?: SpecialistToolResult[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(part => {
    const item = record(part);
    if (!item) return "";
    if (typeof item.text === "string") return item.text;
    if (item.type === "output_text" && typeof item.text === "string") return item.text;
    if (item.type === "input_text" && typeof item.text === "string") return item.text;
    return "";
  }).filter(Boolean).join("\n");
}

function imageFromPart(part: unknown): SpecialistImage | undefined {
  const item = record(part);
  if (!item) return undefined;
  const nested = record(item.image_url) ?? record(item.imageUrl);
  const imageUrl = typeof item.imageUrl === "string"
    ? item.imageUrl
    : typeof nested?.url === "string"
      ? nested.url
      : typeof item.image_url === "string"
        ? item.image_url
        : undefined;
  if (!imageUrl) return undefined;
  const detail = typeof item.detail === "string"
    ? item.detail
    : typeof nested?.detail === "string"
      ? nested.detail
      : undefined;
  return { imageUrl, ...(detail ? { detail } : {}) };
}

function collectTools(body: Record<string, unknown>): SpecialistToolSpec[] {
  if (!Array.isArray(body.tools)) return [];
  return body.tools.flatMap(item => {
    const rec = record(item);
    const fn = record(rec?.function);
    const name = typeof rec?.name === "string"
      ? rec.name
      : typeof fn?.name === "string"
        ? fn.name
        : undefined;
    if (!name?.trim()) return [];
    const description = typeof rec?.description === "string"
      ? rec.description
      : typeof fn?.description === "string"
        ? fn.description
        : undefined;
    const parameters = record(rec?.parameters) ?? record(fn?.parameters);
    return [{
      name: name.trim(),
      ...(description ? { description } : {}),
      ...(parameters ? { parameters } : {}),
    }];
  });
}

function collectToolResults(body: Record<string, unknown>): SpecialistToolResult[] {
  const messages = Array.isArray(body.messages) ? body.messages : Array.isArray(body.input) ? body.input : [];
  const results: SpecialistToolResult[] = [];
  for (const message of messages) {
    const item = record(message);
    if (!item) continue;
    if (item.role !== "tool" && item.type !== "function_call_output") continue;
    const content = textFromContent(item.content)
      || (typeof item.output === "string" ? item.output : "")
      || (typeof item.content === "string" ? item.content : "");
    results.push({
      ...(typeof item.tool_call_id === "string" ? { id: item.tool_call_id } : typeof item.call_id === "string" ? { id: item.call_id } : {}),
      ...(typeof item.name === "string" ? { name: item.name } : {}),
      content,
    });
  }
  return results;
}

function lastUserText(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? body.messages : Array.isArray(body.input) ? body.input : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const item = record(messages[index]);
    if (!item) continue;
    if (item.role === "user" || item.type === "message" && item.role === "user") {
      return textFromContent(item.content).trim();
    }
  }
  return "";
}

function collectImages(body: Record<string, unknown>): SpecialistImage[] {
  const images: SpecialistImage[] = [];
  const walk = (content: unknown) => {
    if (!Array.isArray(content)) return;
    for (const part of content) {
      const image = imageFromPart(part);
      if (image) images.push(image);
    }
  };
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) walk(record(message)?.content);
  }
  if (Array.isArray(body.input)) {
    for (const message of body.input) walk(record(message)?.content ?? message);
  }
  return images.slice(0, 10);
}

function collectMessages(body: Record<string, unknown>): string {
  if (Array.isArray(body.messages)) {
    return body.messages.map(message => {
      const item = record(message);
      if (!item) return "";
      const role = typeof item.role === "string" ? item.role : "unknown";
      return `${role}:\n${textFromContent(item.content)}`;
    }).filter(part => part.trim().length > 0).join("\n\n");
  }
  if (Array.isArray(body.input)) {
    return body.input.map(message => {
      const item = record(message);
      if (!item) return typeof message === "string" ? message : "";
      if (typeof item.content === "string" || Array.isArray(item.content)) {
        const role = typeof item.role === "string" ? item.role : "user";
        return `${role}:\n${textFromContent(item.content)}`;
      }
      return textFromContent(item);
    }).filter(part => part.trim().length > 0).join("\n\n");
  }
  if (typeof body.prompt === "string") return body.prompt;
  return "";
}

export function parseCursorHttpBody(body: unknown, abortSignal: AbortSignal): CursorTurn {
  const parsed = record(body);
  if (!parsed) throw new CursorChatGptWebError("Request body must be a JSON object", { status: 400, code: "invalid_body" });
  const model = typeof parsed.model === "string" ? parsed.model.trim() : "";
  if (!parseCursorChatGptWebMode(model)) throw new UnknownCursorModelError(model || "(missing)");
  const input = collectMessages(parsed).trim();
  const previousResponseId = typeof parsed.previous_response_id === "string" ? parsed.previous_response_id : undefined;
  const images = collectImages(parsed);
  const tools = collectTools(parsed);
  const toolResults = collectToolResults(parsed);
  const ignoredToolCount = tools.length;
  const continuationInput = toolResults.length > 0 ? lastUserText(parsed) : input;
  if (!continuationInput && toolResults.length === 0) {
    throw new CursorChatGptWebError("Request has no prompt or messages", { status: 400, code: "empty_input" });
  }
  return {
    model,
    input: continuationInput || input,
    ...(images.length > 0 ? { images } : {}),
    ...(previousResponseId ? { previousResponseId } : {}),
    stream: parsed.stream === true,
    abortSignal,
    ignoredToolCount,
    ...(tools.length > 0 ? { tools } : {}),
    ...(toolResults.length > 0 ? { toolResults } : {}),
  };
}

function errorPayload(error: unknown) {
  if (isCursorChatGptWebError(error)) {
    return {
      error: {
        message: error.message,
        type: error.code === "chatgpt_web_tab_limit" ? "rate_limit_error" : "invalid_request_error",
        code: error.code,
      },
    };
  }
  return {
    error: {
      message: error instanceof Error ? error.message : String(error),
      type: "server_error",
      code: "chatgpt_web_error",
    },
  };
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function captureRequest(url: URL, body: unknown): void {
  const dir = process.env.CURSOR_CHATGPT_WEB_CAPTURE_DIR?.trim();
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  writeFileSync(join(dir, `${stamp}${url.pathname.replaceAll("/", "_")}.json`), `${JSON.stringify({
    capturedAt: new Date().toISOString(),
    method: "POST",
    path: url.pathname,
    body,
  }, null, 2)}\n`);
}

function jobIdFromResponseId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/^chatcmpl-/, "");
}

async function runTurn(
  turn: CursorTurn,
  onTextDelta?: (text: string) => void,
): Promise<SpecialistTurnResult> {
  const runtime = getCursorSpecialistRuntime();
  const jobs = runtime.status().jobs;
  const previousId = jobIdFromResponseId(turn.previousResponseId);
  const awaiting = previousId
    ? jobs.find(job => job.jobId === previousId && job.status === "awaiting_tools")
    : turn.toolResults?.length
      ? jobs.filter(job => job.status === "awaiting_tools")
      : [];
  const continuationJob = Array.isArray(awaiting)
    ? awaiting.length === 1 ? awaiting[0] : undefined
    : awaiting;

  return await runtime.turn({
    prompt: turn.input,
    mode: turn.model,
    ...(continuationJob
      ? { jobId: continuationJob.jobId }
      : previousId
        ? { threadId: previousId }
        : {}),
    ...(turn.images ? { images: turn.images } : {}),
    ...(turn.tools ? { tools: turn.tools } : {}),
    ...(turn.toolResults ? { toolResults: turn.toolResults } : {}),
    ...(onTextDelta ? { onTextDelta } : {}),
  });
}

function openaiToolCalls(calls: SpecialistToolCall[]) {
  return calls.map(call => ({
    id: call.id,
    type: "function" as const,
    function: {
      name: call.name,
      arguments: JSON.stringify(call.arguments),
    },
  }));
}

function completionId(result: SpecialistTurnResult): string {
  return result.threadId || result.jobId;
}

function streamChatCompletions(turn: CursorTurn): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (payload: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      try {
        let id = "chatcmpl-pending";
        send({
          id,
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
        });
        const result = await runTurn(turn, text => {
          send({
            id,
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
          });
        });
        id = `chatcmpl-${completionId(result)}`;
        send({
          id,
          object: "chat.completion.chunk",
          choices: [{
            index: 0,
            delta: result.awaitingTools
              ? { tool_calls: openaiToolCalls(result.toolCalls) }
              : {},
            finish_reason: result.awaitingTools ? "tool_calls" : "stop",
          }],
        });
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (error) {
        send(errorPayload(error));
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
    },
  });
}

export async function handleCursorProtocolRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
    const status = getCursorSpecialistRuntime().status();
    const models = availableCursorChatGptWebRoutes(status.capabilities).map(route => ({
      id: route.cursorId,
      object: "model",
      owned_by: "cursor-chatgpt-web",
      display_name: route.displayName,
    }));
    return jsonResponse(200, { object: "list", data: models });
  }

  if (req.method !== "POST") {
    return jsonResponse(405, { error: { message: "Method not allowed", type: "invalid_request_error", code: "method_not_allowed" } });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { error: { message: "Invalid JSON", type: "invalid_request_error", code: "invalid_json" } });
  }
  captureRequest(url, body);

  try {
    const turn = parseCursorHttpBody(body, req.signal);
    if (url.pathname.endsWith("/responses")) {
      const result = await runTurn(turn);
      return jsonResponse(200, {
        id: result.jobId,
        object: "response",
        model: result.modelId,
        status: result.awaitingTools ? "incomplete" : "completed",
        output: result.awaitingTools
          ? result.toolCalls.map(call => ({
              type: "function_call",
              call_id: call.id,
              name: call.name,
              arguments: JSON.stringify(call.arguments),
            }))
          : [{ type: "message", role: "assistant", content: [{ type: "output_text", text: result.answer }] }],
      });
    }
    if (turn.stream) return streamChatCompletions(turn);
    const result = await runTurn(turn);
    return jsonResponse(200, {
      id: `chatcmpl-${result.jobId}`,
      object: "chat.completion",
      model: result.modelId,
      choices: [{
        index: 0,
        message: result.awaitingTools
          ? { role: "assistant", content: result.answer || null, tool_calls: openaiToolCalls(result.toolCalls) }
          : { role: "assistant", content: result.answer },
        finish_reason: result.awaitingTools ? "tool_calls" : "stop",
      }],
    });
  } catch (error) {
    const payload = errorPayload(error);
    const status = isCursorChatGptWebError(error) ? error.status : 500;
    return jsonResponse(status, payload);
  }
}

export function startCursorProtocolServer(options: { host?: string; port?: number } = {}): { port: number; stop: () => void } {
  const hostname = options.host ?? "127.0.0.1";
  const server = Bun.serve({
    hostname,
    port: options.port ?? 17842,
    fetch: handleCursorProtocolRequest,
  });
  return {
    port: server.port ?? options.port ?? 17842,
    stop: () => server.stop(true),
  };
}
