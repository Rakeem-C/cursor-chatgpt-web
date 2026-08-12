export const CURSOR_SUBAGENT_PROBE_PARENTS = ["Grok", "Composer"] as const;

export function printCursorSubagentProbeReport(): string {
  const taskBlock = [
    "Task(",
    '  description="GPT Web High review",',
    '  prompt="Use model chatgpt-web-high. Review the current assignment. Do not switch to a built-in Cursor model. If the child model is not chatgpt-web-high, stop and report the actual model.",',
    '  model="chatgpt-web-high",',
    ")",
  ].join("\n");

  return [
    "Phase 4 — native Task(model=chatgpt-web-high) probe",
    "",
    "Do not assume Cursor honors a custom child model. MCP chatgpt_web_turn remains the supported path.",
    "If the child is pinned to Grok, Claude, Composer, or another built-in model, treat native Task as unsupported.",
    "",
    "Run this from a Grok parent, then from a Composer parent:",
    "",
    taskBlock,
    "",
    "Pass criteria:",
    "1. The child model id is exactly chatgpt-web-high (or another chatgpt-web-* alias you selected).",
    "2. The request is captured by `cursor-chatgpt-web probe` under src/cursor/fixtures/captured/.",
    "3. Built-in models such as gpt-5.5 / composer-2.5 never reach this daemon.",
    "",
    "If any parent fails, keep using MCP. Do not add a compatibility layer that silently swaps models.",
    "",
  ].join("\n");
}
