import { randomBytes } from "node:crypto";
import * as os from "node:os";
import * as vscode from "vscode";
import type {
  ConnectionDraft,
  ExportFormat,
  QueryExecutionRequest,
  WorkbenchSnapshot,
} from "../types";
import { isArcheryError } from "../archery/errors";
import type { Logger } from "../services/logger";
import type { ArcheryService } from "../services/archeryService";
import type { ConnectionStore } from "../services/connectionStore";
import { buildInsertStatements } from "../insertSql";
import { sanitizeTableFilterHistory } from "../filterHistory";
import type { ArcheryTreeProvider } from "../tree/archeryTreeProvider";
import type {
  BootstrapMessage,
  ConnectionFormDraft,
  ConnectionInfo,
  HostMessage,
  OpenQueryContext,
  SerializedError,
  WorkbenchAction,
  WebviewMessage,
  WorkbenchSettings,
} from "./protocol";

const SNAPSHOT_KEY = "archeryQueryStudio.workbench.snapshot.v1";

export interface QueryPanelDependencies {
  context: vscode.ExtensionContext;
  extensionUri: vscode.Uri;
  extensionVersion: string;
  store: ConnectionStore;
  service: ArcheryService;
  tree: () => ArcheryTreeProvider;
  logger: Logger;
  onShowLogs: () => void;
}

interface PanelShowOptions {
  context?: OpenQueryContext;
  action?: WorkbenchAction;
}

export class QueryPanel {
  private panel?: vscode.WebviewPanel;
  private ready = false;
  private pending?: PanelShowOptions;
  private readonly controllers = new Map<string, AbortController>();

  constructor(private readonly deps: QueryPanelDependencies) {}

  async show(options: PanelShowOptions = {}): Promise<void> {
    if (!this.panel) {
      this.create(options);
      return;
    }
    this.panel.reveal(vscode.ViewColumn.One, false);
    if (!this.ready) {
      this.pending = mergeOptions(this.pending, options);
      return;
    }
    if (options.action === "add-connection") {
      this.post({ type: "context", context: {}, action: "add-connection" });
    } else if (options.action === "edit-connection" && options.context?.connectionId) {
      await this.openConnectionForm(options.context.connectionId);
    } else if (options.action === "show-history") {
      this.post({ type: "context", context: {}, action: "show-history" });
    } else if (options.context) {
      this.post({ type: "context", context: options.context });
    }
  }

  async showConnectionForm(connectionId?: string): Promise<void> {
    if (!this.panel || !this.ready) {
      await this.show({
        context: connectionId ? { connectionId } : {},
        action: connectionId ? "edit-connection" : "add-connection",
      });
      return;
    }
    if (connectionId) {
      await this.openConnectionForm(connectionId);
    } else {
      this.post({ type: "context", context: {}, action: "add-connection" });
    }
  }

  showHistory(): void {
    void this.show({ action: "show-history", context: {} });
  }

  notifyConnectionRemoved(connectionId: string): void {
    if (!this.panel || !this.ready) {
      return;
    }
    this.post({ type: "connectionRemoved", connectionId });
  }

  postConnections(): void {
    if (!this.panel || !this.ready) {
      return;
    }
    void this.connectionsInfo()
      .then((connections) => this.post({ type: "connections", connections }))
      .catch((error) => this.deps.logger.warn(`更新连接列表失败：${String(error)}`));
  }

  dispose(): void {
    for (const controller of this.controllers.values()) {
      controller.abort();
    }
    this.controllers.clear();
    this.panel?.dispose();
    this.panel = undefined;
  }

  private create(options: PanelShowOptions): void {
    const panel = vscode.window.createWebviewPanel(
      "archeryQueryStudio.workbench",
      "Archery SQL 工作台",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.deps.extensionUri, "dist")],
      },
    );
    panel.iconPath = vscode.Uri.joinPath(this.deps.extensionUri, "media", "activity.svg");
    this.panel = panel;
    this.ready = false;
    this.pending = options;
    panel.webview.html = this.html(panel.webview);

    panel.webview.onDidReceiveMessage(
      (message: unknown) => void this.onMessage(message),
      undefined,
      [],
    );
    panel.onDidDispose(
      () => {
        for (const controller of this.controllers.values()) {
          controller.abort();
        }
        this.controllers.clear();
        this.panel = undefined;
        this.ready = false;
      },
      undefined,
      [],
    );
  }

  private async onMessage(raw: unknown): Promise<void> {
    if (typeof raw !== "object" || raw === null) {
      return;
    }
    const message = raw as WebviewMessage;
    if (message.type === "ready") {
      this.ready = true;
      const pending = this.pending;
      this.pending = undefined;
      try {
        await this.sendBootstrap(pending);
      } catch (error) {
        this.deps.logger.error("工作台初始化失败", error);
        this.post({ type: "toast", severity: "error", message: `工作台初始化失败：${messageOf(error)}` });
      }
      return;
    }
    if (message.type === "dismissWelcome") {
      return;
    }
    if (!("requestId" in message) || typeof message.requestId !== "string") {
      return;
    }
    if (message.type === "cancelRequest") {
      this.controllers.get(message.targetRequestId)?.abort();
      this.respond(message.requestId, true);
      return;
    }
    try {
      const data = await this.handleRequest(message);
      this.respond(message.requestId, true, data);
    } catch (error) {
      if (!(isArcheryError(error) && error.code === "cancelled")) {
        this.deps.logger.warn(`工作台请求失败 ${message.type}: ${messageOf(error)}`);
      }
      this.respond(message.requestId, false, undefined, serializeError(error));
    }
  }

  private async handleRequest(message: WebviewMessage & { requestId: string }): Promise<unknown> {
    switch (message.type) {
      case "listInstances": {
        const instances = await this.deps.service.listInstances(message.connectionId, message.force);
        return { instances };
      }
      case "listResources": {
        const items = await this.deps.service.listResources(
          message.connectionId,
          message.instanceName,
          message.resourceType,
          {
            dbName: message.dbName,
            schemaName: message.schemaName,
            tableName: message.tableName,
            force: message.force,
          },
        );
        return { items };
      }
      case "queryLogs": {
        const settings = vscode.workspace.getConfiguration("archeryQueryStudio");
        return await this.deps.service.listQueryLogs(message.connectionId, {
          search: message.search,
          limit: message.limit ?? clamp(settings.get<number>("historyLimit", 100), 10, 500),
        });
      }
      case "testConnection": {
        return await this.deps.service.testDraft(this.cleanDraft(message.draft));
      }
      case "saveConnection": {
        const config = await this.deps.store.save(this.cleanDraft(message.draft));
        this.deps.logger.info(`保存连接 ${config.name} (${config.baseUrl})`);
        const connections = await this.connectionsInfo();
        this.post({ type: "connections", connections });
        this.deps.tree().refresh();
        const connection = connections.find((item) => item.id === config.id);
        return connection ? { connection } : {};
      }
      case "deleteConnection": {
        const config = this.deps.store.get(message.connectionId);
        if (!config) {
          throw new Error("连接不存在");
        }
        await this.deps.store.remove(message.connectionId);
        this.deps.service.invalidateConnection(message.connectionId, true);
        this.deps.tree().refresh();
        this.post({ type: "connectionRemoved", connectionId: message.connectionId });
        this.post({ type: "connections", connections: await this.connectionsInfo() });
        return {};
      }
      case "getConnectionDraft": {
        const draft = await this.deps.store.getDraft(message.connectionId);
        if (!draft) {
          throw new Error("连接不存在");
        }
        return { draft: draft as ConnectionFormDraft };
      }
      case "executeQuery": {
        const request = this.validateQuery(message.request);
        const controller = new AbortController();
        this.controllers.set(message.requestId, controller);
        try {
          const result = await this.deps.service.executeQuery(
            message.connectionId,
            request,
            controller.signal,
          );
          return result;
        } finally {
          this.controllers.delete(message.requestId);
        }
      }
      case "describeTable": {
        const controller = new AbortController();
        this.controllers.set(message.requestId, controller);
        try {
          return await this.deps.service.describeTable(
            message.connectionId,
            message.instanceName,
            message.dbName,
            message.tableName,
            message.schemaName,
            controller.signal,
          );
        } finally {
          this.controllers.delete(message.requestId);
        }
      }
      case "exportResult": {
        return await this.exportResult(message);
      }
      case "copyText": {
        await vscode.env.clipboard.writeText(message.text);
        return {};
      }
      case "saveSqlFile": {
        return await this.saveSqlFile(message.sql, message.suggestedName);
      }
      case "openSqlFile": {
        return await this.openSqlFile();
      }
      case "persistState": {
        await this.persistSnapshot(message.snapshot);
        return {};
      }
      case "refreshExplorer": {
        this.deps.service.invalidateAll();
        this.deps.tree().refresh();
        return {};
      }
      case "openSettings": {
        await vscode.commands.executeCommand("workbench.action.openSettings", "archeryQueryStudio");
        return {};
      }
      case "showLogs": {
        this.deps.onShowLogs();
        return {};
      }
      case "openConnectionForm": {
        if (message.connectionId) {
          await this.openConnectionForm(message.connectionId);
        } else {
          this.post({ type: "context", context: {}, action: "add-connection" });
        }
        return {};
      }
      case "showHistory": {
        this.post({ type: "context", context: {}, action: "show-history" });
        return {};
      }
      case "cancelRequest": {
        return {};
      }
      default:
        throw new Error("未知请求");
    }
  }

  private validateQuery(request: QueryExecutionRequest): QueryExecutionRequest {
    if (!request.instanceName) {
      throw new Error("请选择实例");
    }
    if (!request.dbName && request.dbName !== "") {
      throw new Error("请选择数据库");
    }
    if (!request.sql.trim()) {
      throw new Error("SQL 不能为空");
    }
    const limit = Number(request.limit);
    return {
      instanceName: request.instanceName,
      dbName: request.dbName,
      schemaName: request.schemaName ?? "",
      tableName: request.tableName ?? "",
      sql: request.sql,
      limit: Number.isFinite(limit) ? Math.max(0, Math.min(5000, Math.floor(limit))) : 100,
    };
  }

  private cleanDraft(draft: ConnectionFormDraft): ConnectionDraft {
    return {
      id: draft.id,
      name: String(draft.name ?? ""),
      baseUrl: String(draft.baseUrl ?? ""),
      username: String(draft.username ?? ""),
      password: draft.password,
      token: draft.token,
      authMode: draft.authMode === "token" ? "token" : "password",
      allowInsecureTls: Boolean(draft.allowInsecureTls),
    };
  }

  private async openConnectionForm(connectionId: string): Promise<void> {
    try {
      const draft = await this.deps.store.getDraft(connectionId);
      if (!draft) {
        throw new Error("连接不存在");
      }
      this.post({
        type: "context",
        context: {},
        action: "edit-connection",
        connectionDraft: draft as ConnectionFormDraft,
      });
    } catch (error) {
      this.post({ type: "toast", severity: "error", message: messageOf(error) });
    }
  }

  private async sendBootstrap(pending?: PanelShowOptions): Promise<void> {
    const settings = this.settings();
    const connections = await this.connectionsInfo();
    const snapshot = this.readSnapshot();
    let connectionDraft: ConnectionFormDraft | undefined;
    if (pending?.action === "edit-connection" && pending.context?.connectionId) {
      connectionDraft = (await this.deps.store.getDraft(
        pending.context.connectionId,
      )) as ConnectionFormDraft | undefined;
    }
    const message: BootstrapMessage = {
      type: "bootstrap",
      version: this.deps.extensionVersion,
      connections,
      settings,
      snapshot,
      context: pending?.context,
      action: pending?.action,
      connectionDraft,
    };
    this.post(message);
  }

  private async connectionsInfo(): Promise<ConnectionInfo[]> {
    return Promise.all(
      this.deps.store.list().map(async (config) => {
        const secret = await this.deps.store.getSecret(config.id);
        return {
          ...config,
          hasPassword: Boolean(secret.password),
          hasToken: Boolean(secret.token),
        };
      }),
    );
  }

  private settings(): WorkbenchSettings {
    const config = vscode.workspace.getConfiguration("archeryQueryStudio");
    return {
      defaultLimit: clamp(config.get<number>("defaultLimit", 100), 0, 5000),
      allowInsecureTls: config.get<boolean>("allowInsecureTls", false),
    };
  }

  private readSnapshot(): WorkbenchSnapshot | undefined {
    const stored = this.deps.context.globalState.get<WorkbenchSnapshot>(SNAPSHOT_KEY);
    return sanitizeSnapshot(stored);
  }

  private async persistSnapshot(snapshot: WorkbenchSnapshot): Promise<void> {
    const clean = sanitizeSnapshot(snapshot);
    if (!clean) {
      return;
    }
    await this.deps.context.globalState.update(SNAPSHOT_KEY, clean);
  }

  private respond(
    requestId: string,
    ok: boolean,
    data?: unknown,
    error?: SerializedError,
  ): void {
    this.post({ type: "response", requestId, ok, data, error });
  }

  private post(message: HostMessage): void {
    if (!this.panel) {
      return;
    }
    void this.panel.webview.postMessage(message).then((delivered) => {
      if (!delivered) {
        this.deps.logger.debug(`Webview 消息未送达：${message.type}`);
      }
    });
  }

  private async exportResult(message: {
    format: ExportFormat;
    columns: string[];
    rows: unknown[][];
    sql?: string;
    tableName?: string;
    dbName?: string;
    schemaName?: string;
    dbType?: string;
    suggestedName?: string;
  }): Promise<{ path: string }> {
    const format = message.format;
    const extension = format === "csv" ? "csv" : format === "json" ? "json" : "sql";
    const stamp = new Date();
    const fallback = `archery-result-${stamp.toISOString().slice(0, 19).replace(/[T:]/g, "-")}.${extension}`;
    const suggested = sanitizeFileName(message.suggestedName || fallback, extension);
    const defaultUri = this.defaultSaveUri(suggested);
    const picked = await vscode.window.showSaveDialog({
      title: "导出查询结果",
      defaultUri,
      saveLabel: "导出",
      filters: {
        CSV: ["csv"],
        JSON: ["json"],
        "SQL 脚本": ["sql"],
      },
    });
    if (!picked) {
      throw new Error("已取消导出");
    }
    const content =
      format === "csv"
        ? toCsv(message.columns, message.rows)
        : format === "json"
          ? toJson(message.columns, message.rows)
          : toSqlInserts(
              message.columns,
              message.rows,
              message.tableName,
              message.dbName,
              message.schemaName,
              message.dbType,
            );
    await vscode.workspace.fs.writeFile(picked, Buffer.from(content, "utf8"));
    this.post({ type: "exportDone", path: picked.fsPath });
    this.post({ type: "toast", severity: "info", message: `已导出 ${message.rows.length} 行到 ${picked.fsPath}` });
    return { path: picked.fsPath };
  }

  private async saveSqlFile(sql: string, suggestedName?: string): Promise<{ path: string }> {
    const picked = await vscode.window.showSaveDialog({
      title: "保存 SQL",
      defaultUri: this.defaultSaveUri(sanitizeFileName(suggestedName || "query.sql", "sql")),
      saveLabel: "保存",
      filters: { "SQL 脚本": ["sql"] },
    });
    if (!picked) {
      throw new Error("已取消保存");
    }
    await vscode.workspace.fs.writeFile(picked, Buffer.from(sql, "utf8"));
    this.post({ type: "toast", severity: "info", message: `SQL 已保存到 ${picked.fsPath}` });
    return { path: picked.fsPath };
  }

  private async openSqlFile(): Promise<{ name?: string; content?: string }> {
    const picked = await vscode.window.showOpenDialog({
      title: "打开 SQL 文件",
      canSelectMany: false,
      openLabel: "打开",
      filters: { "SQL 脚本": ["sql", "txt"] },
    });
    if (!picked?.[0]) {
      throw new Error("已取消打开");
    }
    const data = await vscode.workspace.fs.readFile(picked[0]);
    if (data.byteLength > 5 * 1024 * 1024) {
      throw new Error("SQL 文件超过 5 MB，无法在编辑器中打开");
    }
    const content = Buffer.from(data).toString("utf8");
    return { name: picked[0].path.split("/").pop(), content };
  }

  private defaultSaveUri(fileName: string): vscode.Uri {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder) {
      return vscode.Uri.joinPath(folder.uri, fileName);
    }
    return vscode.Uri.file(`${os.homedir()}/${fileName}`);
  }

  private html(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.deps.extensionUri, "dist", "webview.js"),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.deps.extensionUri, "dist", "webview.css"),
    );
    const nonce = randomBytes(24).toString("base64");
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource} data:`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Archery SQL 工作台</title>
  <link rel="stylesheet" href="${styleUri}" />
</head>
<body>
  <div id="app" class="app-loading">
    <div class="boot-loading"><span class="spinner"></span><span>正在连接 Archery 工作台…</span></div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function mergeOptions(
  previous: PanelShowOptions | undefined,
  next: PanelShowOptions,
): PanelShowOptions {
  return {
    context: next.context ?? previous?.context,
    action: next.action ?? previous?.action,
  };
}

function serializeError(error: unknown): SerializedError {
  if (isArcheryError(error)) {
    return {
      message: error.message,
      hint: error.hint,
      code: error.code,
      status: error.status,
    };
  }
  if (error instanceof Error) {
    return { message: error.message };
  }
  return { message: String(error) };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sanitizeSnapshot(value: unknown): WorkbenchSnapshot | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.tabs)) {
    return undefined;
  }
  const tabs = record.tabs
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .slice(0, 20)
    .map((item) => ({
      id: String(item.id ?? ""),
      title: String(item.title ?? "查询"),
      connectionId: item.connectionId ? String(item.connectionId) : undefined,
      instanceName: String(item.instanceName ?? ""),
      dbName: String(item.dbName ?? ""),
      schemaName: String(item.schemaName ?? ""),
      sql: String(item.sql ?? "").slice(0, 100_000),
    }))
    .filter((item) => item.id);
  return {
    activeTabId: record.activeTabId ? String(record.activeTabId) : undefined,
    activeConnectionId: record.activeConnectionId ? String(record.activeConnectionId) : undefined,
    tabs,
    tableFilterHistory: sanitizeTableFilterHistory(record.tableFilterHistory),
  };
}

function sanitizeFileName(name: string, extension: string): string {
  const base = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_")
    .trim()
    .slice(0, 180);
  const withExtension = base.toLowerCase().endsWith(`.${extension}`) ? base : `${base}.${extension}`;
  return withExtension || `archery-export.${extension}`;
}

function toCsv(columns: string[], rows: unknown[][]): string {
  const escape = (value: unknown): string => {
    if (value === null || value === undefined) {
      return "";
    }
    const text = typeof value === "object" ? JSON.stringify(value) : String(value);
    return `"${text.replace(/"/g, '""')}"`;
  };
  return `\uFEFF${[columns.map(escape).join(","), ...rows.map((row) => row.map(escape).join(","))].join("\r\n")}\r\n`;
}

function toJson(columns: string[], rows: unknown[][]): string {
  const keys = uniqueKeys(columns);
  return JSON.stringify(
    rows.map((row) => Object.fromEntries(keys.map((key, index) => [key, row[index] ?? null]))),
    null,
    2,
  );
}

function toSqlInserts(
  columns: string[],
  rows: unknown[][],
  tableName?: string,
  dbName?: string,
  schemaName?: string,
  dbType?: string,
): string {
  return buildInsertStatements({
    columns,
    rows,
    tableName,
    dbName,
    schemaName,
    dbType,
    mode: "insert",
    header: true,
  });
}


function uniqueKeys(columns: string[]): string[] {
  const seen = new Map<string, number>();
  return columns.map((column, index) => {
    const base = column || `column_${index + 1}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}_${count + 1}`;
  });
}

function clamp(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : min;
}
