import { expect, test } from "bun:test";
import {
  chatGptEffortControlShowsMode,
  parseChatGptEffortControlLabel,
} from "../src/chatgpt-effort-control";

test("closed effort-control labels prefer Extra High over High", () => {
  expect(parseChatGptEffortControlLabel("High")).toBe("High");
  expect(parseChatGptEffortControlLabel("GPT-5.6 High")).toBe("High");
  expect(parseChatGptEffortControlLabel("Extra High")).toBe("Extra High");
  expect(parseChatGptEffortControlLabel("GPT-5.6 Extra High")).toBe("Extra High");
  expect(parseChatGptEffortControlLabel("Instant")).toBe("Instant");
  expect(parseChatGptEffortControlLabel("  Medium \n")).toBe("Medium");
  expect(parseChatGptEffortControlLabel("Pro")).toBe("Pro");
  expect(parseChatGptEffortControlLabel("")).toBeUndefined();
  expect(parseChatGptEffortControlLabel("Thinking")).toBeUndefined();
});

test("already-High / empty menu is success; Instant is not a High fallback", () => {
  expect(chatGptEffortControlShowsMode(["High"], "High")).toBe(true);
  expect(chatGptEffortControlShowsMode(["GPT-5.6\nHigh", "Reasoning"], "High")).toBe(true);
  expect(chatGptEffortControlShowsMode(["Extra High"], "High")).toBe(false);
  expect(chatGptEffortControlShowsMode(["Instant"], "High")).toBe(false);
  expect(chatGptEffortControlShowsMode(["", "High"], "High")).toBe(true);
  expect(chatGptEffortControlShowsMode(["Instant", "High"], "High")).toBe(false);
  expect(chatGptEffortControlShowsMode([null, undefined, ""], "High")).toBe(false);
});
