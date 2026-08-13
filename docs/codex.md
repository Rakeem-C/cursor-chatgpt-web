# Codex GPT Web

Codex should call GPT Web the same way Cursor does: MCP `chatgpt_web_turn` / `chatgpt_web_batch` against `cursor-chatgpt-web cursor-mcp`. Default is GPT-5.6 Sol High (slider index 2). GPT Web owns web-capable work in a ChatGPT Temporary Chat. Codex keeps Read, patch, test, git, and other local tools for concrete blockers only.

This is **not** Override OpenAI Base URL / `openai_base_url`. That BYOK Responses proxy remains optional upstream (`serve`, `mcp-codex`, `route connect`) and is not the supported Codex path in this fork.

```text
Codex parent (gpt-5.6-terra or similar)
│
├─ specialist: MCP chatgpt_web_turn / chatgpt_web_batch
└─ optional subagent: custom agent `chatgpt-web`
      (thin policy wrapper; child still calls MCP)
                 ▼
cursor-chatgpt-web cursor-mcp
                 ▼
        ChatGPT Temporary Chat
        GPT-5.6 Sol High
```

## Install

```bash
bun run src/cli.ts setup --browser-only --acknowledge-unofficial
# or, if login already works:
bun run src/cli.ts install-codex
```

`install-codex` writes, without touching unrelated Codex config:

- `[mcp_servers.chatgpt-web]` in `~/.codex/config.toml` → bun + `src/cli.ts cursor-mcp`
- `~/.codex/agents/chatgpt-web.toml` (subagent policy)
- `~/.codex/skills/gpt-web-use/SKILL.md` (parent policy)

It never sets `openai_base_url`. Restart Codex after install so the MCP server loads.

Windows uses the same browser-only login/daemon as Cursor. Do not install a second launchd/OS service.

## Invoke

**Specialist.** Compile a focused envelope and call:

```text
chatgpt_web_turn({
  mode: "high",
  prompt: "<task, goal, relevant code, constraints, deliverable>"
})
```

**Subagent.** Spawn the `chatgpt-web` custom agent. The child still calls GPT Web MCP. It must not pretend to be ChatGPT or route Codex through a custom OpenAI base URL.

If a turn returns `awaitingTools`, Codex executes those `toolCalls` and continues with the same `jobId` and `toolResults`.

## When to stay local

Use local Codex tools when GPT Web hits a real limit: repository edits, shell, tests, secrets, or OS/service work. Do not take over web-capable reasoning just because the job is long-running.

## Fail closed

- Max 5 live browser sessions per MCP process. A sixth fails with `chatgpt_web_tab_limit`.
- Unknown models are rejected.
- Extra High / Pro fail on Plus if the account cannot select them.
- Missing High slider is an error, not Instant fallback.

`uninstall-codex` removes the MCP table, agent, and skill files this installer wrote. It does not restore or write `openai_base_url`.
