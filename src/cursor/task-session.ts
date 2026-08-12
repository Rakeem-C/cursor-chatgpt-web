import { randomBytes } from "node:crypto";
import type { ChatGptWebPromptImage } from "../adapters/chatgpt-web/prompt";
import {
  CURSOR_CHATGPT_WEB_DEFAULT_MODE,
  parseCursorChatGptWebMode,
  requireCursorChatGptWebRoute,
  type ChatGptWebAccountCapabilities,
  type ChatGptWebAdapterEffort,
  type ChatGptWebBackendModel,
  type CursorChatGptWebMode,
} from "../chatgpt-web-models";
import { assertBatchRequest } from "./batch";
import { detectChatGptWebCapabilities } from "./capabilities";
import { compileDelegationEnvelope, type DelegationMetadata, type SpecialistImage, type ThreadMessage } from "./delegation-compiler";
import { CursorChatGptWebError, UnknownCursorModelError } from "./errors";
import { TabPool } from "./tab-pool";

export type { DelegationMetadata, SpecialistImage };

export interface BrowserTurnInput {
  jobId: string;
  backendModel: ChatGptWebBackendModel;
  adapterEffort: ChatGptWebAdapterEffort;
  prompt: string;
  images: ChatGptWebPromptImage[];
  abortSignal: AbortSignal;
  onTextDelta?: (text: string) => void;
  onReasoningSummary?: (text: string, continuation?: boolean) => void;
  onCommentary?: (text: string, continuation?: boolean) => void;
}

export interface BrowserTurnRunner {
  run(input: BrowserTurnInput): Promise<{ answer: string }>;
}

export interface SpecialistTurnRequest {
  prompt: string;
  mode?: string;
  threadId?: string;
  images?: SpecialistImage[];
  metadata?: DelegationMetadata;
  jobId?: string;
  onTextDelta?: (text: string) => void;
}

export interface SpecialistTurnResult {
  jobId: string;
  threadId?: string;
  mode: CursorChatGptWebMode;
  modelId: string;
  displayName: string;
  backendModel: ChatGptWebBackendModel;
  adapterEffort: ChatGptWebAdapterEffort;
  prompt: string;
  compiledPrompt: string;
  answer: string;
  reasoning: string[];
  commentary: string[];
  tabSlot: string;
  reusedThread: boolean;
}

export interface SpecialistBatchTask {
  id: string;
  prompt: string;
  threadId?: string;
  images?: SpecialistImage[];
  metadata?: DelegationMetadata;
}

export interface SpecialistBatchRequest {
  mode?: string;
  tasks: SpecialistBatchTask[];
}

export interface SpecialistBatchResult {
  results: Array<SpecialistTurnResult & { id: string }>;
}

export type SpecialistJobStatus = "running" | "completed" | "cancelled" | "failed";

export interface SpecialistJobSnapshot {
  jobId: string;
  threadId?: string;
  mode: CursorChatGptWebMode;
  status: SpecialistJobStatus;
  tabSlot?: string;
  startedAt: number;
  finishedAt?: number;
  error?: string;
}

interface ActiveJob {
  jobId: string;
  threadId?: string;
  mode: CursorChatGptWebMode;
  status: SpecialistJobStatus;
  tabSlot?: string;
  startedAt: number;
  finishedAt?: number;
  error?: string;
  abort: AbortController;
  releaseTab?: () => void;
}

interface StoredThread {
  threadId: string;
  mode: CursorChatGptWebMode;
  messages: ThreadMessage[];
  updatedAt: number;
}

export interface TaskSessionManagerOptions {
  capabilities: ChatGptWebAccountCapabilities;
  runner: BrowserTurnRunner;
  pool?: TabPool;
  now?: () => number;
  createJobId?: () => string;
}

function normalizeThreadId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export class TaskSessionManager {
  private readonly jobs = new Map<string, ActiveJob>();
  private readonly threads = new Map<string, StoredThread>();
  private readonly pool: TabPool;
  private readonly now: () => number;
  private readonly createJobId: () => string;

  constructor(private readonly options: TaskSessionManagerOptions) {
    this.pool = options.pool ?? new TabPool();
    this.now = options.now ?? Date.now;
    this.createJobId = options.createJobId ?? (() => `job-${randomBytes(8).toString("hex")}`);
  }

  status(): {
    capabilities: ReturnType<typeof detectChatGptWebCapabilities>;
    pool: { active: number; max: number; slots: ReturnType<TabPool["snapshot"]> };
    jobs: SpecialistJobSnapshot[];
    threads: Array<{ threadId: string; mode: CursorChatGptWebMode; messages: number; updatedAt: number }>;
  } {
    return {
      capabilities: detectChatGptWebCapabilities(this.options.capabilities),
      pool: { active: this.pool.activeCount, max: this.pool.max, slots: this.pool.snapshot() },
      jobs: [...this.jobs.values()].map(job => ({
        jobId: job.jobId,
        ...(job.threadId ? { threadId: job.threadId } : {}),
        mode: job.mode,
        status: job.status,
        ...(job.tabSlot ? { tabSlot: job.tabSlot } : {}),
        startedAt: job.startedAt,
        ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
        ...(job.error ? { error: job.error } : {}),
      })),
      threads: [...this.threads.values()].map(thread => ({
        threadId: thread.threadId,
        mode: thread.mode,
        messages: thread.messages.length,
        updatedAt: thread.updatedAt,
      })),
    };
  }

  async turn(request: SpecialistTurnRequest): Promise<SpecialistTurnResult> {
    const modeName = request.mode?.trim() || CURSOR_CHATGPT_WEB_DEFAULT_MODE;
    if (!parseCursorChatGptWebMode(modeName)) throw new UnknownCursorModelError(modeName);
    const route = requireCursorChatGptWebRoute(modeName, this.options.capabilities);
    const threadId = normalizeThreadId(request.threadId);
    const jobId = request.jobId?.trim() || this.createJobId();
    if (this.jobs.get(jobId)?.status === "running") {
      throw new CursorChatGptWebError(`Job ${jobId} is already running`, { status: 409, code: "job_in_flight" });
    }

    const history = threadId ? this.threads.get(threadId)?.messages ?? [] : [];
    const compiled = compileDelegationEnvelope({
      prompt: request.prompt,
      mode: route.cursorMode,
      modelId: route.cursorId,
      displayName: route.displayName,
      ...(threadId ? { threadId } : {}),
      ...(history.length > 0 ? { threadHistory: history } : {}),
      ...(request.images ? { images: request.images } : {}),
      ...(request.metadata ? { metadata: request.metadata } : {}),
    });

    const abort = new AbortController();
    const job: ActiveJob = {
      jobId,
      ...(threadId ? { threadId } : {}),
      mode: route.cursorMode,
      status: "running",
      startedAt: this.now(),
      abort,
    };
    this.jobs.set(jobId, job);

    let leaseRelease: (() => void) | undefined;
    const reasoning: string[] = [];
    const commentary: string[] = [];
    try {
      const lease = this.pool.lease(jobId, this.now());
      job.tabSlot = lease.slotId;
      job.releaseTab = lease.release;
      leaseRelease = lease.release;

      const { answer } = await this.options.runner.run({
        jobId,
        backendModel: route.backendModel,
        adapterEffort: route.adapterEffort,
        prompt: compiled.text,
        images: compiled.images,
        abortSignal: abort.signal,
        onTextDelta: request.onTextDelta,
        onReasoningSummary: (text, continuation) => {
          if (!continuation) reasoning.push(text);
          else if (reasoning.length > 0) reasoning[reasoning.length - 1] += text;
          else reasoning.push(text);
        },
        onCommentary: (text, continuation) => {
          if (!continuation) commentary.push(text);
          else if (commentary.length > 0) commentary[commentary.length - 1] += text;
          else commentary.push(text);
        },
      });

      if (threadId) {
        const thread = this.threads.get(threadId) ?? { threadId, mode: route.cursorMode, messages: [], updatedAt: this.now() };
        thread.mode = route.cursorMode;
        thread.messages.push({ role: "user", text: request.prompt.trim(), at: this.now() });
        thread.messages.push({ role: "assistant", text: answer, at: this.now() });
        thread.updatedAt = this.now();
        this.threads.set(threadId, thread);
      }

      job.status = "completed";
      job.finishedAt = this.now();
      return {
        jobId,
        ...(threadId ? { threadId } : {}),
        mode: route.cursorMode,
        modelId: route.cursorId,
        displayName: route.displayName,
        backendModel: route.backendModel,
        adapterEffort: route.adapterEffort,
        prompt: request.prompt,
        compiledPrompt: compiled.text,
        answer,
        reasoning,
        commentary,
        tabSlot: lease.slotId,
        reusedThread: Boolean(threadId && history.length > 0),
      };
    } catch (error) {
      if (abort.signal.aborted) {
        job.status = "cancelled";
        job.error = "cancelled";
      } else {
        job.status = "failed";
        job.error = error instanceof Error ? error.message : String(error);
      }
      job.finishedAt = this.now();
      throw error;
    } finally {
      leaseRelease?.();
      job.tabSlot = undefined;
      job.releaseTab = undefined;
    }
  }

  async batch(request: SpecialistBatchRequest): Promise<SpecialistBatchResult> {
    const tasks = assertBatchRequest(request, {
      max: this.pool.max,
      available: this.pool.max - this.pool.activeCount,
    });

    const results = await Promise.all(tasks.map(async task => {
      const result = await this.turn({
        prompt: task.prompt,
        mode: request.mode,
        ...(task.threadId ? { threadId: task.threadId } : {}),
        ...(task.images ? { images: task.images } : {}),
        ...(task.metadata ? { metadata: task.metadata } : {}),
        jobId: `batch-${task.id}-${this.createJobId()}`,
      });
      return { ...result, id: task.id };
    }));
    return { results };
  }

  cancel(options: { jobId?: string; threadId?: string; all?: boolean }): { cancelled: string[] } {
    const cancelled: string[] = [];
    const threadId = normalizeThreadId(options.threadId);
    for (const job of this.jobs.values()) {
      if (job.status !== "running") continue;
      const matchAll = options.all === true;
      const matchJob = options.jobId ? job.jobId === options.jobId : false;
      const matchThread = threadId ? job.threadId === threadId : false;
      if (!matchAll && !matchJob && !matchThread) continue;
      job.abort.abort();
      job.releaseTab?.();
      job.status = "cancelled";
      job.finishedAt = this.now();
      job.error = "cancelled";
      cancelled.push(job.jobId);
    }
    if (options.jobId && cancelled.length === 0 && !options.all && !threadId) {
      throw new CursorChatGptWebError(`No running job ${options.jobId}`, { status: 404, code: "job_not_found" });
    }
    return { cancelled };
  }
}
