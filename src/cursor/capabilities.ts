import {
  availableCursorChatGptWebRoutes,
  CHATGPT_WEB_LUNA_MODEL_ROUTE,
  CHATGPT_WEB_MODEL_ROUTES,
  CURSOR_CHATGPT_WEB_DEFAULT_MODE,
  type ChatGptWebAccountCapabilities,
  type CursorChatGptWebMode,
} from "../chatgpt-web-models";
import { reviewCapturedFixtures, type FixtureReview } from "./fixtures/review";

const ALL_CURSOR_ROUTES = [CHATGPT_WEB_LUNA_MODEL_ROUTE, ...CHATGPT_WEB_MODEL_ROUTES] as const;

export interface DetectedChatGptWebCapabilities extends ChatGptWebAccountCapabilities {
  lunaOnly: boolean;
  highAvailable: boolean;
  extraHighAvailable: boolean;
  defaultMode: CursorChatGptWebMode;
  pickerMode: FixtureReview["pickerMode"];
  nativeTaskMode: FixtureReview["nativeTaskMode"];
  fixtures: FixtureReview;
  modes: Array<{
    mode: CursorChatGptWebMode;
    cursorId: string;
    displayName: string;
    available: boolean;
    reason?: string;
  }>;
}

export function detectChatGptWebCapabilities(
  capabilities: ChatGptWebAccountCapabilities,
  fixtures = reviewCapturedFixtures(),
): DetectedChatGptWebCapabilities {
  const lunaOnly = !capabilities.solAvailable;
  const availableIds = new Set(availableCursorChatGptWebRoutes(capabilities).map(route => route.cursorId));

  return {
    solAvailable: capabilities.solAvailable,
    proAvailable: capabilities.proAvailable,
    lunaOnly,
    highAvailable: availableIds.has("chatgpt-web-high"),
    extraHighAvailable: availableIds.has("chatgpt-web-extra-high"),
    defaultMode: lunaOnly ? "luna" : CURSOR_CHATGPT_WEB_DEFAULT_MODE,
    pickerMode: fixtures.pickerMode,
    nativeTaskMode: fixtures.nativeTaskMode,
    fixtures,
    modes: ALL_CURSOR_ROUTES.map(route => {
      const available = availableIds.has(route.cursorId);
      let reason: string | undefined;
      if (!available) {
        if (route.cursorMode === "luna") reason = "Luna is only available on Luna-only accounts";
        else if (lunaOnly) reason = "Sol modes are unavailable on Luna-only accounts";
        else if (route.requiresPro) reason = "Requires a Pro ChatGPT account";
        else reason = "Not available for this account";
      }
      return {
        mode: route.cursorMode,
        cursorId: route.cursorId,
        displayName: route.displayName,
        available,
        ...(reason ? { reason } : {}),
      };
    }),
  };
}
