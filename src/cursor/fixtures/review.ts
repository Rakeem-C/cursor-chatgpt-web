import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseCursorChatGptWebMode } from "../../chatgpt-web-models";

export type CapturedFixtureKind =
  | "picker_chat_completions"
  | "picker_responses"
  | "models"
  | "native_task"
  | "unknown";

export interface CapturedFixtureSummary {
  file: string;
  kind: CapturedFixtureKind;
  model?: string;
  path?: string;
  chatgptWebModel: boolean;
}

export interface FixtureReview {
  dir: string;
  capturedFiles: number;
  pickerSupported: boolean;
  nativeTaskSupported: boolean;
  pickerMode: "experimental" | "supported";
  nativeTaskMode: "probe_only" | "supported";
  evidence: CapturedFixtureSummary[];
  notes: string[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function capturedModel(body: Record<string, unknown> | undefined): string | undefined {
  if (typeof body?.model === "string" && body.model.trim()) return body.model.trim();
  const nested = record(body?.body);
  if (typeof nested?.model === "string" && nested.model.trim()) return nested.model.trim();
  return undefined;
}

function classify(path: string, body: Record<string, unknown> | undefined): CapturedFixtureKind {
  const model = capturedModel(body);
  const haystack = `${path}\n${JSON.stringify(body ?? {})}`.toLowerCase();
  const looksLikeTask = /task\(model\s*=\s*chatgpt-web-|native.?subagent|subagent.?model/.test(haystack);
  if (looksLikeTask && model && parseCursorChatGptWebMode(model)) return "native_task";
  if (path.includes("/models")) return "models";
  if (path.includes("/responses")) return "picker_responses";
  if (path.includes("/chat/completions") || path.includes("/completions")) return "picker_chat_completions";
  if (model && parseCursorChatGptWebMode(model)) return "picker_chat_completions";
  return "unknown";
}

export function defaultCapturedFixtureDir(): string {
  return resolve(process.env.CURSOR_CHATGPT_WEB_CAPTURE_DIR?.trim() || join(process.cwd(), "src/cursor/fixtures/captured"));
}

/**
 * Picker and native Task stay experimental/probe-only until real Cursor traffic exists.
 * Do not invent request shapes; only captured JSON can flip these gates.
 */
export function reviewCapturedFixtures(dir = defaultCapturedFixtureDir()): FixtureReview {
  const evidence: CapturedFixtureSummary[] = [];
  const notes: string[] = [];
  if (!existsSync(dir)) {
    notes.push(`No captured Cursor traffic at ${dir}. Run: cursor-chatgpt-web probe`);
    return {
      dir,
      capturedFiles: 0,
      pickerSupported: false,
      nativeTaskSupported: false,
      pickerMode: "experimental",
      nativeTaskMode: "probe_only",
      evidence,
      notes,
    };
  }

  const files = readdirSync(dir).filter(name => name.endsWith(".json") && name !== "README.json");
  for (const file of files) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(dir, file), "utf8"));
    } catch {
      notes.push(`${file} is not valid JSON`);
      continue;
    }
    const payload = record(parsed);
    const path = typeof payload?.path === "string" ? payload.path : "";
    const body = record(payload?.body) ?? payload;
    const model = capturedModel(body) ?? capturedModel(payload);
    const kind = classify(path, body);
    evidence.push({
      file,
      kind,
      ...(model ? { model } : {}),
      ...(path ? { path } : {}),
      chatgptWebModel: Boolean(model && parseCursorChatGptWebMode(model)),
    });
  }

  const pickerSupported = evidence.some(item => (
    item.chatgptWebModel
    && (item.kind === "picker_chat_completions" || item.kind === "picker_responses")
  ));
  const nativeTaskSupported = evidence.some(item => item.kind === "native_task" && item.chatgptWebModel);

  if (files.length === 0) {
    notes.push("Capture directory exists but has no Cursor request JSON. Point Cursor at the probe listener first.");
  } else if (!pickerSupported) {
    notes.push("Captured files do not yet prove Cursor sent chatgpt-web-* to /v1/chat/completions or /v1/responses.");
  }
  if (!nativeTaskSupported) {
    notes.push("Native Task(model=chatgpt-web-high) stays probe-only until a captured subagent request honors that model.");
  }

  return {
    dir,
    capturedFiles: files.length,
    pickerSupported,
    nativeTaskSupported,
    pickerMode: pickerSupported ? "supported" : "experimental",
    nativeTaskMode: nativeTaskSupported ? "supported" : "probe_only",
    evidence,
    notes,
  };
}
