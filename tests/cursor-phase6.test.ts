import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shouldRetainManagedBrowserSession } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptWebTabLimitError } from "../src/cursor/errors";
import { reviewCapturedFixtures } from "../src/cursor/fixtures/review";
import { compileDelegationEnvelope } from "../src/cursor/delegation-compiler";
import { TaskSessionManager, type BrowserTurnRunner } from "../src/cursor/task-session";
import { parseToolCalls, stripToolCallJson } from "../src/cursor/tool-protocol";

const plus = { solAvailable: true, proAvailable: false };

function fakeRunner(options?: {
  delayMs?: number;
  answers?: string[];
}): BrowserTurnRunner & { prompts: string[]; holdReleased: string[] } {
  const prompts: string[] = [];
  const holdReleased: string[] = [];
  let index = 0;
  return {
    prompts,
    holdReleased,
    async run(input) {
      prompts.push(input.prompt);
      if (options?.delayMs) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, options.delayMs);
          input.abortSignal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new DOMException("ChatGPT web turn aborted", "AbortError"));
          }, { once: true });
        });
      }
      const scripted = options?.answers?.[index++];
      if (scripted) return { answer: scripted };
      return { answer: "final review without tools" };
    },
    async releaseHold(jobId) {
      holdReleased.push(jobId);
    },
  };
}

describe("Phase 6 GPT Web tool roundtrips", () => {
  test("parses fenced tool_calls JSON and ignores ordinary review JSON", () => {
    const calls = parseToolCalls(`
Need a file.

\`\`\`json
{"tool_calls":[{"id":"call_1","name":"Read","arguments":{"path":"src/cli.ts"}}]}
\`\`\`
`);
    expect(calls).toEqual([{ id: "call_1", name: "Read", arguments: { path: "src/cli.ts" } }]);
    expect(parseToolCalls('{"rootCause":"missing evidence","fix":"add a test"}')).toEqual([]);
    expect(stripToolCallJson('intro\n```json\n{"tool_calls":[{"id":"call_1","name":"Read","arguments":{}}]}\n```\n')).toBe("intro");
  });

  test("the first envelope teaches the tool protocol without claiming Cursor ran anything", () => {
    const compiled = compileDelegationEnvelope({
      prompt: "Review booking confirmation.",
      mode: "high",
      modelId: "chatgpt-web-high",
      displayName: "ChatGPT Web — High",
    });
    expect(compiled.text).toContain("TOOL PROTOCOL");
    expect(compiled.text).toContain("You cannot inspect the repo");
    expect(compiled.text).toContain('"tool_calls"');
  });

  test("tool calls keep the tab leased until results return on the same job", async () => {
    const runner = fakeRunner({
      answers: [
        '```json\n{"tool_calls":[{"id":"call_1","name":"Read","arguments":{"path":"lib/foo.ts"}}]}\n```',
        "After the file, the root cause is missing evidence.",
      ],
    });
    const manager = new TaskSessionManager({ capabilities: plus, runner });
    const first = await manager.turn({ prompt: "Review confirmation.", jobId: "job-tools" });
    expect(first.awaitingTools).toBe(true);
    expect(first.toolCalls[0]?.name).toBe("Read");
    expect(manager.status().pool.active).toBe(1);
    expect(manager.status().jobs[0]?.status).toBe("awaiting_tools");
    expect(runner.holdReleased).toEqual([]);

    const second = await manager.turn({
      jobId: "job-tools",
      toolResults: [{ id: "call_1", name: "Read", content: "export function confirm() {}" }],
    });
    expect(second.awaitingTools).toBe(false);
    expect(second.answer).toContain("missing evidence");
    expect(second.reusedThread).toBe(true);
    expect(runner.prompts[1]).toContain("TOOL RESULTS");
    expect(runner.prompts[1]).toContain("export function confirm()");
    expect(manager.status().pool.active).toBe(0);
    expect(runner.holdReleased).toEqual(["job-tools"]);
  });

  test("a sixth concurrent job still fails while five jobs await tools", async () => {
    const runner = fakeRunner({
      answers: Array.from({ length: 6 }, () => '{"tool_calls":[{"id":"call_1","name":"Read","arguments":{"path":"a.ts"}}]}'),
    });
    const manager = new TaskSessionManager({ capabilities: plus, runner });
    for (let index = 0; index < 5; index += 1) {
      const result = await manager.turn({ prompt: `job ${index}`, jobId: `held-${index}` });
      expect(result.awaitingTools).toBe(true);
    }
    expect(manager.status().pool.active).toBe(5);
    await expect(manager.turn({ prompt: "sixth" })).rejects.toBeInstanceOf(ChatGptWebTabLimitError);
  });

  test("cancel releases a job that is waiting for tool results", async () => {
    const runner = fakeRunner({
      answers: ['{"tool_calls":[{"id":"call_1","name":"Shell","arguments":{"command":"ls"}}]}'],
    });
    const manager = new TaskSessionManager({ capabilities: plus, runner });
    await manager.turn({ prompt: "inspect", jobId: "job-cancel" });
    expect(manager.status().pool.active).toBe(1);
    expect(manager.cancel({ jobId: "job-cancel" }).cancelled).toEqual(["job-cancel"]);
    expect(manager.status().pool.active).toBe(0);
    expect(runner.holdReleased).toEqual(["job-cancel"]);
  });

  test("Codex turns never retain a managed page; Cursor holds only when asked", () => {
    expect(shouldRetainManagedBrowserSession({}, "managed-chrome")).toBe(false);
    expect(shouldRetainManagedBrowserSession({ sessionHoldKey: "job-1" }, "managed-chrome")).toBe(false);
    expect(shouldRetainManagedBrowserSession({
      sessionHoldKey: "job-1",
      keepSessionHold: true,
    }, "launcher")).toBe(false);
    expect(shouldRetainManagedBrowserSession({
      sessionHoldKey: "job-1",
      keepSessionHold: true,
    }, "managed-chrome")).toBe(true);
  });
});

describe("Phase 0 fixture gate", () => {
  test("picker and native Task stay experimental without captured Cursor traffic", () => {
    const dir = mkdtempSync(join(tmpdir(), "cursor-chatgpt-web-fixtures-"));
    try {
      const review = reviewCapturedFixtures(dir);
      expect(review.pickerMode).toBe("experimental");
      expect(review.nativeTaskMode).toBe("probe_only");
      expect(review.pickerSupported).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a captured chatgpt-web-high Chat Completions request can mark the picker supported", () => {
    const dir = mkdtempSync(join(tmpdir(), "cursor-chatgpt-web-fixtures-"));
    try {
      writeFileSync(join(dir, "ask_v1_chat_completions.json"), `${JSON.stringify({
        path: "/v1/chat/completions",
        body: { model: "chatgpt-web-high", messages: [{ role: "user", content: "hi" }] },
      }, null, 2)}\n`);
      const review = reviewCapturedFixtures(dir);
      expect(review.pickerSupported).toBe(true);
      expect(review.pickerMode).toBe("supported");
      expect(review.nativeTaskMode).toBe("probe_only");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("native Task stays probe-only unless the capture mentions the custom child model", () => {
    const dir = mkdtempSync(join(tmpdir(), "cursor-chatgpt-web-fixtures-"));
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "subagent.json"), `${JSON.stringify({
        path: "/v1/chat/completions",
        body: {
          model: "chatgpt-web-high",
          messages: [{ role: "user", content: "Task(model=chatgpt-web-high) review this." }],
        },
      }, null, 2)}\n`);
      const review = reviewCapturedFixtures(dir);
      expect(review.nativeTaskSupported).toBe(true);
      expect(review.nativeTaskMode).toBe("supported");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
