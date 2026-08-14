import fs from "fs";
import path from "path";

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

const suppressedLevels = new Set<LogLevel>((process.env.NODE_ENV || "production") === "production" ? ["DEBUG"] : []);
const logRotateMaxBytes = parseInt(process.env.LOG_ROTATE_MAX_BYTES ?? `${256 * 1024 * 1024}`, 10);
const logRotateMaxFiles = parseInt(process.env.LOG_ROTATE_MAX_FILES ?? "8", 10);
let fileStream: fs.WriteStream | undefined;
let fileStreamFailed = false;
let currentLogFileSize = 0;

function serializeError(error: Error): Record<string, string | undefined> {
  return { name: error.name, message: error.message, stack: error.stack };
}

function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) return serializeError(value);
  return value;
}

function emitFileLoggingError(msg: string, logFilePath: string, error: unknown): void {
  process.stderr.write(`${JSON.stringify({ level: "ERROR", time: new Date().toISOString(), msg, logFilePath, error: error instanceof Error ? serializeError(error) : String(error) })}\n`);
}

function rotateLogFile(logFilePath: string): void {
  if (logRotateMaxBytes <= 0 || logRotateMaxFiles <= 0) return;

  fileStream?.end();
  fileStream = undefined;

  const oldestLogFilePath = `${logFilePath}.${logRotateMaxFiles}`;
  if (fs.existsSync(oldestLogFilePath)) fs.unlinkSync(oldestLogFilePath);

  for (let index = logRotateMaxFiles - 1; index >= 1; index -= 1) {
    const source = `${logFilePath}.${index}`;
    const target = `${logFilePath}.${index + 1}`;
    if (fs.existsSync(source)) fs.renameSync(source, target);
  }

  if (fs.existsSync(logFilePath)) fs.renameSync(logFilePath, `${logFilePath}.1`);
  currentLogFileSize = 0;
}

function rotateLogFileIfNeeded(logFilePath: string, nextLineSize: number): void {
  if (logRotateMaxBytes <= 0 || currentLogFileSize + nextLineSize <= logRotateMaxBytes) return;
  try {
    rotateLogFile(logFilePath);
  } catch (error) {
    fileStreamFailed = true;
    fileStream = undefined;
    emitFileLoggingError("FILE LOG ROTATION FAILED", logFilePath, error);
  }
}

function getFileStream(): fs.WriteStream | undefined {
  if (fileStream || fileStreamFailed) return fileStream;

  const logFilePath = process.env.LOG_FILE_PATH;
  if (!logFilePath) return undefined;

  try {
    fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
    currentLogFileSize = fs.existsSync(logFilePath) ? fs.statSync(logFilePath).size : 0;
    fileStream = fs.createWriteStream(logFilePath, { flags: "a" });
    fileStream.on("error", (error) => {
      fileStreamFailed = true;
      fileStream = undefined;
      emitFileLoggingError("FILE LOGGING FAILED", logFilePath, error);
    });
    return fileStream;
  } catch (error) {
    fileStreamFailed = true;
    emitFileLoggingError("FILE LOGGING INIT FAILED", logFilePath, error);
    return undefined;
  }
}

export function log(level: LogLevel, payload: Record<string, unknown>): void {
  if (suppressedLevels.has(level)) return;
  const line = `${JSON.stringify({ level, time: new Date().toISOString(), ...payload }, replacer)}\n`;
  const stream = level === "WARN" || level === "ERROR" ? process.stderr : process.stdout;
  stream.write(line);
  const logFilePath = process.env.LOG_FILE_PATH;
  if (!logFilePath || fileStreamFailed) return;

  const lineSize = Buffer.byteLength(line);
  rotateLogFileIfNeeded(logFilePath, lineSize);
  getFileStream()?.write(line);
  currentLogFileSize += lineSize;
}
