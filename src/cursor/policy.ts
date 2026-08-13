export const CURSOR_GPT_WEB_AUTONOMY_WHEN = [
  "architecture is ambiguous",
  "root cause is difficult",
  "several plausible implementations exist",
  "security or authorization needs independent review",
  "a large refactor needs a second opinion",
  "repeated tests are failing without an obvious cause",
  "the task benefits from a strong independent reasoning pass",
] as const;

export const CURSOR_GPT_WEB_AUTONOMY_AVOID = [
  "trivial edits",
  "formatting",
  "simple searches",
  "obvious one-line fixes",
  "tasks Cursor can solve confidently itself",
] as const;

export const CURSOR_GPT_WEB_MCP_INSTRUCTIONS = [
  "You are calling GPT Web, an expensive senior specialist on the user's ChatGPT account.",
  "Default mode is high (chatgpt-web-high → GPT-5.6 Sol High, slider index 2). The selected mode is authoritative; do not let Cursor Fast/Effort change it.",
  "Omit threadId for a fresh Temporary Chat per independent job. Pass threadId only to resume an explicit specialist thread.",
  "Set metadata.role for a named lease; threadId defaults to role:<role>. A second live job with the same role fails with lease_blocked.",
  "Use chatgpt_web_batch for independent parallel reviews (max 5). A sixth batch task fails with chatgpt_web_tab_limit. A sixth turn queues unless queue=false.",
  "Cursor keeps Read, Search, Shell, ApplyPatch, git, and tests. GPT Web reasons; you act.",
  "If chatgpt_web_turn returns awaitingTools, execute those toolCalls yourself, then call chatgpt_web_turn again with the same jobId and toolResults to continue the same Temporary Chat.",
  "Supported spawn is MCP, optionally wrapped by Task(subagent_type=chatgpt-web). Do not assume Task(model=chatgpt-web-high) works until a Phase 0 probe proves Cursor honors the custom child model.",
  "Do not set Override OpenAI Base URL if Cursor already uses OpenAI BYOK. The picker is experimental and not required for V2.",
  `Call GPT Web High when: ${CURSOR_GPT_WEB_AUTONOMY_WHEN.join("; ")}.`,
  `Do not use GPT Web for: ${CURSOR_GPT_WEB_AUTONOMY_AVOID.join("; ")}.`,
].join(" ");

export function cursorGptWebRulesMarkdown(): string {
  return `---
description: When to delegate to the ChatGPT Web GPT-5.6 Sol High specialist over MCP
alwaysApply: false
---

# GPT Web specialist

Prefer MCP tools \`chatgpt_web_turn\` and \`chatgpt_web_batch\`. Optional wrapper: \`Task(subagent_type=chatgpt-web)\` still calls MCP. Do not assume \`Task(model=chatgpt-web-high)\` works. Do not set Override OpenAI Base URL.

Call GPT Web High when:

${CURSOR_GPT_WEB_AUTONOMY_WHEN.map(item => `- ${item}`).join("\n")}

Do not use GPT Web for:

${CURSOR_GPT_WEB_AUTONOMY_AVOID.map(item => `- ${item}`).join("\n")}

Delegation rules:

- Compile a focused envelope (task, goal, relevant files/context, constraints, deliverable).
- Set \`metadata.role\` for a named specialist lease. \`threadId\` defaults to \`role:<role>\`.
- Omit \`threadId\` for a fresh Temporary Chat per job when no role is set.
- Pass \`threadId\` only when the user asked to continue a named specialist thread.
- Use \`chatgpt_web_batch\` for independent parallel reviews (max 5). A sixth batch task fails; a sixth turn queues unless \`queue=false\`.
- You keep Read, Search, Shell, ApplyPatch, git, and tests. GPT Web reasons; you act.
- If a turn returns \`awaitingTools\`, run those \`toolCalls\` yourself and call \`chatgpt_web_turn\` again with the same \`jobId\` and \`toolResults\`. That continues the same Temporary Chat.
- Do not set Override OpenAI Base URL. The picker is experimental and not required.
`;
}
