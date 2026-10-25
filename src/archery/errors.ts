export type ArcheryErrorCode =
  | "network"
  | "tls"
  | "timeout"
  | "auth"
  | "twofa"
  | "api"
  | "query"
  | "cancelled"
  | "unsupported";

export class ArcheryError extends Error {
  readonly code: ArcheryErrorCode;
  readonly status?: number;
  readonly detail?: string;
  readonly hint?: string;
  readonly retryable: boolean;

  constructor(
    code: ArcheryErrorCode,
    message: string,
    options: {
      status?: number;
      detail?: string;
      hint?: string;
      cause?: unknown;
      retryable?: boolean;
    } = {},
  ) {
    super(message);
    this.name = "ArcheryError";
    this.code = code;
    this.status = options.status;
    this.detail = options.detail;
    this.hint = options.hint;
    this.retryable = options.retryable === true;
    if (options.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

export function isArcheryError(error: unknown): error is ArcheryError {
  return error instanceof ArcheryError;
}

export function describeError(error: unknown): string {
  if (isArcheryError(error)) {
    const extra = error.hint ? `\n${error.hint}` : "";
    return `${error.message}${extra}`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
