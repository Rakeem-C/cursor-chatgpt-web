import { loadConfig } from "../config";
import { createBrowserTurnRunner, createSimulatedTurnRunner } from "./browser-runtime";
import { TaskSessionManager } from "./task-session";

let manager: TaskSessionManager | undefined;

export function resetCursorSpecialistRuntime(): void {
  manager = undefined;
}

export function getCursorSpecialistRuntime(): TaskSessionManager {
  if (manager) return manager;
  const simulate = process.env.CURSOR_CHATGPT_WEB_SIMULATE === "1";
  if (simulate) {
    manager = new TaskSessionManager({
      capabilities: {
        solAvailable: process.env.CURSOR_CHATGPT_WEB_SOL !== "0",
        proAvailable: process.env.CURSOR_CHATGPT_WEB_PRO === "1",
      },
      runner: createSimulatedTurnRunner(),
    });
    return manager;
  }
  const config = loadConfig();
  manager = new TaskSessionManager({
    capabilities: { solAvailable: config.solAvailable, proAvailable: config.proAvailable },
    runner: createBrowserTurnRunner(config),
  });
  return manager;
}
