/** Visible ChatGPT effort-control labels, longest first so Extra High is not mistaken for High. */
export const CHATGPT_EFFORT_CONTROL_LABELS = ["Extra High", "Instant", "Medium", "High", "Pro"] as const;

export type ChatGptEffortControlLabel = (typeof CHATGPT_EFFORT_CONTROL_LABELS)[number];

export function parseChatGptEffortControlLabel(
  text: string | null | undefined,
): ChatGptEffortControlLabel | undefined {
  const normalized = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  for (const label of CHATGPT_EFFORT_CONTROL_LABELS) {
    if (normalized === label || normalized.endsWith(` ${label}`) || normalized.endsWith(`· ${label}`)) {
      return label;
    }
  }
  return undefined;
}

/**
 * First parseable closed-control string wins (innerText before aria-label).
 * An unparseable control is not treated as the requested mode.
 */
export function chatGptEffortControlShowsMode(
  candidates: Array<string | null | undefined>,
  requested: string,
): boolean {
  for (const candidate of candidates) {
    const parsed = parseChatGptEffortControlLabel(candidate);
    if (parsed) return parsed === requested;
  }
  return false;
}
