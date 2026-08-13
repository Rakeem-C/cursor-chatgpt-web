# ChatGPT Web for Cursor

Use your ChatGPT Web account from Cursor as a **GPT-5.6 Sol High specialist**.

Cursor stays the parent agent (Grok / Claude / Composer). When a task needs stronger independent reasoning, it delegates through MCP. Each job gets its own ChatGPT Temporary Chat. Up to five specialists can run at once.

This is a Cursor-oriented fork of [miuuyy/codex-chatgpt-web](https://github.com/miuuyy/codex-chatgpt-web). It reuses that project's launcher, login, Temporary Chat worker, High → Sol slider mapping, and five-tab cap. It does **not** live inside Automationation or any other product repo.

The source path requires Bun 1.3.14.

## What V1 feels like

You work in Cursor on Grok (or Claude / Composer):

> Repair the assistant confirmation system and don't regress tenant isolation.

Cursor investigates with its own tools. When the architecture is genuinely hard, it calls:

```text
chatgpt_web_turn({
  mode: "high",
  prompt: "<focused envelope: task, goal, relevant code, constraints, deliverable>"
})
```

GPT-5.6 Sol High runs in a fresh Temporary Chat and returns root cause, risk, a safest fix, and tests. Cursor edits, runs tests, and continues.

For independent parallel review:

```text
chatgpt_web_batch({
  mode: "high",
  tasks: [
    { id: "architecture", prompt: "Review architecture." },
    { id: "tests", prompt: "Analyze failing tests." },
    { id: "security", prompt: "Look for authorization risks." }
  ]
})
```

## Modes

| Path | Status | How |
| --- | --- | --- |
| **MCP specialist** | Supported V1 | Parent agent calls `chatgpt_web_turn` / `chatgpt_web_batch` |
| **Model picker** | Experimental | Custom model `chatgpt-web-high` through a local OpenAI-compatible bridge, only after capturing your Cursor build's traffic |
| **Native `Task(model=chatgpt-web-high)`** | Probe only | Enabled only if Cursor actually honors the custom model |

Default specialist:

`chatgpt-web-high` → GPT-5.6 Sol → High reasoning (slider index 2)

The selected model ID is authoritative. Cursor Fast/Effort must never silently change High into another mode.

## Session rules

- No `threadId` → one job, one Temporary Chat, then the browser slot is released.
- Same in-flight job (cancel, later tool roundtrips) → same Temporary Chat. If GPT Web returns `awaitingTools`, Cursor executes the `toolCalls` and continues with the same `jobId`.
- Explicit `threadId` → persist specialist history across later MCP calls. The physical tab is still recycled; history is replayed into a new Temporary Chat.
- Max **5** live browser sessions. A sixth concurrent job fails with `chatgpt_web_tab_limit` (HTTP 429).
- Cursor owns project memory. GPT Web only sees the compiled envelope for that job.

## Quick start

```bash
git clone https://github.com/Rakeem-C/cursor-chatgpt-web.git cursor-chatgpt-web
cd cursor-chatgpt-web
bun install --frozen-lockfile
bun run src/cli.ts setup --browser-only --acknowledge-unofficial
```

`setup --browser-only` writes `~/.cursor/mcp.json` unless you pass `--skip-cursor-install`. Then restart Cursor. The parent agent should see MCP tools:

- `chatgpt_web_turn`
- `chatgpt_web_batch`
- `chatgpt_web_status`
- `chatgpt_web_cancel`

The Cursor specialist server is `cursor-chatgpt-web cursor-mcp`. The original ChatGPT-side Codex connector remains `cursor-chatgpt-web mcp`.

Sign-in still uses the upstream launcher/browser flow. Being logged in at https://chatgpt.com/ in everyday Chrome is not enough: `setup` / `login` opens a dedicated Chrome window, copies allowlisted ChatGPT cookies into a private profile, then closes that window. Use passkeys or the same Google account in that window. Temporary Chat is a ChatGPT privacy mode, not anonymity. This project is unofficial.

### Simulated MCP (no ChatGPT login)

```bash
CURSOR_CHATGPT_WEB_SIMULATE=1 bun run src/cli.ts cursor-mcp
```

Use this only to verify Cursor can call the tools. It does not contact ChatGPT.

## Autonomy policy

Use GPT Web High when:

- architecture is ambiguous
- root cause is difficult
- several plausible implementations exist
- security or authorization needs independent review
- a large refactor needs a second opinion
- repeated tests are failing without an obvious cause

Do not use GPT Web for trivial edits, formatting, simple searches, or one-line fixes.

`install-cursor` writes that policy to `~/.cursor/agents/chatgpt-web.md`.

## Experimental picker

Do not enable Override OpenAI Base URL until you capture real traffic from your installed Cursor:

```bash
bun run probe
```

Point Cursor at `http://127.0.0.1:17843/v1`, send Ask and Agent prompts, then inspect `src/cursor/fixtures/captured/`. If the shapes are safe, `cursor-serve` exposes `/v1/models`, `/v1/chat/completions`, and `/v1/responses` for unique IDs only (`chatgpt-web-high`, never `gpt-5.5`).

## Commands

```text
cursor-chatgpt-web setup --browser-only
cursor-chatgpt-web login
cursor-chatgpt-web doctor
cursor-chatgpt-web cursor-mcp
cursor-chatgpt-web install-cursor
cursor-chatgpt-web cursor-status
cursor-chatgpt-web test-gpt-web --simulate
cursor-chatgpt-web cursor-serve
cursor-chatgpt-web probe --checklist
cursor-chatgpt-web probe-subagent
cursor-chatgpt-web mcp          # original Codex Native connector
```

## Development

```bash
bun run app
bun test tests/*.test.ts
bun run typecheck
bun run verify
```

- [Cursor architecture](docs/cursor.md)
- [Acceptance tests](docs/acceptance.md)
- [Upstream Codex architecture](docs/architecture.md)
- [Security model](docs/security-model.md)

## Disclaimer

Independent software, not affiliated with OpenAI or Cursor. Use only with your own ChatGPT account and in accordance with applicable terms. It does not bypass authentication or usage limits. UI drift fails closed.
