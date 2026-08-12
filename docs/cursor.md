# Cursor specialist architecture

```text
Cursor Desktop
│
├─ Parent agent (Grok / Claude / Composer)     Optional picker (experimental)
│     MCP chatgpt_web_turn / batch                    HTTP /v1/*
▼                                                     ▼
cursor-chatgpt-web
  ├─ McpServer
  ├─ DelegationCompiler
  ├─ TaskSessionManager
  ├─ TabPool (max 5)
  ├─ BrowserWorker (upstream Temporary Chat + High slider)
  └─ CursorProtocolAdapter (experimental)
                 ▼
        ChatGPT Temporary Chat
        GPT-5.6 Sol High
```

## Supported V1

The parent compiles a focused envelope and calls MCP. GPT Web reasons. Cursor keeps Read, Search, Shell, ApplyPatch, git, and tests.

`chatgpt-web-high` is the default. The ID locks ChatGPT's reasoning slider to High. Fast/Effort from Cursor cannot change it.

## Isolation

| Event | Temporary Chat |
| --- | --- |
| New MCP job, no threadId | Fresh chat, released when the job finishes |
| Explicit threadId | Logical specialist history; physical tab recycled |
| `chatgpt_web_batch` task | Isolated chat per task id |
| Sixth concurrent job | `chatgpt_web_tab_limit` |

## Fail-closed

- Unknown model IDs are rejected. Nothing is proxied to OpenAI.
- Missing High slider / DOM drift is an error, not Instant fallback.
- Built-in Cursor models must never hit this daemon.

## Phase 0 probe

`cursor-chatgpt-web probe` captures Ask, Agent, stream, cancel, image, tool, follow-up, and subagent requests from the installed Cursor build. The picker route stays experimental until those fixtures exist.
