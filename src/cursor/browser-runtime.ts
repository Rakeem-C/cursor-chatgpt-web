import { ChatGptBrowserWorker } from "../adapters/chatgpt-web/browser-worker";
import { providerConfig, type AppConfig } from "../config";
import type { BrowserTurnRunner } from "./task-session";

/**
 * V1 specialist turns are read-only in the browser. Cursor keeps Read/Search/Shell/ApplyPatch.
 * Phase 6 tool roundtrips keep the same Temporary Chat via sessionHoldKey = jobId.
 */
export function createBrowserTurnRunner(config: AppConfig): BrowserTurnRunner {
  const provider = providerConfig({ ...config, mode: "browser-only" });
  if (provider.chatgptWeb) provider.chatgptWeb.localToolsEnabled = false;
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const capabilities = {
    localToolsEnabled: false,
    solAvailable: config.solAvailable,
    proAvailable: config.proAvailable,
  };

  return {
    async run(input) {
      return {
        answer: await worker.run({
          traceId: input.jobId,
          modelId: input.backendModel,
          reasoning: input.adapterEffort,
          capabilities,
          sessionHoldKey: input.jobId,
          keepSessionHold: input.keepSessionHold === true,
          prepare: async () => ({
            text: input.prompt,
            images: input.images,
            release: () => {},
          }),
          abortSignal: input.abortSignal,
          onTextDelta: input.onTextDelta ?? (() => {}),
          ...(input.onReasoningSummary ? { onReasoningSummary: input.onReasoningSummary } : {}),
          ...(input.onCommentary ? { onCommentary: input.onCommentary } : {}),
        }),
      };
    },
    async releaseHold(jobId) {
      await worker.releaseSessionHold(jobId);
    },
  };
}

export function createSimulatedTurnRunner(): BrowserTurnRunner {
  return {
    async run(input) {
      if (input.abortSignal.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
      if (/SIMULATE_TOOL_CALL/.test(input.prompt) && !/\nTOOL RESULTS\n/.test(input.prompt)) {
        const answer = [
          "```json",
          JSON.stringify({
            tool_calls: [{
              id: "call_1",
              name: "Read",
              arguments: { path: "lib/domain/lifecycle.ts" },
            }],
          }),
          "```",
        ].join("\n");
        input.onTextDelta?.(answer);
        return { answer };
      }
      const answer = /\nTOOL RESULTS\n/.test(input.prompt)
        ? [
            `[simulated ${input.adapterEffort} ${input.backendModel}]`,
            "Tool evidence received. Cursor remains responsible for local tools.",
            "Final review: use the tool results; do not implement.",
          ].join("\n\n")
        : [
            `[simulated ${input.adapterEffort} ${input.backendModel}]`,
            "Cursor remains responsible for local tools.",
            input.prompt.slice(0, 1_200),
          ].join("\n\n");
      input.onTextDelta?.(answer);
      return { answer };
    },
    async releaseHold() {},
  };
}
