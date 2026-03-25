/**
 * Structured logging utility for claude-peers.
 *
 * All output goes to stderr (critical for MCP servers where stdout is the protocol channel).
 * Respects LOG_LEVEL env var: debug | info | warn | error (default: info).
 */

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const currentLevel: LogLevel = (() => {
  const env = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  return env in LEVEL_PRIORITY ? (env as LogLevel) : "info";
})();

export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export function createLogger(component: string): Logger {
  const prefix = `[claude-peers:${component}]`;

  function emit(level: LogLevel, msg: string) {
    if (LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[currentLevel]) {
      const ts = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      console.error(`[${ts}] ${prefix} [${level.toUpperCase()}] ${msg}`);
    }
  }

  return {
    debug: (msg) => emit("debug", msg),
    info: (msg) => emit("info", msg),
    warn: (msg) => emit("warn", msg),
    error: (msg) => emit("error", msg),
  };
}
