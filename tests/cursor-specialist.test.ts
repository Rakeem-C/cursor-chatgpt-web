import { describe, expect, test } from "bun:test";
import { ChatGptWebTabLimitError, UnknownCursorModelError } from "../src/cursor/errors";
import { compileDelegationEnvelope } from "../src/cursor/delegation-compiler";
import { TabPool } from "../src/cursor/tab-pool";
import { TaskSessionManager, type BrowserTurnRunner } from "../src/cursor/task-session";

const plus = { solAvailable: true, proAvailable: false };
const pro = { solAvailable: true, proAvailable: true };

function fakeRunner(options?: {
  delayMs?: number;
  onStart?: (jobId: string, prompt: string) => void;
}): BrowserTurnRunner & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    async run(input) {
      options?.onStart?.(input.jobId, input.prompt);
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
      const assignment = input.prompt.split("CURRENT ASSIGNMENT\n")[1] ?? input.prompt;
      return { answer: `review:${assignment.trim().slice(0, 80)}` };
    },
  };
}

describe("Cursor GPT Web specialist sessions", () => {
  test("defaults to High / GPT-5.6 Sol and keeps the selected mode authoritative", async () => {
    const runner = fakeRunner();
    const manager = new TaskSessionManager({ capabilities: plus, runner });
    const result = await manager.turn({ prompt: "Review booking confirmation." });
    expect(result.mode).toBe("high");
    expect(result.modelId).toBe("chatgpt-web-high");
    expect(result.backendModel).toBe("gpt-5.6-sol");
    expect(result.adapterEffort).toBe("high");
    expect(result.displayName).toBe("ChatGPT Web — High");
    expect(result.reusedThread).toBe(false);
    expect(runner.prompts[0]).toContain("Selected ChatGPT mode is authoritative: ChatGPT Web — High");
  });

  test("rejects unknown models instead of routing them to GPT Web", async () => {
    const manager = new TaskSessionManager({ capabilities: plus, runner: fakeRunner() });
    await expect(manager.turn({ prompt: "hi", mode: "gpt-5.5" })).rejects.toBeInstanceOf(UnknownCursorModelError);
    await expect(manager.turn({ prompt: "hi", mode: "composer-2.5" })).rejects.toBeInstanceOf(UnknownCursorModelError);
  });

  test("a new delegated job gets a fresh Temporary Chat envelope", async () => {
    const runner = fakeRunner();
    const manager = new TaskSessionManager({ capabilities: plus, runner });
    const first = await manager.turn({ prompt: "Review booking architecture." });
    const second = await manager.turn({ prompt: "Investigate assistant authorization." });
    expect(first.jobId).not.toBe(second.jobId);
    expect(first.tabSlot).not.toBe(second.tabSlot);
    expect(runner.prompts[1]).not.toContain("Review booking architecture.");
    expect(runner.prompts[1]).toContain("Investigate assistant authorization.");
    expect(runner.prompts[1]).toContain("fresh isolated Temporary Chat");
  });

  test("explicit threadId resumes specialist history after the tab is released", async () => {
    const runner = fakeRunner();
    const manager = new TaskSessionManager({ capabilities: plus, runner });
    const first = await manager.turn({
      prompt: "Review the current architecture.",
      threadId: "assistant-reliability-review",
    });
    expect(manager.status().pool.active).toBe(0);
    const second = await manager.turn({
      prompt: "Here are the new test results. Reassess.",
      threadId: "assistant-reliability-review",
    });
    expect(first.reusedThread).toBe(false);
    expect(second.reusedThread).toBe(true);
    expect(runner.prompts[1]).toContain("PRIOR SPECIALIST THREAD");
    expect(runner.prompts[1]).toContain("Review the current architecture.");
    expect(runner.prompts[1]).toContain("Here are the new test results. Reassess.");
  });

  test("two independent tasks do not share browser history", async () => {
    const runner = fakeRunner();
    const manager = new TaskSessionManager({ capabilities: plus, runner });
    await manager.turn({ prompt: "architecture", threadId: "architecture" });
    await manager.turn({ prompt: "tests", threadId: "tests" });
    expect(runner.prompts[1]).not.toContain("architecture");
    expect(runner.prompts[1]).toContain("tests");
  });

  test("five parallel batch tasks occupy five slots then recycle", async () => {
    const live = new Set<string>();
    let maxLive = 0;
    const runner = fakeRunner({
      delayMs: 20,
      onStart(jobId) {
        live.add(jobId);
        maxLive = Math.max(maxLive, live.size);
      },
    });
    const originalRun = runner.run.bind(runner);
    runner.run = async input => {
      try {
        return await originalRun(input);
      } finally {
        live.delete(input.jobId);
      }
    };
    const manager = new TaskSessionManager({ capabilities: plus, runner });
    const result = await manager.batch({
      mode: "high",
      tasks: [
        { id: "architecture", prompt: "Review architecture." },
        { id: "tests", prompt: "Analyze failing tests." },
        { id: "security", prompt: "Look for authorization risks." },
        { id: "ux", prompt: "Review operator UX." },
        { id: "release", prompt: "Assess release risk." },
      ],
    });
    expect(result.results.map(item => item.id)).toEqual(["architecture", "tests", "security", "ux", "release"]);
    expect(new Set(result.results.map(item => item.tabSlot)).size).toBe(5);
    expect(maxLive).toBe(5);
    expect(manager.status().pool.active).toBe(0);
  });

  test("a sixth simultaneous task queues unless queue is false", async () => {
    const manager = new TaskSessionManager({
      capabilities: plus,
      runner: fakeRunner({ delayMs: 50 }),
    });
    const running = Promise.all(Array.from({ length: 5 }, (_, index) => manager.turn({ prompt: `job ${index}` })));
    for (let attempt = 0; attempt < 50 && manager.status().pool.active < 5; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    expect(manager.status().pool.active).toBe(5);
    const sixth = manager.turn({ prompt: "sixth" });
    for (let attempt = 0; attempt < 50 && manager.status().queue.depth < 1; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    expect(manager.status().queue.depth).toBe(1);
    expect(manager.status().jobs.some(job => job.status === "queued")).toBe(true);
    await expect(manager.turn({ prompt: "no-queue", queue: false })).rejects.toBeInstanceOf(ChatGptWebTabLimitError);
    await expect(manager.batch({
      tasks: [
        { id: "a", prompt: "a" },
        { id: "b", prompt: "b" },
        { id: "c", prompt: "c" },
        { id: "d", prompt: "d" },
        { id: "e", prompt: "e" },
        { id: "f", prompt: "f" },
      ],
    })).rejects.toBeInstanceOf(ChatGptWebTabLimitError);
    await running;
    await sixth;
    expect(manager.status().pool.active).toBe(0);
    expect(manager.status().queue.depth).toBe(0);
  });

  test("cancel stops an in-flight job and releases the tab", async () => {
    const manager = new TaskSessionManager({
      capabilities: plus,
      runner: fakeRunner({ delayMs: 200 }),
    });
    const pending = manager.turn({ prompt: "slow review", jobId: "job-slow" });
    await Promise.resolve();
    expect(manager.status().pool.active).toBe(1);
    expect(manager.cancel({ jobId: "job-slow" }).cancelled).toEqual(["job-slow"]);
    await expect(pending).rejects.toBeInstanceOf(DOMException);
    expect(manager.status().pool.active).toBe(0);
  });

  test("Plus accounts cannot select Extra High or Pro", async () => {
    const manager = new TaskSessionManager({ capabilities: plus, runner: fakeRunner() });
    await expect(manager.turn({ prompt: "x", mode: "extra-high" })).rejects.toThrow("Extra High");
    await expect(manager.turn({ prompt: "x", mode: "chatgpt-web-pro" })).rejects.toThrow("Pro");
    const allowed = await manager.turn({ prompt: "ok", mode: "chatgpt-web-high" });
    expect(allowed.mode).toBe("high");
    const proManager = new TaskSessionManager({ capabilities: pro, runner: fakeRunner() });
    const extra = await proManager.turn({ prompt: "deep", mode: "extra-high" });
    expect(extra.adapterEffort).toBe("xhigh");
  });

  test("tab pool reuses slots across sequential jobs", () => {
    const pool = new TabPool(2);
    const first = pool.lease("a");
    const second = pool.lease("b");
    expect(pool.activeCount).toBe(2);
    expect(() => pool.lease("c")).toThrow(ChatGptWebTabLimitError);
    first.release();
    const third = pool.lease("c");
    expect(pool.activeCount).toBe(2);
    second.release();
    third.release();
    expect(pool.activeCount).toBe(0);
  });

  test("the same in-flight jobId reuses its leased tab", () => {
    const pool = new TabPool(1);
    const first = pool.lease("job-1");
    const again = pool.lease("job-1");
    expect(again.slotId).toBe(first.slotId);
    expect(pool.activeCount).toBe(1);
    expect(() => pool.lease("job-2")).toThrow(ChatGptWebTabLimitError);
    first.release();
    expect(pool.activeCount).toBe(0);
  });

  test("Luna-only accounts cannot select Sol High", async () => {
    const manager = new TaskSessionManager({
      capabilities: { solAvailable: false, proAvailable: false },
      runner: fakeRunner(),
    });
    await expect(manager.turn({ prompt: "review", mode: "high" })).rejects.toThrow("Luna-only");
    const luna = await manager.turn({ prompt: "review", mode: "luna" });
    expect(luna.mode).toBe("luna");
    expect(luna.modelId).toBe("chatgpt-web-luna");
    expect(manager.status().capabilities.lunaOnly).toBe(true);
    expect(manager.status().capabilities.highAvailable).toBe(false);
  });

  test("delegation compiler keeps Cursor as canonical memory", () => {
    const compiled = compileDelegationEnvelope({
      prompt: "Identify why booking confirmation can report success without evidence.",
      mode: "high",
      modelId: "chatgpt-web-high",
      displayName: "ChatGPT Web — High",
      metadata: {
        task: "Review booking reliability.",
        goal: "Identify why booking confirmation can report success without evidence.",
        constraints: ["no provider mutation", "preserve confirmation boundary"],
        deliverable: "Root cause, safest fix, regression tests",
      },
    });
    expect(compiled.text).toContain("Cursor owns the repository");
    expect(compiled.text).toContain("Do not implement.");
    expect(compiled.text).toContain("TOOL PROTOCOL");
    expect(compiled.text).toContain("CURRENT ASSIGNMENT");
    expect(compiled.text).toContain("no provider mutation");
  });
});
