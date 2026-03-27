export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

const suppressedLevels = new Set<LogLevel>((process.env.NODE_ENV || "production") === "production" ? ["DEBUG"] : []);

function serializeError(error: Error): Record<string, string | undefined> {
  return { name: error.name, message: error.message, stack: error.stack };
}

function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) return serializeError(value);
  return value;
}

export function log(level: LogLevel, payload: Record<string, unknown>): void {
  if (suppressedLevels.has(level)) return;
  const stream = level === "WARN" || level === "ERROR" ? process.stderr : process.stdout;
  stream.write(`${JSON.stringify({ level, ...payload }, replacer)}\n`);
}
