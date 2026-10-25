import type { HostMessage, RequestPayload, SerializedError } from "../src/webview/protocol";

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

interface Pending {
  resolve: (data: unknown) => void;
  reject: (error: HostError) => void;
}

export class HostError extends Error {
  readonly hint?: string;
  readonly code?: string;
  readonly status?: number;

  constructor(error: SerializedError) {
    super(error.message);
    this.name = "HostError";
    this.hint = error.hint;
    this.code = error.code;
    this.status = error.status;
  }
}

class Bridge {
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<(message: HostMessage) => void>();
  private counter = 0;

  constructor() {
    window.addEventListener("message", (event: MessageEvent<unknown>) => {
      const message = event.data;
      if (!isHostMessage(message)) {
        return;
      }
      if (message.type === "response") {
        const pending = this.pending.get(message.requestId);
        if (!pending) {
          return;
        }
        this.pending.delete(message.requestId);
        if (message.ok) {
          pending.resolve(message.data);
        } else {
          pending.reject(new HostError(message.error ?? { message: "未知错误" }));
        }
        return;
      }
      for (const listener of this.listeners) {
        listener(message);
      }
    });
  }

  onMessage(listener: (message: HostMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  post(message: unknown): void {
    vscode.postMessage(message);
  }

  request<T = unknown>(payload: RequestPayload): Promise<T> {
    const requestId = `req-${Date.now().toString(36)}-${(this.counter++).toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(requestId, {
        resolve: (data) => resolve(data as T),
        reject,
      });
      vscode.postMessage({ ...payload, requestId });
    });
  }

  requestWithId<T = unknown>(payload: RequestPayload): { requestId: string; promise: Promise<T> } {
    const requestId = `req-${Date.now().toString(36)}-${(this.counter++).toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(requestId, {
        resolve: (data) => resolve(data as T),
        reject,
      });
      vscode.postMessage({ ...payload, requestId });
    });
    return { requestId, promise };
  }

  notify(payload: RequestPayload): void {
    const requestId = `fire-${Date.now().toString(36)}-${(this.counter++).toString(36)}`;
    this.pending.set(requestId, {
      resolve: () => undefined,
      reject: () => undefined,
    });
    vscode.postMessage({ ...payload, requestId });
  }

  ready(): void {
    vscode.postMessage({ type: "ready" });
  }

  cancel(targetRequestId: string): void {
    const requestId = `cancel-${Date.now().toString(36)}-${this.counter++}`;
    this.pending.set(requestId, {
      resolve: () => undefined,
      reject: () => undefined,
    });
    vscode.postMessage({ type: "cancelRequest", requestId, targetRequestId });
  }

  getState<T>(): T | undefined {
    return vscode.getState() as T | undefined;
  }

  setState(state: unknown): void {
    vscode.setState(state);
  }
}

function isHostMessage(value: unknown): value is HostMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

export const bridge = new Bridge();
