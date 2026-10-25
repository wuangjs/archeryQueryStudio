import * as vscode from "vscode";
import type {
  ArcheryInstance,
  ConnectionDraft,
  ConnectionHealth,
  QueryExecutionRequest,
  QueryExecutionResult,
  QueryLogPage,
  ResourceItem,
  TableDescription,
} from "../types";
import { ArcheryClient } from "../archery/client";
import { isArcheryError } from "../archery/errors";
import type { Logger } from "./logger";
import { ConnectionStore, normalizeBaseUrl } from "./connectionStore";

interface ClientEntry {
  signature: string;
  client: ArcheryClient;
}

interface CacheEntry<T> {
  at: number;
  value: T;
}

const CACHE_TTL_MS = 45_000;

export class ArcheryService implements vscode.Disposable {
  private readonly clients = new Map<string, ClientEntry>();
  private readonly instanceCache = new Map<string, CacheEntry<ArcheryInstance[]>>();
  private readonly resourceCache = new Map<string, CacheEntry<ResourceItem[]>>();
  private readonly disposable: vscode.Disposable;

  constructor(
    private readonly store: ConnectionStore,
    private readonly logger: Logger,
  ) {
    this.disposable = store.onDidChange(() => {
      for (const entry of this.clients.values()) {
        entry.client.dispose();
      }
      this.clients.clear();
      this.clearCache();
    });
  }

  async listInstances(connectionId: string, force = false): Promise<ArcheryInstance[]> {
    const cached = this.instanceCache.get(connectionId);
    if (!force && cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return cached.value;
    }
    const client = await this.getClient(connectionId);
    try {
      const value = await client.listInstances();
      this.instanceCache.set(connectionId, { at: Date.now(), value });
      void this.store.markUsed(connectionId);
      return value;
    } catch (error) {
      this.invalidateClient(connectionId, error);
      throw error;
    }
  }

  async listResources(
    connectionId: string,
    instanceName: string,
    resourceType: "database" | "schema" | "table" | "column",
    options: {
      dbName?: string;
      schemaName?: string;
      tableName?: string;
      force?: boolean;
      signal?: AbortSignal;
    } = {},
  ): Promise<ResourceItem[]> {
    const key = [
      connectionId,
      instanceName,
      resourceType,
      options.dbName ?? "",
      options.schemaName ?? "",
      options.tableName ?? "",
    ].join("\u0000");
    const cached = this.resourceCache.get(key);
    if (!options.force && cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return cached.value;
    }
    const client = await this.getClient(connectionId);
    try {
      const value = await client.listResources(instanceName, resourceType, options);
      this.resourceCache.set(key, { at: Date.now(), value });
      return value;
    } catch (error) {
      this.invalidateClient(connectionId, error);
      throw error;
    }
  }

  async executeQuery(
    connectionId: string,
    request: QueryExecutionRequest,
    signal?: AbortSignal,
  ): Promise<QueryExecutionResult> {
    const client = await this.getClient(connectionId);
    try {
      return await client.executeQuery(request, signal);
    } catch (error) {
      this.invalidateClient(connectionId, error);
      throw error;
    }
  }

  async describeTable(
    connectionId: string,
    instanceName: string,
    dbName: string,
    tableName: string,
    schemaName = "",
    signal?: AbortSignal,
  ): Promise<TableDescription> {
    const client = await this.getClient(connectionId);
    try {
      return await client.describeTable(instanceName, dbName, tableName, schemaName, signal);
    } catch (error) {
      this.invalidateClient(connectionId, error);
      throw error;
    }
  }

  async listQueryLogs(
    connectionId: string,
    options: { limit?: number; offset?: number; search?: string; signal?: AbortSignal } = {},
  ): Promise<QueryLogPage> {
    const client = await this.getClient(connectionId);
    try {
      return await client.listQueryLogs(options);
    } catch (error) {
      this.invalidateClient(connectionId, error);
      throw error;
    }
  }

  async testDraft(draft: ConnectionDraft): Promise<ConnectionHealth> {
    const existing = draft.id ? await this.store.getDraft(draft.id) : undefined;
    const baseUrl = normalizeBaseUrl(draft.baseUrl);
    const password = draft.password !== undefined ? draft.password : existing?.password;
    const token = draft.token !== undefined ? draft.token : existing?.token;
    if (draft.authMode === "password" && !password) {
      throw new Error("请先填写密码再测试连接");
    }
    if (draft.authMode === "token" && !token) {
      throw new Error("请先填写访问令牌再测试连接");
    }
    const client = this.createClient({
      baseUrl,
      username: draft.username.trim(),
      authMode: draft.authMode,
      password,
      token,
      allowInsecureTls: draft.allowInsecureTls,
    });
    try {
      return await client.testConnection();
    } finally {
      client.dispose();
    }
  }

  async testStoredConnection(connectionId: string): Promise<ConnectionHealth> {
    const client = await this.getClient(connectionId);
    return client.testConnection();
  }

  clearCache(connectionId?: string): void {
    if (!connectionId) {
      this.instanceCache.clear();
      this.resourceCache.clear();
      return;
    }
    for (const key of this.instanceCache.keys()) {
      if (key === connectionId) {
        this.instanceCache.delete(key);
      }
    }
    for (const key of this.resourceCache.keys()) {
      if (key.startsWith(`${connectionId}\u0000`)) {
        this.resourceCache.delete(key);
      }
    }
  }

  invalidateAll(): void {
    for (const entry of this.clients.values()) {
      entry.client.dispose();
    }
    this.clients.clear();
    this.clearCache();
  }

  invalidateConnection(connectionId: string, dispose = false): void {
    if (dispose) {
      const entry = this.clients.get(connectionId);
      entry?.client.dispose();
      this.clients.delete(connectionId);
    }
    this.clearCache(connectionId);
  }

  dispose(): void {
    for (const entry of this.clients.values()) {
      entry.client.dispose();
    }
    this.clients.clear();
    this.disposable.dispose();
  }

  private async getClient(connectionId: string): Promise<ArcheryClient> {
    const config = this.store.get(connectionId);
    if (!config) {
      throw new Error("连接不存在，可能已被删除");
    }
    const secret = await this.store.getSecret(connectionId);
    const settings = getSettings();
    const signature = JSON.stringify([
      config.baseUrl,
      config.username,
      config.authMode,
      config.allowInsecureTls,
      secret.password,
      secret.token,
      settings.timeoutSeconds,
    ]);
    const existing = this.clients.get(connectionId);
    if (existing?.signature === signature) {
      return existing.client;
    }
    existing?.client.dispose();
    const client = this.createClient({
      baseUrl: config.baseUrl,
      username: config.username,
      authMode: config.authMode,
      password: secret.password,
      token: secret.token,
      allowInsecureTls: config.allowInsecureTls || settings.allowInsecureTls,
    });
    this.clients.set(connectionId, { signature, client });
    return client;
  }

  private createClient(input: {
    baseUrl: string;
    username: string;
    authMode: "password" | "token";
    password?: string;
    token?: string;
    allowInsecureTls: boolean;
  }): ArcheryClient {
    const settings = getSettings();
    return new ArcheryClient({
      baseUrl: input.baseUrl,
      username: input.username,
      authMode: input.authMode,
      password: input.password,
      token: input.token,
      allowInsecureTls: input.allowInsecureTls,
      timeoutMs: settings.timeoutSeconds * 1000,
      logger: this.logger,
    });
  }

  private invalidateClient(connectionId: string, error: unknown): void {
    if (isArcheryError(error) && (error.code === "auth" || error.code === "network" || error.code === "timeout")) {
      this.invalidateConnection(connectionId, true);
    }
  }
}

export interface ArcherySettings {
  defaultLimit: number;
  timeoutSeconds: number;
  historyLimit: number;
  allowInsecureTls: boolean;
}

export function getSettings(): ArcherySettings {
  const config = vscode.workspace.getConfiguration("archeryQueryStudio");
  return {
    defaultLimit: clamp(config.get<number>("defaultLimit", 100), 0, 5000),
    timeoutSeconds: clamp(config.get<number>("requestTimeout", 120), 10, 1800),
    historyLimit: clamp(config.get<number>("historyLimit", 100), 10, 500),
    allowInsecureTls: config.get<boolean>("allowInsecureTls", false),
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
}
