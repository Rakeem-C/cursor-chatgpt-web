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
| Named `metadata.role`, no threadId | Logical thread `role:<role>`; physical tab recycled |
| Same in-flight jobId, including tool roundtrips | Reuse the leased tab and held page |
| Explicit threadId | Logical specialist history; physical tab recycled |
| `chatgpt_web_batch` task | Isolated chat per task id |
| Sixth concurrent turn | FIFO queue (unless `queue=false`) |
| Sixth batch task or `queue=false` | `chatgpt_web_tab_limit` |
| Second live job with the same role | `lease_blocked` |

## Supported V2

Named role leases, a FIFO queue when all five tabs are busy, and a tool loop the parent must resume.

- `metadata.role` claims a specialist lease. `threadId` defaults to `role:<role>`.
- A sixth **turn** queues. `chatgpt_web_batch` of 6 and `queue=false` still return `chatgpt_web_tab_limit`.
- `awaitingTools` keeps the tab. `status` exposes `resumeRequired`, `blockedOnParent`, `queue`, `leases`, and spawn UX.
- Envelope compiler redacts secrets, attaches ROLE / ALLOWED / FORBIDDEN paths, and caps size. Tool paths outside the lease fail with `lease_path_denied`.
- Supported spawn is MCP. `Task(subagent_type=chatgpt-web)` is an optional policy wrapper. `Task(model=chatgpt-web-high)` and the picker stay probe-only / experimental. Do not set Override OpenAI Base URL.

## Fail-closed

- Unknown model IDs are rejected. Nothing is proxied to OpenAI.
- Missing High slider / DOM drift is an error, not Instant fallback.
- Built-in Cursor models must never hit this daemon.
- Extra High / Pro fail if the account cannot select them.
- Picker and native `Task(model=chatgpt-web-high)` stay experimental/probe-only until captured fixtures prove the Cursor build.

## Implementation phases

| Phase | Status | Proof |
| --- | --- | --- |
| 0 Reality probe | Tooling shipped; live Cursor capture is on the user's machine | `probe --checklist`, `probe-subagent`, fixture reviewer |
| 1 MCP specialist | Shipped | `chatgpt_web_turn` / status / cancel + `test-gpt-web --simulate` |
| 2 Isolation + fan-out | Shipped | `chatgpt_web_batch`, TabPool, threadId tests |
| 3 Model picker | Experimental until fixtures exist | `cursor-serve` unique IDs only; `reviewCapturedFixtures` |
| 4 Native `Task(model=chatgpt-web-high)` | Probe only | `probe-subagent`; MCP remains supported if Cursor pins the child model |
| 5 Installer / launcher | Shipped | `setup --browser-only` writes Cursor MCP; doctor is Cursor-first |
| 6 Tool roundtrips | Shipped | GPT proposes `tool_calls`; Cursor executes; same `jobId` continues the Temporary Chat |
| V2.1 Named leases + queue | Shipped | `metadata.role`, FIFO sixth turn, `lease_blocked` |
| V2.2 Tool-loop hold | Shipped | `resumeRequired`, `blockedOnParent`, cancel releases queued/held jobs |
| V2.3 Envelope compiler | Shipped | Secret redaction, path lease, 80k cap |
| V2.4 Spawn UX | Shipped | MCP supported; wrapper supported; native Task probe-only; never BYOK override |

## Phase 0 probe

`cursor-chatgpt-web probe` captures Ask, Agent, stream, cancel, image, tool, follow-up, and subagent requests from the installed Cursor build. The picker route stays experimental until those fixtures exist.

`cursor-chatgpt-web probe-subagent` prints the Grok and Composer `Task(model=chatgpt-web-high)` template. Native subagent support is enabled only if that probe shows Cursor honors the custom child model.

## Phase 6 tool roundtrips

GPT Web cannot run Cursor tools. If it needs Read/Grep/Shell/ApplyPatch, it returns `awaitingTools` with `tool_calls` JSON. The parent executes those tools, then calls `chatgpt_web_turn` again with the same `jobId` and `toolResults`. The managed Chrome Temporary Chat is held for that job (Codex turns still open a fresh page every time). If the parent does not resume, `status.blockedOnParent` surfaces the stall; cancel releases the tab.
