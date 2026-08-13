export interface SpecialistToolSpec {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface SpecialistToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface SpecialistToolResult {
  id?: string;
  name?: string;
  content: string;
  isError?: boolean;
}

export const DEFAULT_CURSOR_TOOLS: readonly SpecialistToolSpec[] = [
  { name: "Read", description: "Read a file from the Cursor workspace" },
  { name: "Grep", description: "Search file contents in the workspace" },
  { name: "Glob", description: "Find files by name pattern" },
  { name: "SemanticSearch", description: "Semantic code search over the workspace" },
  { name: "Shell", description: "Run a command in the workspace" },
  { name: "ApplyPatch", description: "Apply a file patch. Cursor must still run tests." },
];

const FENCE_RE = /```(?:json)?\s*([\s\S]*?)```/gi;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function asArguments(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    const parsed = parseJson(value);
    const object = record(parsed);
    if (object) return object;
    return { value };
  }
  return record(value) ?? {};
}

function normalizeToolCalls(value: unknown): SpecialistToolCall[] | undefined {
  const object = record(value);
  const list = Array.isArray(value)
    ? value
    : Array.isArray(object?.tool_calls)
      ? object.tool_calls
      : Array.isArray(object?.toolCalls)
        ? object.toolCalls
        : undefined;
  if (!list || list.length === 0) return undefined;

  const calls: SpecialistToolCall[] = [];
  for (const [index, item] of list.entries()) {
    const entry = record(item);
    if (!entry) return undefined;
    const fn = record(entry.function);
    const name = typeof entry.name === "string"
      ? entry.name
      : typeof fn?.name === "string"
        ? fn.name
        : undefined;
    if (!name?.trim()) return undefined;
    const args = entry.arguments ?? entry.args ?? fn?.arguments;
    const id = typeof entry.id === "string" && entry.id.trim()
      ? entry.id.trim()
      : `call_${index + 1}`;
    calls.push({
      id,
      name: name.trim(),
      arguments: asArguments(args),
    });
  }
  return calls;
}

/**
 * GPT Web cannot run Cursor tools. It may propose them as a JSON `tool_calls` object.
 * Prose reviews that happen to contain JSON examples are ignored unless they use that key.
 */
export function parseToolCalls(text: string): SpecialistToolCall[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const direct = normalizeToolCalls(parseJson(trimmed));
  if (direct) return direct;

  const fromFences: SpecialistToolCall[] = [];
  for (const match of trimmed.matchAll(FENCE_RE)) {
    const parsed = normalizeToolCalls(parseJson(match[1] ?? ""));
    if (parsed) fromFences.push(...parsed);
  }
  if (fromFences.length > 0) return fromFences;
  return [];
}

export function stripToolCallJson(text: string): string {
  const calls = parseToolCalls(text);
  if (calls.length === 0) return text.trim();
  const remainder = text.replace(FENCE_RE, "").trim();
  if (normalizeToolCalls(parseJson(remainder))) return "";
  return remainder;
}

export function formatToolResults(results: readonly SpecialistToolResult[]): string {
  return results.map((result, index) => {
    const id = result.id?.trim() || `result_${index + 1}`;
    const name = result.name?.trim();
    const header = name ? `${id} ${name}` : id;
    const body = result.content.trim() || "(empty)";
    const error = result.isError ? " [error]" : "";
    return `- ${header}${error}:\n${body}`;
  }).join("\n\n");
}

export function toolProtocolSection(tools: readonly SpecialistToolSpec[] | undefined): string {
  const list = (tools && tools.length > 0 ? tools : DEFAULT_CURSOR_TOOLS)
    .map(tool => {
      const description = tool.description?.trim();
      return description ? `- ${tool.name}: ${description}` : `- ${tool.name}`;
    })
    .join("\n");

  return [
    "TOOL PROTOCOL",
    "You cannot inspect the repo, run commands, or apply patches yourself.",
    "If you need Cursor to run a tool, reply with ONLY this JSON (optionally in a json fence):",
    '{"tool_calls":[{"id":"call_1","name":"Read","arguments":{"path":"relative/path"}}]}',
    "Do not claim you ran the tool. Wait for TOOL RESULTS in the next user message in this same Temporary Chat.",
    "If you do not need a tool, return the final review with no tool_calls JSON.",
    "",
    "Available Cursor tools:",
    list,
  ].join("\n");
}

export function toolResultsSection(results: readonly SpecialistToolResult[] | undefined): string | undefined {
  if (!results || results.length === 0) return undefined;
  return [
    "TOOL RESULTS",
    "Cursor executed these tools. Use the evidence. If you need another tool, emit tool_calls JSON again. Otherwise return the final review.",
    formatToolResults(results),
  ].join("\n");
}
