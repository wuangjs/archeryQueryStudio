import type * as vscode from "vscode";

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string, error?: unknown): void;
}

export function createLogger(channel: vscode.OutputChannel): Logger {
  const write = (level: string, message: string, error?: unknown): void => {
    const stamp = new Date().toISOString();
    const detail =
      error instanceof Error
        ? ` ${error.message}${error.stack ? `\n${error.stack}` : ""}`
        : error === undefined
          ? ""
          : ` ${String(error)}`;
    channel.appendLine(`[${stamp}] [${level}] ${message}${detail}`);
  };
  return {
    debug: (message) => write("debug", message),
    info: (message) => write("info", message),
    warn: (message) => write("warn", message),
    error: (message, error) => write("error", message, error),
  };
}

export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
