/** Tiny leveled logger that writes to stderr so it never corrupts TUI output. */
export interface Logger {
  debug(message: string): void
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug"

const ORDER: Record<LogLevel, number> = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 }

const write = (level: "error" | "warn" | "info" | "debug", message: string) => {
  try {
    process.stderr.write(`[opencode-http-notifier] ${level}: ${message}\n`)
  } catch {
    // Logging must never break the plugin.
  }
}

export const createLogger = (level: LogLevel = "warn"): Logger => {
  const enabled = (candidate: LogLevel) => ORDER[level] >= ORDER[candidate]
  return {
    debug: (message) => enabled("debug") && write("debug", message),
    info: (message) => enabled("info") && write("info", message),
    warn: (message) => enabled("warn") && write("warn", message),
    error: (message) => enabled("error") && write("error", message),
  }
}

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}
