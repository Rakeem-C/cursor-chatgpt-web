import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import { VERSION } from "../version";
import { isCursorChatGptWebError } from "./errors";
import { CURSOR_GPT_WEB_MCP_INSTRUCTIONS } from "./policy";
import { getCursorSpecialistRuntime } from "./runtime";
import { routeStdioMcpLogsToStderr } from "./stdio-logs";
import type { SpecialistImage, SpecialistToolResult, SpecialistToolSpec, SpecialistTurnResult } from "./task-session";

const modeSchema = z.enum(["instant", "medium", "high", "extra-high", "pro", "luna"]).optional();
const imageSchema = z.object({
  ref: z.string().min(1).max(200).optional(),
  imageUrl: z.string().min(1).max(20_000_000),
  detail: z.string().max(32).optional(),
});
const metadataSchema = z.object({
  task: z.string().max(4_000).optional(),
  goal: z.string().max(8_000).optional(),
  repo: z.string().max(1_000).optional(),
  parentModel: z.string().max(200).optional(),
  constraints: z.array(z.string().max(1_000)).max(32).optional(),
  deliverable: z.string().max(8_000).optional(),
  role: z.string().min(1).max(200).optional(),
  allowedPaths: z.array(z.string().min(1).max(1_000)).max(64).optional(),
  forbiddenPaths: z.array(z.string().min(1).max(1_000)).max(64).optional(),
});
const toolSpecSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(4_000).optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
});
const toolResultSchema = z.object({
  id: z.string().min(1).max(200).optional(),
  name: z.string().min(1).max(200).optional(),
  content: z.string().max(500_000),
  isError: z.boolean().optional(),
});

function mcpResult(value: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
}

function fail(error: unknown) {
  if (isCursorChatGptWebError(error)) {
    return mcpResult({
      error: error.message,
      code: error.code,
      status: error.status,
      retryable: error.retryable,
    }, true);
  }
  return mcpResult({
    error: error instanceof Error ? error.message : String(error),
    code: "chatgpt_web_error",
    status: 500,
  }, true);
}

function publicTurn(result: SpecialistTurnResult) {
  return {
    jobId: result.jobId,
    ...(result.threadId ? { threadId: result.threadId } : {}),
    mode: result.mode,
    modelId: result.modelId,
    displayName: result.displayName,
    backendModel: result.backendModel,
    adapterEffort: result.adapterEffort,
    reusedThread: result.reusedThread,
    answer: result.answer,
    reasoning: result.reasoning,
    commentary: result.commentary,
    awaitingTools: result.awaitingTools,
    resumeRequired: result.resumeRequired,
    toolCalls: result.toolCalls,
    ...(result.role ? { role: result.role } : {}),
  };
}

export function attachEmptyMcpCatalogs(server: McpServer): void {
  server.server.registerCapabilities({ resources: {} });
  server.server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));
  server.server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [],
  }));
}

export async function runCursorChatGptWebMcpServer(): Promise<void> {
  routeStdioMcpLogsToStderr();
  const server = new McpServer(
    { name: "cursor-chatgpt-web", version: VERSION },
    { instructions: CURSOR_GPT_WEB_MCP_INSTRUCTIONS },
  );
  attachEmptyMcpCatalogs(server);
  const runtime = () => getCursorSpecialistRuntime();

  server.registerTool(
    "chatgpt_web_turn",
    {
      title: "Ask GPT Web High",
      description: [
        "Delegate a focused reasoning job to ChatGPT Web (default GPT-5.6 Sol High) in a Temporary Chat.",
        "Use for ambiguous architecture, hard root cause, independent review, or a second opinion.",
        "Do not use for trivial edits, formatting, simple search, or one-line fixes.",
        "Cursor must keep Read, Search, Shell, ApplyPatch, git, and tests. Omit threadId for a fresh Temporary Chat; pass threadId only to resume an explicit specialist thread.",
        "Set metadata.role for a named lease; threadId defaults to role:<role>. A second live job with the same role fails with lease_blocked.",
        "If the result has awaitingTools=true, run the toolCalls locally and call again with the same jobId and toolResults. That continues the same Temporary Chat.",
        "A sixth concurrent turn queues unless queue=false, which keeps chatgpt_web_tab_limit.",
      ].join(" "),
      inputSchema: {
        prompt: z.string().min(1).max(500_000).optional(),
        mode: modeSchema,
        threadId: z.string().min(1).max(200).optional(),
        jobId: z.string().min(1).max(200).optional(),
        images: z.array(imageSchema).max(10).optional(),
        metadata: metadataSchema.optional(),
        tools: z.array(toolSpecSchema).max(32).optional(),
        toolResults: z.array(toolResultSchema).max(32).optional(),
        queue: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ prompt, mode, threadId, jobId, images, metadata, tools, toolResults, queue }) => {
      try {
        const result = await runtime().turn({
          ...(prompt ? { prompt } : {}),
          ...(mode ? { mode } : {}),
          ...(threadId ? { threadId } : {}),
          ...(jobId ? { jobId } : {}),
          ...(images ? { images: images as SpecialistImage[] } : {}),
          ...(metadata ? { metadata } : {}),
          ...(tools ? { tools: tools as SpecialistToolSpec[] } : {}),
          ...(toolResults ? { toolResults: toolResults as SpecialistToolResult[] } : {}),
          ...(queue === undefined ? {} : { queue }),
        });
        return mcpResult(publicTurn(result));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "chatgpt_web_batch",
    {
      title: "Ask several GPT Web specialists",
      description: [
        "Run up to five isolated GPT Web Temporary Chats in parallel and return all results.",
        "Each task is a separate job unless it sets threadId. A sixth batch task fails with chatgpt_web_tab_limit; turns queue instead.",
      ].join(" "),
      inputSchema: {
        mode: modeSchema,
        tasks: z.array(z.object({
          id: z.string().min(1).max(100),
          prompt: z.string().min(1).max(500_000),
          threadId: z.string().min(1).max(200).optional(),
          images: z.array(imageSchema).max(10).optional(),
          metadata: metadataSchema.optional(),
        })).min(1).max(5),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ mode, tasks }) => {
      try {
        const result = await runtime().batch({
          ...(mode ? { mode } : {}),
          tasks: tasks.map(task => ({
            id: task.id,
            prompt: task.prompt,
            ...(task.threadId ? { threadId: task.threadId } : {}),
            ...(task.images ? { images: task.images as SpecialistImage[] } : {}),
            ...(task.metadata ? { metadata: task.metadata } : {}),
          })),
        });
        return mcpResult({
          results: result.results.map(item => ({ id: item.id, ...publicTurn(item) })),
        });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "chatgpt_web_status",
    {
      title: "GPT Web specialist status",
      description: "Show ChatGPT account capabilities, live browser slots (n/5), named leases, queued jobs, spawn UX, and jobs blocked waiting for the parent to resume tools.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => mcpResult(runtime().status()),
  );

  server.registerTool(
    "chatgpt_web_cancel",
    {
      title: "Cancel GPT Web work",
      description: "Abort a running, awaiting-tools, or queued specialist job, every job on a threadId, or all live GPT Web sessions.",
      inputSchema: {
        jobId: z.string().min(1).max(200).optional(),
        threadId: z.string().min(1).max(200).optional(),
        all: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ jobId, threadId, all }) => {
      try {
        if (!jobId && !threadId && all !== true) {
          return fail(new Error("chatgpt_web_cancel requires jobId, threadId, or all=true"));
        }
        return mcpResult(runtime().cancel({
          ...(jobId ? { jobId } : {}),
          ...(threadId ? { threadId } : {}),
          ...(all ? { all: true } : {}),
        }));
      } catch (error) {
        return fail(error);
      }
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
