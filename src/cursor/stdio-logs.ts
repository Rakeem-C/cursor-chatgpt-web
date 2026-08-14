import { format } from "node:util";
import type { Writable } from "node:stream";

/**
 * Stdio MCP uses stdout for JSON-RPC. console.info/log/warn default to stdout and corrupt the
 * stream (`Unexpected token 'c'` from `[chatgpt-web] ...`). Keep diagnostics on stderr.
 */
export function routeStdioMcpLogsToStderr(stderr: Writable = process.stderr): () => void {
  const write = (...values: unknown[]) => {
    stderr.write(`${format(...values)}\n`);
  };
  const previous = {
    log: console.log,
    info: console.info,
    debug: console.debug,
    warn: console.warn,
  };
  console.log = write;
  console.info = write;
  console.debug = write;
  console.warn = write;
  return () => {
    console.log = previous.log;
    console.info = previous.info;
    console.debug = previous.debug;
    console.warn = previous.warn;
  };
}
