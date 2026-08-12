import { afterEach, describe, expect, test } from "bun:test";
import { handleCursorProtocolRequest, parseCursorHttpBody } from "../src/cursor/protocol";
import { resetCursorSpecialistRuntime } from "../src/cursor/runtime";
import { UnknownCursorModelError } from "../src/cursor/errors";

describe("experimental Cursor HTTP adapter", () => {
  afterEach(() => {
    delete process.env.CURSOR_CHATGPT_WEB_SIMULATE;
    resetCursorSpecialistRuntime();
  });

  test("parses Chat Completions and Responses-shaped bodies without trusting Effort fields", () => {
    const completions = parseCursorHttpBody({
      model: "chatgpt-web-high",
      messages: [{ role: "user", content: "Review auth." }],
      reasoning: { effort: "low" },
      stream: false,
    }, new AbortController().signal);
    expect(completions.model).toBe("chatgpt-web-high");
    expect(completions.input).toContain("Review auth.");
    expect(completions.ignoredToolCount).toBe(0);

    const withImage = parseCursorHttpBody({
      model: "chatgpt-web-high",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "What is in this screenshot?" },
          { type: "image_url", image_url: { url: "data:image/png;base64,abc", detail: "high" } },
        ],
      }],
      tools: [{ type: "function", function: { name: "Read" } }],
      reasoning: { effort: "low" },
    }, new AbortController().signal);
    expect(withImage.images?.[0]?.imageUrl).toContain("data:image/png");
    expect(withImage.ignoredToolCount).toBe(1);
    expect(withImage.model).toBe("chatgpt-web-high");

    const responses = parseCursorHttpBody({
      model: "chatgpt-web-high",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Review booking." }] }],
      previous_response_id: "assistant-reliability-review",
    }, new AbortController().signal);
    expect(responses.previousResponseId).toBe("assistant-reliability-review");
    expect(responses.input).toContain("Review booking.");
  });

  test("unknown models fail closed before any browser work", () => {
    expect(() => parseCursorHttpBody({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
    }, new AbortController().signal)).toThrow(UnknownCursorModelError);
    expect(() => parseCursorHttpBody({
      messages: [{ role: "user", content: "hi" }],
    }, new AbortController().signal)).toThrow(UnknownCursorModelError);
  });

  test("GET /v1/models lists unique Cursor IDs and POST rejects gpt-5.5", async () => {
    process.env.CURSOR_CHATGPT_WEB_SIMULATE = "1";
    resetCursorSpecialistRuntime();
    const models = await handleCursorProtocolRequest(new Request("http://127.0.0.1/v1/models"));
    expect(models.status).toBe(200);
    const catalog = await models.json() as { data: Array<{ id: string }> };
    expect(catalog.data.map(model => model.id)).toContain("chatgpt-web-high");
    expect(catalog.data.map(model => model.id)).not.toContain("gpt-5.5");

    const rejected = await handleCursorProtocolRequest(new Request("http://127.0.0.1/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.5", messages: [{ role: "user", content: "hi" }] }),
    }));
    expect(rejected.status).toBe(400);
    const payload = await rejected.json() as { error: { code: string } };
    expect(payload.error.code).toBe("unknown_model");
  });

  test("simulated High turn streams Chat Completions chunks", async () => {
    process.env.CURSOR_CHATGPT_WEB_SIMULATE = "1";
    resetCursorSpecialistRuntime();
    const response = await handleCursorProtocolRequest(new Request("http://127.0.0.1/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "chatgpt-web-high",
        stream: true,
        messages: [{ role: "user", content: "Review the confirmation boundary." }],
      }),
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const body = await response.text();
    expect(body).toContain("simulated high gpt-5.6-sol");
    expect(body).toContain("data: [DONE]");
  });
});
