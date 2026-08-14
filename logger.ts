import fs from "fs";
import path from "path";

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

const suppressedLevels = new Set<LogLevel>((process.env.NODE_ENV || "production") === "production" ? ["DEBUG"] : []);
let fileStream: fs.WriteStream | undefined;
let fileStreamFailed = false;

function serializeError(error: Error): Record<string, string | undefined> {
  return { name: error.name, message: error.message, stack: error.stack };
}

function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) return serializeError(value);
  return value;
}

function getFileStream(): fs.WriteStream | undefined {
  if (fileStream || fileStreamFailed) return fileStream;

  const logFilePath = process.env.LOG_FILE_PATH;
  if (!logFilePath) return undefined;

  try {
    fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
    fileStream = fs.createWriteStream(logFilePath, { flags: "a" });
    fileStream.on("error", (error) => {
      fileStreamFailed = true;
      fileStream = undefined;
      process.stderr.write(`${JSON.stringify({ level: "ERROR", time: new Date().toISOString(), msg: "FILE LOGGING FAILED", logFilePath, error: serializeError(error) })}\n`);
    });
    return fileStream;
  } catch (error) {
    fileStreamFailed = true;
    process.stderr.write(`${JSON.stringify({ level: "ERROR", time: new Date().toISOString(), msg: "FILE LOGGING INIT FAILED", logFilePath, error: error instanceof Error ? serializeError(error) : String(error) })}\n`);
    return undefined;
  }
}

export function log(level: LogLevel, payload: Record<string, unknown>): void {
  if (suppressedLevels.has(level)) return;
  const line = `${JSON.stringify({ level, time: new Date().toISOString(), ...payload }, replacer)}\n`;
  const stream = level === "WARN" || level === "ERROR" ? process.stderr : process.stdout;
  stream.write(line);
  getFileStream()?.write(line);
}
