export const CURSOR_GPT_WEB_SPAWN = {
  mcp: "supported",
  wrapperSubagent: "supported",
  nativeTaskModel: "probe_only",
  picker: "experimental",
} as const;

export type CursorGptWebSpawnPath = keyof typeof CURSOR_GPT_WEB_SPAWN;

export function spawnUxReport(): {
  mcp: "supported";
  wrapperSubagent: "supported";
  nativeTaskModel: "probe_only";
  picker: "experimental";
  notes: string[];
} {
  return {
    ...CURSOR_GPT_WEB_SPAWN,
    notes: [
      "Supported V2 spawn is MCP chatgpt_web_turn / chatgpt_web_batch, optionally wrapped by Task(subagent_type=chatgpt-web).",
      "Task(model=chatgpt-web-high) stays probe-only until a Cursor parent pins that custom child model.",
      "Do not set Override OpenAI Base URL if Cursor already uses OpenAI BYOK. The picker is not required for V2.",
    ],
  };
}
