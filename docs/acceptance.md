# Acceptance tests

These are the revised critical scenarios. Automated coverage lives under `tests/cursor-*.test.ts` and `tests/cli.test.ts`. Live ChatGPT/Cursor rows stay manual.

| Scenario | Expected | Coverage |
| --- | --- | --- |
| Parent asks GPT Web for review | one new Temporary Chat | `tests/cursor-specialist.test.ts` fresh envelope |
| Same delegated job continues | same Temporary Chat / tab | TabPool same `jobId` reuses slot; tool roundtrips keep the lease |
| GPT Web asks for a Cursor tool | `awaitingTools` + `toolCalls`; tab held | `tests/cursor-phase6.test.ts` |
| Parent returns tool results | same job, same Temporary Chat | continuation envelope + simulated HTTP test |
| New delegated job | new Temporary Chat | independent jobs do not share history |
| Explicit same threadId | persistent specialist | thread history replayed after tab release |
| Two independent tasks | two isolated chats | separate threadIds |
| Five parallel tasks | five browser sessions | `chatgpt_web_batch` |
| Sixth task | explicit 429 `chatgpt_web_tab_limit` | specialist + batch tests |
| Task completes | browser slot becomes reusable | pool.active returns to 0 |
| GPT Web High selected | visible High mode, slider index 2 | model contract + specialist default |
| Slider missing | fail closed | `tests/browser-worker-contract.test.ts` |
| Unknown model reaches daemon | reject | protocol + specialist unknown-model tests |
| Cursor cancels | browser task stops | cancel releases tab |
| GPT Web returns analysis | parent can continue working | turn result includes `answer` |
| Built-in Cursor model selected | never routed to GPT Web | `gpt-5.5` / `composer-2.5` rejected |
| Native subagent unsupported | MCP still functions | installer/agent policy; MCP tools independent of Task() |
| Browser UI drifts | explicit diagnostic failure | worker throws on missing slider/index |
| Plus cannot select Extra High/Pro | fail closed | specialist capability test |
| Luna-only cannot select High | fail closed | specialist Luna test |
| HTTP images parsed | forwarded to the worker | protocol image test |
| HTTP tools | forwarded as GPT Web proposals; not executed by this daemon | protocol tool_calls test; `ignoredToolCount` |
| Installer writes MCP without clobbering | merge + uninstall | installer test |
| Codex MCP installer writes TOML without openai_base_url | merge + uninstall | `tests/codex-mcp-installer.test.ts` |
| Simulated High smoke | `test-gpt-web --simulate` | CLI test |

Live proof still required on a real machine:

1. Sign in to ChatGPT once through the launcher.
2. `cursor-chatgpt-web setup --browser-only` now writes Cursor MCP and Codex MCP; restart Cursor and Codex.
3. Parent (Grok / Claude / Composer) calls `chatgpt_web_turn` with mode `high`.
4. A Temporary Chat opens with High selected.
5. `probe --checklist` and `probe-subagent` against the installed Cursor build before calling the picker or native Task supported.
6. If GPT Web returns `awaitingTools`, the parent must execute those tools and continue with the same `jobId`.
