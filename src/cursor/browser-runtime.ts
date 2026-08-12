import { ChatGptBrowserWorker } from "../adapters/chatgpt-web/browser-worker";
import { providerConfig, type AppConfig } from "../config";
import type { BrowserTurnRunner } from "./task-session";

/**
 * V1 specialist turns are read-only in the browser. Cursor keeps Read/Search/Shell/ApplyPatch.
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
  };
}

export function createSimulatedTurnRunner(): BrowserTurnRunner {
  return {
    async run(input) {
      if (input.abortSignal.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
      const answer = [
        `[simulated ${input.adapterEffort} ${input.backendModel}]`,
        "Cursor remains responsible for local tools.",
        input.prompt.slice(0, 1_200),
      ].join("\n\n");
      input.onTextDelta?.(answer);
      return { answer };
    },
  };
}
