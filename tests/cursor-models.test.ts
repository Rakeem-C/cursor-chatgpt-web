import { describe, expect, test } from "bun:test";
import {
  CURSOR_CHATGPT_WEB_DEFAULT_MODE,
  cursorModelIdForMode,
  parseCursorChatGptWebMode,
  requireCursorChatGptWebRoute,
} from "../src/chatgpt-web-models";
import { detectChatGptWebCapabilities } from "../src/cursor/capabilities";
import { resolveChatGptWebModelMode } from "../src/adapters/chatgpt-web/model";

describe("Cursor-facing GPT Web model IDs", () => {
  const plus = { solAvailable: true, proAvailable: false };

  test("maps chatgpt-web-high to Sol High and treats the ID as authoritative", () => {
    expect(CURSOR_CHATGPT_WEB_DEFAULT_MODE).toBe("high");
    expect(cursorModelIdForMode("high")).toBe("chatgpt-web-high");
    expect(parseCursorChatGptWebMode("chatgpt-web/high")).toBe("high");
    const route = requireCursorChatGptWebRoute("chatgpt-web-high", plus);
    expect(route.backendModel).toBe("gpt-5.6-sol");
    expect(route.adapterEffort).toBe("high");
    expect(route.cursorId).toBe("chatgpt-web-high");
  });

  test("accepts slash aliases without inventing a second taxonomy", () => {
    expect(requireCursorChatGptWebRoute("chatgpt-web/light", plus).cursorMode).toBe("instant");
    expect(requireCursorChatGptWebRoute("instant", plus).cursorId).toBe("chatgpt-web-instant");
  });

  test("does not treat built-in Cursor model names as GPT Web", () => {
    expect(parseCursorChatGptWebMode("gpt-5.5")).toBeUndefined();
    expect(parseCursorChatGptWebMode("gpt-5.6-sol")).toBeUndefined();
    expect(parseCursorChatGptWebMode("composer-2.5")).toBeUndefined();
    expect(() => requireCursorChatGptWebRoute("gpt-5.5", plus)).toThrow("not enabled");
  });

  test("High remains slider index 2 and capability detection lists account modes", () => {
    expect(resolveChatGptWebModelMode("gpt-5.6-sol", "high", {
      localToolsEnabled: false,
      solAvailable: true,
      proAvailable: false,
    }).uiEffortIndex).toBe(2);
    const plusCaps = detectChatGptWebCapabilities(plus);
    expect(plusCaps.defaultMode).toBe("high");
    expect(plusCaps.highAvailable).toBe(true);
    expect(plusCaps.extraHighAvailable).toBe(false);
    expect(plusCaps.modes.find(mode => mode.mode === "pro")?.available).toBe(false);
    const luna = detectChatGptWebCapabilities({ solAvailable: false, proAvailable: false });
    expect(luna.lunaOnly).toBe(true);
    expect(luna.defaultMode).toBe("luna");
    expect(luna.highAvailable).toBe(false);
  });
});
