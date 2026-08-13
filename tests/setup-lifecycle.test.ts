import { expect, test } from "bun:test";
import {
  cursorBrowserOnlySkipsCodexRuntime,
  launcherCapabilityProbeRequired,
  setupProxyIsReady,
  terminalManagedServiceSupported,
} from "../src/setup";

const config = {
  mode: "browser-only" as const,
  releaseVersion: "0.2.0",
};

test("setup accepts only a matching daemon that is ready for new Codex turns", () => {
  const ready = {
    service: "codex-chatgpt-web",
    status: "ok",
    mode: "browser-only",
    version: "0.2.0",
    accepting_turns: true,
  };

  expect(setupProxyIsReady(ready, config)).toBe(true);
  expect(setupProxyIsReady({ ...ready, accepting_turns: false }, config)).toBe(false);
  expect(setupProxyIsReady({ ...ready, status: "degraded" }, config)).toBe(false);
  expect(setupProxyIsReady({ ...ready, version: "0.1.16" }, config)).toBe(false);
});

test("Windows browser-only Cursor setup skips macOS launchd and the Codex proxy", () => {
  expect(terminalManagedServiceSupported("darwin")).toBe(true);
  expect(terminalManagedServiceSupported("win32")).toBe(false);
  expect(terminalManagedServiceSupported("linux")).toBe(false);
  expect(cursorBrowserOnlySkipsCodexRuntime({ mode: "browser-only" }, "win32")).toBe(true);
  expect(cursorBrowserOnlySkipsCodexRuntime({ mode: "browser-only" }, "linux")).toBe(true);
  expect(cursorBrowserOnlySkipsCodexRuntime({ mode: "browser-only" }, "darwin")).toBe(false);
  expect(cursorBrowserOnlySkipsCodexRuntime({ mode: "full" }, "win32")).toBe(false);
});

test("launcher setup refreshes account capabilities only when missing or explicitly requested", () => {
  const verifiedLauncher = {
    browserHost: "launcher",
    solAvailable: true,
    proAvailable: false,
  } as never;

  expect(launcherCapabilityProbeRequired(undefined)).toBe(true);
  expect(launcherCapabilityProbeRequired(verifiedLauncher)).toBe(false);
  expect(launcherCapabilityProbeRequired({
    browserHost: "launcher",
    proAvailable: false,
  } as never)).toBe(true);
  expect(launcherCapabilityProbeRequired(verifiedLauncher, true)).toBe(true);
});
