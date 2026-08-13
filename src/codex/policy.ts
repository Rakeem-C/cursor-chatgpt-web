import {
  CURSOR_GPT_WEB_AUTONOMY_AVOID,
  CURSOR_GPT_WEB_AUTONOMY_WHEN,
} from "../cursor/policy";

export const CODEX_GPT_WEB_AUTONOMY_AVOID = CURSOR_GPT_WEB_AUTONOMY_AVOID.map(item =>
  item === "tasks Cursor can solve confidently itself"
    ? "tasks Codex can solve confidently itself"
    : item,
);
export const CODEX_GPT_WEB_AGENT_NAME = "chatgpt-web";
export const CODEX_GPT_WEB_MCP_NAME = "chatgpt-web";
export const CODEX_GPT_WEB_SKILL_NAME = "gpt-web-use";
export const CODEX_GPT_WEB_STARTUP_TIMEOUT_SEC = 30;

export function codexGptWebSkillMarkdown(): string {
  return `---
name: ${CODEX_GPT_WEB_SKILL_NAME}
description: Delegate hard reasoning to ChatGPT Web via MCP chatgpt_web_turn / chatgpt_web_batch (GPT-5.6 Sol High). Codex executes only bounded local blockers. Use when architecture is ambiguous, root cause is hard, or an independent review is needed.
---

# GPT Web via MCP

GPT Web owns web-capable work in a ChatGPT Temporary Chat. Codex is the coordinator: it calls MCP, executes local blockers, and verifies. Do not take over web-capable work merely because it is long-running.

## Call as a specialist

\`\`\`text
chatgpt_web_turn({
  mode: "high",
  prompt: "<focused envelope: task, goal, relevant code, constraints, deliverable>"
})
\`\`\`

Default: \`chatgpt-web-high\` → GPT-5.6 Sol → High (slider index 2). The selected mode is authoritative; do not silently swap models.

For independent parallel reviews (max 5):

\`\`\`text
chatgpt_web_batch({
  mode: "high",
  tasks: [
    { id: "architecture", prompt: "Review architecture." },
    { id: "tests", prompt: "Analyze failing tests." }
  ]
})
\`\`\`

## Call as a subagent

Spawn the \`${CODEX_GPT_WEB_AGENT_NAME}\` custom agent. It is a thin policy wrapper. The child still calls \`chatgpt_web_turn\`; it is not ChatGPT itself and must not set \`openai_base_url\` or Override OpenAI Base URL.

## Local blockers only

Keep Read, Search, Shell, ApplyPatch, git, and tests on Codex. If a turn returns \`awaitingTools\`, run those \`toolCalls\`, then continue with the same \`jobId\` and \`toolResults\`.

Fall back to local tools only for a concrete limit GPT Web cannot cross: repo edits, shell, tests, secrets, or OS/service work.

## Fail closed

- Max 5 live browser sessions. A sixth fails with \`chatgpt_web_tab_limit\`.
- Unknown models are rejected. Nothing is proxied to OpenAI.
- Extra High / Pro fail if the account cannot select them.
- Missing High slider is an error, not Instant fallback.

## Do not

${CODEX_GPT_WEB_AUTONOMY_AVOID.map(item => `- ${item}`).join("\n")}
- Set \`openai_base_url\` or Override OpenAI Base URL as the GPT Web path
- Treat \`cursor-chatgpt-web serve\` / \`mcp-codex\` as the required Codex path
- Raise the 5-tab cap
- Pretend a Codex child model is ChatGPT
`;
}

export function codexGptWebSkillYaml(): string {
  return `interface:
  display_name: "GPT Web"
  short_description: "Delegate to ChatGPT Web via MCP chatgpt_web_turn"
  default_prompt: "Call GPT Web High via chatgpt_web_turn for this task. Execute only bounded local blockers (Read, patch, test, git). Do not set openai_base_url."
`;
}

export function codexGptWebAgentToml(): string {
  const instructions = [
    "You are a thin Codex policy wrapper for GPT Web, not ChatGPT itself.",
    "Call MCP chatgpt_web_turn / chatgpt_web_batch. Default mode is high (chatgpt-web-high → GPT-5.6 Sol High, slider index 2).",
    "The selected mode is authoritative; do not silently swap models or set openai_base_url / Override OpenAI Base URL.",
    "Omit threadId for a fresh Temporary Chat per independent job. Pass threadId only to resume an explicit specialist thread.",
    "Use chatgpt_web_batch for independent parallel reviews (max 5). A sixth concurrent session fails with chatgpt_web_tab_limit.",
    "GPT Web owns web-capable work. You keep Read, Search, Shell, ApplyPatch, git, and tests.",
    "If chatgpt_web_turn returns awaitingTools, execute those toolCalls yourself, then call chatgpt_web_turn again with the same jobId and toolResults.",
    `Call GPT Web High when: ${CURSOR_GPT_WEB_AUTONOMY_WHEN.join("; ")}.`,
    `Do not use GPT Web for: ${CODEX_GPT_WEB_AUTONOMY_AVOID.join("; ")}.`,
  ].join("\n");
  return `name = ${JSON.stringify(CODEX_GPT_WEB_AGENT_NAME)}
description = "Thin Codex policy wrapper that calls GPT Web MCP (chatgpt_web_turn / chatgpt_web_batch). Default GPT-5.6 Sol High. The child still calls GPT Web; it is not ChatGPT itself."
sandbox_mode = "workspace-write"
developer_instructions = ${tomlMultiline(instructions)}
`;
}

function tomlMultiline(value: string): string {
  return `"""\n${value.replace(/\\/g, "\\\\").replace(/"""/g, '\\"""')}\n"""`;
}
