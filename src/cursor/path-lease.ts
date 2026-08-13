import { CursorChatGptWebError } from "./errors";
import type { SpecialistToolCall } from "./tool-protocol";

export interface PathLease {
  allowedPaths?: readonly string[];
  forbiddenPaths?: readonly string[];
}

function normalizePath(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/^\.\//, "");
}

function matchesPrefix(path: string, rule: string): boolean {
  const target = normalizePath(path);
  const prefix = normalizePath(rule);
  if (!prefix) return false;
  return target === prefix || target.startsWith(`${prefix.replace(/\/$/, "")}/`);
}

export function toolCallPath(call: SpecialistToolCall): string | undefined {
  const args = call.arguments;
  for (const key of ["path", "file", "target", "cwd"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export function pathAllowedByLease(path: string, lease: PathLease): boolean {
  const forbidden = lease.forbiddenPaths ?? [];
  if (forbidden.some(rule => matchesPrefix(path, rule))) return false;
  const allowed = lease.allowedPaths ?? [];
  if (allowed.length === 0) return true;
  return allowed.some(rule => matchesPrefix(path, rule));
}

export function assertToolCallsRespectLease(
  calls: readonly SpecialistToolCall[],
  lease: PathLease,
): void {
  for (const call of calls) {
    const path = toolCallPath(call);
    if (!path) continue;
    if (!pathAllowedByLease(path, lease)) {
      throw new CursorChatGptWebError(
        `GPT Web tool ${call.name} path ${JSON.stringify(path)} is outside the specialist lease`,
        { status: 403, code: "lease_path_denied" },
      );
    }
  }
}
