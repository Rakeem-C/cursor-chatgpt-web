import { expect, test } from "bun:test";
import { shouldLaunchChromeOverCdp } from "../src/chrome-cdp-launch";

test("Windows specialist turns launch Chrome over TCP DevTools instead of Playwright's pipe", () => {
  expect(shouldLaunchChromeOverCdp("win32")).toBe(true);
  expect(shouldLaunchChromeOverCdp("darwin")).toBe(false);
  expect(shouldLaunchChromeOverCdp("linux")).toBe(false);
});
