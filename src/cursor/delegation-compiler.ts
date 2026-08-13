import type { ChatGptWebPromptImage } from "../adapters/chatgpt-web/prompt";
import type { CursorChatGptWebMode } from "../chatgpt-web-models";
import { redactSecrets } from "./secrets";
import {
  toolProtocolSection,
  toolResultsSection,
  type SpecialistToolResult,
  type SpecialistToolSpec,
} from "./tool-protocol";

export interface DelegationMetadata {
  task?: string;
  goal?: string;
  repo?: string;
  parentModel?: string;
  constraints?: string[];
  deliverable?: string;
  role?: string;
  allowedPaths?: string[];
  forbiddenPaths?: string[];
}

export interface SpecialistImage {
  ref?: string;
  imageUrl: string;
  detail?: string;
}

export interface ThreadMessage {
  role: "user" | "assistant";
  text: string;
  at: number;
}

export interface CompileDelegationInput {
  prompt: string;
  mode: CursorChatGptWebMode;
  modelId: string;
  displayName: string;
  threadId?: string;
  threadHistory?: readonly ThreadMessage[];
  images?: readonly SpecialistImage[];
  metadata?: DelegationMetadata;
  tools?: readonly SpecialistToolSpec[];
  toolResults?: readonly SpecialistToolResult[];
  continuation?: boolean;
}

export interface CompiledDelegation {
  text: string;
  images: ChatGptWebPromptImage[];
}

const MAX_THREAD_HISTORY_MESSAGES = 24;
export const MAX_COMPILED_ENVELOPE_CHARS = 80_000;

function section(title: string, body: string | undefined): string | undefined {
  const trimmed = body?.trim();
  return trimmed ? `${title}\n${redactSecrets(trimmed)}` : undefined;
}

function listSection(title: string, items: string[] | undefined): string | undefined {
  const cleaned = (items ?? []).map(item => item.trim()).filter(Boolean);
  if (cleaned.length === 0) return undefined;
  return `${title}\n${cleaned.map(item => `- ${redactSecrets(item)}`).join("\n")}`;
}

function historySection(history: readonly ThreadMessage[] | undefined): string | undefined {
  if (!history || history.length === 0) return undefined;
  const recent = history.slice(-MAX_THREAD_HISTORY_MESSAGES);
  const lines = recent.map(message => `${message.role.toUpperCase()}:\n${redactSecrets(message.text.trim())}`);
  return `PRIOR SPECIALIST THREAD\nThese messages belong to the explicit threadId the parent asked to resume. They are not Cursor project memory.\n\n${lines.join("\n\n")}`;
}

function capCompiledText(text: string): string {
  if (text.length <= MAX_COMPILED_ENVELOPE_CHARS) return text;
  return `${text.slice(0, MAX_COMPILED_ENVELOPE_CHARS)}\n\n[envelope truncated to ${MAX_COMPILED_ENVELOPE_CHARS} characters]`;
}

/**
 * Cursor remains the canonical project memory. GPT Web receives only the focused
 * envelope for this job, plus explicit thread history when the parent opted in.
 */
export function compileDelegationEnvelope(input: CompileDelegationInput): CompiledDelegation {
  const prompt = redactSecrets(input.prompt.trim());
  const toolResults = toolResultsSection(input.toolResults?.map(result => ({
    ...result,
    content: redactSecrets(result.content),
  })));
  if (!prompt && !toolResults) throw new Error("chatgpt_web_turn requires a non-empty prompt");

  if (input.continuation) {
    const parts = [
      "Continue in this same Temporary Chat. Cursor still owns the repository, filesystem, shell, edits, tests, and approvals.",
      "If you need another Cursor tool, emit tool_calls JSON only. Otherwise return the final review and do not implement.",
      historySection(input.threadHistory),
      toolResults,
      section("FOLLOW-UP", prompt || undefined),
    ].filter((part): part is string => Boolean(part));
    return { text: capCompiledText(parts.join("\n\n")), images: [] };
  }

  const parts = [
    "You are GPT Web, an independent reasoning specialist invoked from Cursor.",
    "Cursor owns the repository, filesystem, shell, edits, tests, and approvals.",
    "Do not claim you inspected, edited, or ran anything unless that evidence is in this envelope.",
    "Return a concrete review: root cause, risk, safest fix, and tests. Do not implement.",
    `Selected ChatGPT mode is authoritative: ${input.displayName} (${input.modelId}). Do not switch modes.`,
    toolProtocolSection(input.tools),
    section("ROLE", input.metadata?.role),
    listSection("ALLOWED PATHS", input.metadata?.allowedPaths),
    listSection("FORBIDDEN PATHS", input.metadata?.forbiddenPaths),
    section("TASK", input.metadata?.task),
    section("GOAL", input.metadata?.goal),
    section("REPO", input.metadata?.repo),
    section("PARENT MODEL", input.metadata?.parentModel),
    listSection("CONSTRAINTS", input.metadata?.constraints),
    section("DELIVERABLE", input.metadata?.deliverable),
    input.threadId ? `THREAD ID\n${input.threadId}` : "THREAD ID\nnone — this is a fresh isolated Temporary Chat for one job.",
    historySection(input.threadHistory),
    section("CURRENT ASSIGNMENT", prompt),
  ].filter((part): part is string => Boolean(part));

  const images = (input.images ?? []).map((image, index) => ({
    ref: image.ref?.trim() || `image-${index + 1}`,
    imageUrl: image.imageUrl,
    ...(image.detail ? { detail: image.detail } : {}),
  }));

  return { text: capCompiledText(parts.join("\n\n")), images };
}
