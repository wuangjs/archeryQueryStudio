import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import type {
  AuthMode,
  ConnectionConfig,
  ConnectionDraft,
  ConnectionSecret,
} from "../types";

const CONNECTIONS_KEY = "archeryQueryStudio.connections.v1";
const SECRET_PREFIX = "archeryQueryStudio.secret.";

export class ConnectionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectionValidationError";
  }
}

export class ConnectionStore implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;
  private connections: ConnectionConfig[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {
    this.load();
  }

  list(): ConnectionConfig[] {
    return [...this.connections].sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  }

  get(id: string): ConnectionConfig | undefined {
    return this.connections.find((item) => item.id === id);
  }

  async save(draft: ConnectionDraft): Promise<ConnectionConfig> {
    const normalized = this.normalizeDraft(draft);
    const existing = draft.id ? this.get(draft.id) : undefined;
    const now = Date.now();
    const config: ConnectionConfig = {
      id: existing?.id ?? randomUUID(),
      name: normalized.name,
      baseUrl: normalized.baseUrl,
      username: normalized.username,
      authMode: normalized.authMode,
      allowInsecureTls: normalized.allowInsecureTls,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastUsedAt: existing?.lastUsedAt,
    };

    const oldSecret = existing ? await this.getSecret(existing.id) : undefined;
    if (normalized.authMode === "password" && !normalized.password && !oldSecret?.password) {
      throw new ConnectionValidationError("请填写 Archery 登录密码");
    }
    if (normalized.authMode === "token" && !normalized.token && !oldSecret?.token) {
      throw new ConnectionValidationError("请填写 Archery 访问令牌");
    }

    this.connections = existing
      ? this.connections.map((item) => (item.id === existing.id ? config : item))
      : [...this.connections, config];
    await this.context.globalState.update(CONNECTIONS_KEY, this.connections);

    if (normalized.password !== undefined) {
      await this.setSecret(config.id, "password", normalized.password);
    }
    if (normalized.token !== undefined) {
      await this.setSecret(config.id, "token", normalized.token);
    }
    if (normalized.authMode === "password" && normalized.token === "") {
      await this.setSecret(config.id, "token", undefined);
    }
    if (normalized.authMode === "token" && normalized.password === "") {
      await this.setSecret(config.id, "password", undefined);
    }
    this.changeEmitter.fire();
    return config;
  }

  async remove(id: string): Promise<void> {
    const existing = this.get(id);
    if (!existing) {
      return;
    }
    this.connections = this.connections.filter((item) => item.id !== id);
    await this.context.globalState.update(CONNECTIONS_KEY, this.connections);
    await Promise.all([
      this.setSecret(id, "password", undefined),
      this.setSecret(id, "token", undefined),
    ]);
    this.changeEmitter.fire();
  }

  async getSecret(id: string): Promise<ConnectionSecret> {
    const [password, token] = await Promise.all([
      this.context.secrets.get(this.secretKey(id, "password")),
      this.context.secrets.get(this.secretKey(id, "token")),
    ]);
    return { password, token };
  }

  async getDraft(id: string): Promise<(ConnectionDraft & { hasPassword: boolean; hasToken: boolean }) | undefined> {
    const config = this.get(id);
    if (!config) {
      return undefined;
    }
    const secret = await this.getSecret(id);
    return {
      ...config,
      hasPassword: Boolean(secret.password),
      hasToken: Boolean(secret.token),
    };
  }

  async markUsed(id: string): Promise<void> {
    const config = this.get(id);
    if (!config) {
      return;
    }
    config.lastUsedAt = Date.now();
    await this.context.globalState.update(CONNECTIONS_KEY, this.connections);
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }

  private load(): void {
    const stored = this.context.globalState.get<unknown>(CONNECTIONS_KEY);
    if (!Array.isArray(stored)) {
      this.connections = [];
      return;
    }
    this.connections = stored
      .map((value): ConnectionConfig | undefined => {
        if (!isRecord(value)) {
          return undefined;
        }
        const id = stringValue(value.id);
        const name = stringValue(value.name);
        const baseUrl = stringValue(value.baseUrl);
        const username = stringValue(value.username);
        if (!id || !name || !baseUrl || !username) {
          return undefined;
        }
        const authMode: AuthMode = value.authMode === "token" ? "token" : "password";
        return {
          id,
          name,
          baseUrl,
          username,
          authMode,
          allowInsecureTls: value.allowInsecureTls === true,
          createdAt: numberValue(value.createdAt) ?? Date.now(),
          updatedAt: numberValue(value.updatedAt) ?? Date.now(),
          lastUsedAt: numberValue(value.lastUsedAt),
        };
      })
      .filter((item): item is ConnectionConfig => Boolean(item));
  }

  private normalizeDraft(draft: ConnectionDraft): {
    name: string;
    baseUrl: string;
    username: string;
    authMode: AuthMode;
    allowInsecureTls: boolean;
    password?: string;
    token?: string;
  } {
    const username = draft.username.trim();
    if (!username) {
      throw new ConnectionValidationError("用户名不能为空");
    }
    const baseUrl = normalizeBaseUrl(draft.baseUrl);
    const name = draft.name.trim() || new URL(baseUrl).hostname;
    const authMode: AuthMode = draft.authMode === "token" ? "token" : "password";
    const password = draft.password === undefined ? undefined : draft.password;
    const token = draft.token === undefined ? undefined : draft.token.trim();
    if (authMode === "password" && password !== undefined && !password) {
      throw new ConnectionValidationError("密码不能为空");
    }
    if (authMode === "token" && token !== undefined && !token) {
      throw new ConnectionValidationError("访问令牌不能为空");
    }
    return {
      name,
      baseUrl,
      username,
      authMode,
      allowInsecureTls: Boolean(draft.allowInsecureTls),
      password,
      token,
    };
  }

  private secretKey(id: string, kind: "password" | "token"): string {
    return `${SECRET_PREFIX}${id}.${kind}`;
  }

  private async setSecret(
    id: string,
    kind: "password" | "token",
    value: string | undefined,
  ): Promise<void> {
    const key = this.secretKey(id, kind);
    if (value === undefined || value === "") {
      await this.context.secrets.delete(key);
    } else {
      await this.context.secrets.store(key, value);
    }
  }
}

export function normalizeBaseUrl(input: string): string {
  let value = input.trim();
  if (!value) {
    throw new ConnectionValidationError("Archery 地址不能为空");
  }
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(value)) {
    value = `https://${value}`;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConnectionValidationError("Archery 地址格式不正确");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConnectionValidationError("Archery 地址只支持 http:// 或 https://");
  }
  url.hash = "";
  url.search = "";
  url.username = "";
  url.password = "";
  let pathname = url.pathname.replace(/\/+$/, "");
  if (pathname.endsWith("/login")) {
    pathname = pathname.slice(0, -6);
  }
  return `${url.origin}${pathname === "/" ? "" : pathname}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
