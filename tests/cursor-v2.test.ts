import { describe, expect, test } from "bun:test";
import { compileDelegationEnvelope, MAX_COMPILED_ENVELOPE_CHARS } from "../src/cursor/delegation-compiler";
import { ChatGptWebLeaseBlockedError, ChatGptWebTabLimitError, CursorChatGptWebError } from "../src/cursor/errors";
import { CURSOR_GPT_WEB_SPAWN } from "../src/cursor/spawn-ux";
import { TaskSessionManager, type BrowserTurnRunner } from "../src/cursor/task-session";

const plus = { solAvailable: true, proAvailable: false };

function fakeRunner(options?: {
  delayMs?: number;
  answers?: string[];
}): BrowserTurnRunner & { prompts: string[] } {
  const prompts: string[] = [];
  let index = 0;
  return {
    prompts,
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
  };
}

describe("V2 named leases and queue", () => {
  test("a role defaults threadId to role:<role> and blocks a second live holder", async () => {
    const runner = fakeRunner({
      answers: ['{"tool_calls":[{"id":"call_1","name":"Read","arguments":{"path":"src/cursor/mcp.ts"}}]}'],
    });
    const manager = new TaskSessionManager({ capabilities: plus, runner });
    const first = await manager.turn({
      prompt: "Review MCP turn.",
      metadata: { role: "mcp-owner", allowedPaths: ["src/cursor"] },
    });
    expect(first.role).toBe("mcp-owner");
    expect(first.threadId).toBe("role:mcp-owner");
    expect(first.resumeRequired).toBe(true);
    expect(manager.status().leases).toEqual([
      { role: "mcp-owner", jobId: first.jobId, status: "awaiting_tools", threadId: "role:mcp-owner" },
    ]);
    await expect(manager.turn({
      prompt: "Another MCP review.",
      metadata: { role: "mcp-owner" },
    })).rejects.toBeInstanceOf(ChatGptWebLeaseBlockedError);
    const other = await manager.turn({
      prompt: "Review auth.",
      metadata: { role: "auth-owner" },
    });
    expect(other.threadId).toBe("role:auth-owner");
  });

  test("FIFO starts the oldest queued job when a tab frees", async () => {
    const runner = fakeRunner({
      answers: Array.from({ length: 7 }, () => '{"tool_calls":[{"id":"call_1","name":"Read","arguments":{"path":"a.ts"}}]}'),
    });
    const manager = new TaskSessionManager({ capabilities: plus, runner });
    for (let index = 0; index < 5; index += 1) {
      await manager.turn({ prompt: `held ${index}`, jobId: `held-${index}` });
    }
    const firstQueued = manager.turn({ prompt: "first queued", jobId: "queued-a" });
    const secondQueued = manager.turn({ prompt: "second queued", jobId: "queued-b" });
    await Promise.resolve();
    expect(manager.status().queue.jobs.map(job => job.jobId)).toEqual(["queued-a", "queued-b"]);
    manager.cancel({ jobId: "held-0" });
    const started = await firstQueued;
    expect(started.jobId).toBe("queued-a");
    expect(manager.status().queue.jobs.map(job => job.jobId)).toEqual(["queued-b"]);
    manager.cancel({ jobId: "queued-b" });
    await expect(secondQueued).rejects.toMatchObject({ code: "cancelled" });
    expect(manager.status().queue.depth).toBe(0);
  });

  test("cancel releases a queued job without occupying a tab", async () => {
    const runner = fakeRunner({ delayMs: 30 });
    const manager = new TaskSessionManager({ capabilities: plus, runner });
    const running = Promise.all(Array.from({ length: 5 }, (_, index) => manager.turn({ prompt: `job ${index}` })));
    for (let attempt = 0; attempt < 50 && manager.status().pool.active < 5; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    const queued = manager.turn({ prompt: "queued", jobId: "job-queued" });
    for (let attempt = 0; attempt < 50 && manager.status().queue.depth < 1; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    expect(manager.cancel({ jobId: "job-queued" }).cancelled).toEqual(["job-queued"]);
    await expect(queued).rejects.toBeInstanceOf(CursorChatGptWebError);
    await running;
    expect(manager.status().pool.active).toBe(0);
  });
});

describe("V2 envelope compiler and path lease", () => {
  test("redacts secrets, attaches role paths, and caps envelope size", () => {
    const compiled = compileDelegationEnvelope({
      prompt: "password=hunter2 and sk-abcdefghijklmnopqrstuvwxyz should not leak",
      mode: "high",
      modelId: "chatgpt-web-high",
      displayName: "ChatGPT Web — High",
      metadata: {
        role: "booking-architecture",
        allowedPaths: ["lib/application"],
        forbiddenPaths: [".env", "prisma/migrations"],
      },
    });
    expect(compiled.text).toContain("ROLE\nbooking-architecture");
    expect(compiled.text).toContain("ALLOWED PATHS\n- lib/application");
    expect(compiled.text).toContain("FORBIDDEN PATHS\n- .env");
    expect(compiled.text).not.toContain("hunter2");
    expect(compiled.text).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    expect(compiled.text).toContain("[redacted-secret]");

    const huge = compileDelegationEnvelope({
      prompt: "x".repeat(MAX_COMPILED_ENVELOPE_CHARS + 50),
      mode: "high",
      modelId: "chatgpt-web-high",
      displayName: "ChatGPT Web — High",
    });
    expect(huge.text.length).toBeLessThanOrEqual(MAX_COMPILED_ENVELOPE_CHARS + 80);
    expect(huge.text).toContain("envelope truncated");
  });

  test("tool paths outside the lease fail closed and release the tab", async () => {
    const runner = fakeRunner({
      answers: ['{"tool_calls":[{"id":"call_1","name":"Read","arguments":{"path":"lib/secret.ts"}}]}'],
    });
    const manager = new TaskSessionManager({ capabilities: plus, runner });
    await expect(manager.turn({
      prompt: "Stay in src/cursor.",
      metadata: { role: "cursor-owner", allowedPaths: ["src/cursor"] },
    })).rejects.toMatchObject({ code: "lease_path_denied", status: 403 });
    expect(manager.status().pool.active).toBe(0);
  });
});

describe("V2 tool loop and spawn UX", () => {
  test("status surfaces blockedOnParent after the resume warn window", async () => {
    let now = 1_000;
    const runner = fakeRunner({
      answers: ['{"tool_calls":[{"id":"call_1","name":"Read","arguments":{"path":"src/cli.ts"}}]}'],
    });
    const manager = new TaskSessionManager({
      capabilities: plus,
      runner,
      now: () => now,
      toolResumeWarnMs: 10,
    });
    const first = await manager.turn({ prompt: "Need a file.", jobId: "job-stall" });
    expect(first.resumeRequired).toBe(true);
    expect(manager.status().blockedOnParent).toEqual([]);
    now = 1_020;
    expect(manager.status().blockedOnParent[0]?.jobId).toBe("job-stall");
    expect(manager.status().spawn).toMatchObject(CURSOR_GPT_WEB_SPAWN);
    expect(manager.status().spawn.notes.some(note => note.includes("Override OpenAI Base URL"))).toBe(true);
  });

  test("queue false still 429s at the tab cap", async () => {
    const manager = new TaskSessionManager({
      capabilities: plus,
      runner: fakeRunner({ delayMs: 20 }),
    });
    const running = Promise.all(Array.from({ length: 5 }, (_, index) => manager.turn({ prompt: `job ${index}` })));
    for (let attempt = 0; attempt < 50 && manager.status().pool.active < 5; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    await expect(manager.turn({ prompt: "sixth", queue: false })).rejects.toBeInstanceOf(ChatGptWebTabLimitError);
    await running;
  });
});
