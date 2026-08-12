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
  ├─ CapabilityDetector
  ├─ BrowserWorker (upstream Temporary Chat + High slider)
  └─ CursorProtocolAdapter (experimental)
                 ▼
        ChatGPT Temporary Chat
        GPT-5.6 Sol High
```

## Supported V1

The parent compiles a focused envelope and calls MCP. GPT Web reasons. Cursor keeps Read, Search, Shell, ApplyPatch, git, and tests.

`chatgpt-web-high` is the default. The ID locks ChatGPT's reasoning slider to High (index 2). Fast/Effort from Cursor cannot change it.

## Isolation

| Event | Temporary Chat |
| --- | --- |
| New MCP job, no threadId | Fresh chat, released when the job finishes |
| Same in-flight jobId | Reuse the leased tab |
| Explicit threadId | Logical specialist history; physical tab recycled |
| `chatgpt_web_batch` task | Isolated chat per task id |
| Sixth concurrent job | `chatgpt_web_tab_limit` |

## Fail-closed

- Unknown model IDs are rejected. Nothing is proxied to OpenAI.
- Missing High slider / DOM drift is an error, not Instant fallback.
- Built-in Cursor models must never hit this daemon.
- Extra High / Pro fail if the account cannot select them.

## Implementation phases

| Phase | Status | Proof |
| --- | --- | --- |
| 0 Reality probe | Tooling shipped; live Cursor capture is on the user's machine | `cursor-chatgpt-web probe --checklist` |
| 1 MCP specialist | Shipped | `chatgpt_web_turn` / status / cancel + `test-gpt-web --simulate` |
| 2 Isolation + fan-out | Shipped | `chatgpt_web_batch`, TabPool, threadId tests |
| 3 Model picker | Experimental until fixtures exist | `cursor-serve` unique IDs only |
| 4 Native `Task(model=chatgpt-web-high)` | Probe only | MCP remains supported if Cursor pins the child model |
| 5 Installer / launcher | Shipped | `install-cursor`, launcher Cursor MCP row, doctor, test, 0/5 tasks |
| 6 Tool roundtrips | Not in V1 | Parent owns tools |

## Phase 0 probe

`cursor-chatgpt-web probe` captures Ask, Agent, stream, cancel, image, tool, follow-up, and subagent requests from the installed Cursor build. The picker route stays experimental until those fixtures exist.

Native subagent support is enabled only if that probe shows Cursor honors `Task(model=chatgpt-web-high)`.
