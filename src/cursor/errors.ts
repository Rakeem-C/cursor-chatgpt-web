export class CursorChatGptWebError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;

  constructor(message: string, options: { status: number; code: string; retryable?: boolean }) {
    super(message);
    this.name = "CursorChatGptWebError";
    this.status = options.status;
    this.code = options.code;
    this.retryable = options.retryable === true;
  }
}

export class ChatGptWebTabLimitError extends CursorChatGptWebError {
  constructor(max = 5) {
    super(
      `ChatGPT Web supports at most ${max} simultaneous specialist sessions; wait for a job to finish or cancel one`,
      { status: 429, code: "chatgpt_web_tab_limit", retryable: true },
    );
    this.name = "ChatGptWebTabLimitError";
  }
}

export class UnknownCursorModelError extends CursorChatGptWebError {
  constructor(modelId: string) {
    super(
      `Unknown model ${JSON.stringify(modelId)} was sent to cursor-chatgpt-web; refusing to route it to ChatGPT Web or OpenAI`,
      { status: 400, code: "unknown_model" },
    );
    this.name = "UnknownCursorModelError";
  }
}

export function isCursorChatGptWebError(error: unknown): error is CursorChatGptWebError {
  return error instanceof CursorChatGptWebError;
}
