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
import { ChatGptWebSessionLostError, CursorChatGptWebError, UnknownCursorModelError } from "./errors";
import { TabPool } from "./tab-pool";
import {
  parseToolCalls,
  stripToolCallJson,
  type SpecialistToolCall,
  type SpecialistToolResult,
  type SpecialistToolSpec,
} from "./tool-protocol";

export type { DelegationMetadata, SpecialistImage };
export type { SpecialistToolCall, SpecialistToolResult, SpecialistToolSpec };

export interface BrowserTurnInput {
  jobId: string;
  backendModel: ChatGptWebBackendModel;
  adapterEffort: ChatGptWebAdapterEffort;
  prompt: string;
  images: ChatGptWebPromptImage[];
  abortSignal: AbortSignal;
  keepSessionHold?: boolean;
  onTextDelta?: (text: string) => void;
  onReasoningSummary?: (text: string, continuation?: boolean) => void;
  onCommentary?: (text: string, continuation?: boolean) => void;
}

export interface BrowserTurnRunner {
  run(input: BrowserTurnInput): Promise<{ answer: string }>;
  releaseHold?(jobId: string): Promise<void>;
}

export interface SpecialistTurnRequest {
  prompt?: string;
  mode?: string;
  threadId?: string;
  images?: SpecialistImage[];
  metadata?: DelegationMetadata;
  jobId?: string;
  tools?: SpecialistToolSpec[];
  toolResults?: SpecialistToolResult[];
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
  awaitingTools: boolean;
  toolCalls: SpecialistToolCall[];
}

export interface SpecialistBatchTask {
  id: string;
  prompt: string;
  threadId?: string;
  images?: SpecialistImage[];
  metadata?: DelegationMetadata;
  tools?: SpecialistToolSpec[];
}

export interface SpecialistBatchRequest {
  mode?: string;
  tasks: SpecialistBatchTask[];
}

export interface SpecialistBatchResult {
  results: Array<SpecialistTurnResult & { id: string }>;
}

export type SpecialistJobStatus = "running" | "awaiting_tools" | "completed" | "cancelled" | "failed";

export interface SpecialistJobSnapshot {
  jobId: string;
  threadId?: string;
  mode: CursorChatGptWebMode;
  status: SpecialistJobStatus;
  tabSlot?: string;
  startedAt: number;
  finishedAt?: number;
  error?: string;
  pendingToolCalls?: SpecialistToolCall[];
}

interface ActiveJob {
  jobId: string;
  threadId?: string;
  mode: CursorChatGptWebMode;
  modelId: string;
  displayName: string;
  backendModel: ChatGptWebBackendModel;
  adapterEffort: ChatGptWebAdapterEffort;
  status: SpecialistJobStatus;
  tabSlot?: string;
  startedAt: number;
  finishedAt?: number;
  error?: string;
  abort: AbortController;
  releaseTab?: () => void;
  messages: ThreadMessage[];
  tools?: SpecialistToolSpec[];
  pendingToolCalls?: SpecialistToolCall[];
  metadata?: DelegationMetadata;
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

function isSessionLost(error: unknown): boolean {
  if (error instanceof ChatGptWebSessionLostError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /Temporary Chat session was lost|browser tab closed/i.test(message);
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
        ...(job.pendingToolCalls ? { pendingToolCalls: job.pendingToolCalls } : {}),
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
    const requestedJobId = request.jobId?.trim();
    const existing = requestedJobId ? this.jobs.get(requestedJobId) : undefined;
    if (existing?.status === "running") {
      throw new CursorChatGptWebError(`Job ${existing.jobId} is already running`, { status: 409, code: "job_in_flight" });
    }
    if (existing?.status === "awaiting_tools") {
      return await this.continueJob(existing, request);
    }
    return await this.startJob(request);
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
        ...(task.tools ? { tools: task.tools } : {}),
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
      if (job.status !== "running" && job.status !== "awaiting_tools") continue;
      const matchAll = options.all === true;
      const matchJob = options.jobId ? job.jobId === options.jobId : false;
      const matchThread = threadId ? job.threadId === threadId : false;
      if (!matchAll && !matchJob && !matchThread) continue;
      job.abort.abort();
      this.releaseJob(job);
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

  private async startJob(request: SpecialistTurnRequest): Promise<SpecialistTurnResult> {
    const prompt = request.prompt?.trim() ?? "";
    if (!prompt) throw new CursorChatGptWebError("chatgpt_web_turn requires a non-empty prompt", { status: 400, code: "empty_prompt" });
    const modeName = request.mode?.trim() || CURSOR_CHATGPT_WEB_DEFAULT_MODE;
    if (!parseCursorChatGptWebMode(modeName)) throw new UnknownCursorModelError(modeName);
    const route = requireCursorChatGptWebRoute(modeName, this.options.capabilities);
    const threadId = normalizeThreadId(request.threadId);
    const jobId = request.jobId?.trim() || this.createJobId();
    const history = threadId ? this.threads.get(threadId)?.messages ?? [] : [];
    const compiled = compileDelegationEnvelope({
      prompt,
      mode: route.cursorMode,
      modelId: route.cursorId,
      displayName: route.displayName,
      ...(threadId ? { threadId } : {}),
      ...(history.length > 0 ? { threadHistory: history } : {}),
      ...(request.images ? { images: request.images } : {}),
      ...(request.metadata ? { metadata: request.metadata } : {}),
      ...(request.tools ? { tools: request.tools } : {}),
    });

    const abort = new AbortController();
    const job: ActiveJob = {
      jobId,
      ...(threadId ? { threadId } : {}),
      mode: route.cursorMode,
      modelId: route.cursorId,
      displayName: route.displayName,
      backendModel: route.backendModel,
      adapterEffort: route.adapterEffort,
      status: "running",
      startedAt: this.now(),
      abort,
      messages: [],
      ...(request.tools ? { tools: request.tools } : {}),
      ...(request.metadata ? { metadata: request.metadata } : {}),
    };
    this.jobs.set(jobId, job);

    try {
      const lease = this.pool.lease(jobId, this.now());
      job.tabSlot = lease.slotId;
      job.releaseTab = lease.release;
      return await this.executeTurn(job, {
        prompt,
        compiledPrompt: compiled.text,
        images: compiled.images,
        reusedThread: Boolean(threadId && history.length > 0),
        onTextDelta: request.onTextDelta,
      });
    } catch (error) {
      this.failJob(job, error);
      throw error;
    }
  }

  private async continueJob(job: ActiveJob, request: SpecialistTurnRequest): Promise<SpecialistTurnResult> {
    const prompt = request.prompt?.trim() ?? "";
    const toolResults = request.toolResults ?? [];
    if (!prompt && toolResults.length === 0) {
      throw new CursorChatGptWebError(
        `Job ${job.jobId} is waiting for tool results or a follow-up prompt`,
        { status: 400, code: "tool_results_required" },
      );
    }
    if (!job.tabSlot || !job.releaseTab) {
      throw new CursorChatGptWebError(`Job ${job.jobId} has no live Temporary Chat`, { status: 410, code: "chatgpt_web_session_lost" });
    }

    const compiled = compileDelegationEnvelope({
      prompt,
      mode: job.mode,
      modelId: job.modelId,
      displayName: job.displayName,
      continuation: true,
      ...(job.threadId ? { threadId: job.threadId } : {}),
      ...(job.messages.length > 0 ? { threadHistory: job.messages } : {}),
      ...(toolResults.length > 0 ? { toolResults } : {}),
      ...(job.tools ? { tools: job.tools } : {}),
    });

    job.status = "running";
    job.abort = new AbortController();
    job.pendingToolCalls = undefined;
    try {
      return await this.executeTurn(job, {
        prompt: prompt || "(tool results)",
        compiledPrompt: compiled.text,
        images: compiled.images,
        reusedThread: true,
        onTextDelta: request.onTextDelta,
      });
    } catch (error) {
      this.failJob(job, error);
      throw error;
    }
  }

  private async executeTurn(
    job: ActiveJob,
    input: {
      prompt: string;
      compiledPrompt: string;
      images: ChatGptWebPromptImage[];
      reusedThread: boolean;
      onTextDelta?: (text: string) => void;
    },
  ): Promise<SpecialistTurnResult> {
    const reasoning: string[] = [];
    const commentary: string[] = [];
    let rawAnswer: string;
    try {
      const result = await this.options.runner.run({
        jobId: job.jobId,
        backendModel: job.backendModel,
        adapterEffort: job.adapterEffort,
        prompt: input.compiledPrompt,
        images: input.images,
        abortSignal: job.abort.signal,
        keepSessionHold: true,
        onTextDelta: input.onTextDelta,
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
      rawAnswer = result.answer;
    } catch (error) {
      if (isSessionLost(error)) throw new ChatGptWebSessionLostError(job.jobId);
      throw error;
    }

    const toolCalls = parseToolCalls(rawAnswer);
    const answer = toolCalls.length > 0 ? stripToolCallJson(rawAnswer) : rawAnswer;
    const tabSlot = job.tabSlot ?? "";
    job.messages.push({ role: "user", text: input.prompt, at: this.now() });
    job.messages.push({ role: "assistant", text: rawAnswer, at: this.now() });

    if (job.threadId) {
      const thread = this.threads.get(job.threadId) ?? {
        threadId: job.threadId,
        mode: job.mode,
        messages: [],
        updatedAt: this.now(),
      };
      thread.mode = job.mode;
      thread.messages.push({ role: "user", text: input.prompt, at: this.now() });
      thread.messages.push({ role: "assistant", text: rawAnswer, at: this.now() });
      thread.updatedAt = this.now();
      this.threads.set(job.threadId, thread);
    }

    if (toolCalls.length > 0) {
      job.status = "awaiting_tools";
      job.pendingToolCalls = toolCalls;
    } else {
      job.status = "completed";
      job.finishedAt = this.now();
      this.releaseJob(job);
    }

    return {
      jobId: job.jobId,
      ...(job.threadId ? { threadId: job.threadId } : {}),
      mode: job.mode,
      modelId: job.modelId,
      displayName: job.displayName,
      backendModel: job.backendModel,
      adapterEffort: job.adapterEffort,
      prompt: input.prompt,
      compiledPrompt: input.compiledPrompt,
      answer,
      reasoning,
      commentary,
      tabSlot,
      reusedThread: input.reusedThread,
      awaitingTools: toolCalls.length > 0,
      toolCalls,
    };
  }

  private failJob(job: ActiveJob, error: unknown): void {
    if (job.abort.signal.aborted) {
      job.status = "cancelled";
      job.error = "cancelled";
    } else {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : String(error);
    }
    job.finishedAt = this.now();
    this.releaseJob(job);
  }

  private releaseJob(job: ActiveJob): void {
    job.releaseTab?.();
    job.releaseTab = undefined;
    job.tabSlot = undefined;
    job.pendingToolCalls = undefined;
    void this.options.runner.releaseHold?.(job.jobId);
  }
}
