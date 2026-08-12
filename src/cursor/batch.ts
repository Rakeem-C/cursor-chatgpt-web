import { ChatGptWebTabLimitError, CursorChatGptWebError } from "./errors";
import type { SpecialistBatchRequest, SpecialistBatchTask } from "./task-session";

export type { SpecialistBatchRequest, SpecialistBatchTask };

export function assertBatchRequest(
  request: SpecialistBatchRequest,
  options: { max: number; available: number },
): SpecialistBatchTask[] {
  if (!Array.isArray(request.tasks) || request.tasks.length === 0) {
    throw new CursorChatGptWebError("chatgpt_web_batch requires at least one task", { status: 400, code: "empty_batch" });
  }
  const ids = request.tasks.map(task => task.id.trim());
  if (ids.some(id => !id)) {
    throw new CursorChatGptWebError("chatgpt_web_batch tasks require a non-empty id", { status: 400, code: "invalid_batch_id" });
  }
  if (new Set(ids).size !== ids.length) {
    throw new CursorChatGptWebError("chatgpt_web_batch task ids must be unique", { status: 400, code: "duplicate_batch_id" });
  }
  if (request.tasks.length > options.max) throw new ChatGptWebTabLimitError(options.max);
  if (request.tasks.length > options.available) throw new ChatGptWebTabLimitError(options.max);
  return request.tasks;
}
