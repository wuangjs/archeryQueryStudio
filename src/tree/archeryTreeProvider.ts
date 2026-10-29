import * as vscode from "vscode";
import type { ArcheryInstance, ResourceItem } from "../types";
import { ArcheryService } from "../services/archeryService";
import { ConnectionStore } from "../services/connectionStore";
import { isArcheryError } from "../archery/errors";

export type NodeKind =
  | "connection"
  | "instance"
  | "database"
  | "schema"
  | "table"
  | "column"
  | "empty"
  | "error";

export interface ArcheryNodeData {
  kind: NodeKind;
  label: string;
  connectionId: string;
  connectionName: string;
  instanceName?: string;
  dbName?: string;
  schemaName?: string;
  tableName?: string;
  dbType?: string;
  description?: string;
  detail?: string;
  raw?: unknown;
  parent?: ArcheryNode;
}

export class ArcheryNode {
  readonly kind: NodeKind;
  readonly label: string;
  readonly connectionId: string;
  readonly connectionName: string;
  readonly instanceName?: string;
  readonly dbName?: string;
  readonly schemaName?: string;
  readonly tableName?: string;
  readonly dbType?: string;
  readonly description?: string;
  readonly detail?: string;
  readonly raw?: unknown;
  readonly parent?: ArcheryNode;

  constructor(data: ArcheryNodeData) {
    this.kind = data.kind;
    this.label = data.label;
    this.connectionId = data.connectionId;
    this.connectionName = data.connectionName;
    this.instanceName = data.instanceName;
    this.dbName = data.dbName;
    this.schemaName = data.schemaName;
    this.tableName = data.tableName;
    this.dbType = data.dbType;
    this.description = data.description;
    this.detail = data.detail;
    this.raw = data.raw;
    this.parent = data.parent;
  }

  get contextValue(): string {
    return `archery.${this.kind}`;
  }

  get collapsible(): vscode.TreeItemCollapsibleState {
    switch (this.kind) {
      case "connection":
      case "instance":
      case "database":
      case "schema":
      case "table":
        return vscode.TreeItemCollapsibleState.Collapsed;
      default:
        return vscode.TreeItemCollapsibleState.None;
    }
  }
}

const SCHEMA_DB_TYPES = new Set([
  "postgresql",
  "postgres",
  "gaussdb",
  "greenplum",
  "opengauss",
  "kingbase",
  "highgo",
]);

export class ArcheryTreeProvider
  implements vscode.TreeDataProvider<ArcheryNode>, vscode.Disposable
{
  private readonly emitter = new vscode.EventEmitter<ArcheryNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly cache = new Map<string, unknown>();
  private readonly storeSubscription: vscode.Disposable;

  constructor(
    private readonly service: ArcheryService,
    private readonly store: ConnectionStore,
  ) {
    this.storeSubscription = store.onDidChange(() => this.refresh());
  }

  dispose(): void {
    this.storeSubscription.dispose();
    this.emitter.dispose();
  }

  refresh(): void {
    this.cache.clear();
    this.emitter.fire(undefined);
  }

  refreshNode(node?: ArcheryNode): void {
    if (!node) {
      this.refresh();
      return;
    }
    const target = node.kind === "error" && node.parent ? node.parent : node;
    this.clearCacheFor(target);
    this.service.clearCache(target.connectionId);
    this.emitter.fire(target);
  }

  getTreeItem(node: ArcheryNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.label, node.collapsible);
    item.id = this.nodeId(node);
    item.contextValue = node.contextValue;
    item.description = node.description;
    item.tooltip = node.detail ?? node.description ?? node.label;
    item.iconPath = iconFor(node);
    if (node.kind === "error" || node.kind === "empty") {
      item.command = {
        command: "archeryQueryStudio.refreshNode",
        title: "重试",
        arguments: [node],
      };
    }
    return item;
  }

  async getChildren(node?: ArcheryNode): Promise<ArcheryNode[]> {
    if (!node) {
      return this.store.list().map((config) => {
        let host = config.baseUrl;
        try {
          host = new URL(config.baseUrl).host;
        } catch {
          // Keep the raw address when it is malformed; editing will surface the error.
        }
        return new ArcheryNode({
          kind: "connection",
          label: config.name,
          connectionId: config.id,
          connectionName: config.name,
          description: host,
          detail: `Archery：${config.baseUrl}\n用户：${config.username}\n认证：${config.authMode === "token" ? "访问令牌" : "用户名密码"}`,
        });
      });
    }
    switch (node.kind) {
      case "connection":
        return this.loadInstances(node);
      case "instance":
        return this.loadDatabases(node);
      case "database":
        return SCHEMA_DB_TYPES.has((node.dbType ?? "").toLowerCase())
          ? this.loadSchemas(node)
          : this.loadTables(node);
      case "schema":
        return this.loadTables(node);
      case "table":
        return this.loadColumns(node);
      default:
        return [];
    }
  }

  private async loadInstances(node: ArcheryNode): Promise<ArcheryNode[]> {
    const key = `instances:${node.connectionId}`;
    try {
      const instances = await this.cached(key, () => this.service.listInstances(node.connectionId));
      if (instances.length === 0) {
        return [
          new ArcheryNode({
            kind: "empty",
            label: "当前账号没有可访问实例",
            connectionId: node.connectionId,
            connectionName: node.connectionName,
            detail: "请让 Archery 管理员为你的账号关联资源组或实例查询权限。",
            parent: node,
          }),
        ];
      }
      return instances.map((instance) =>
        new ArcheryNode({
          kind: "instance",
          label: instance.instance_name,
          connectionId: node.connectionId,
          connectionName: node.connectionName,
          instanceName: instance.instance_name,
          dbType: instance.db_type,
          description: instanceLabel(instance),
          detail: [
            `实例：${instance.instance_name}`,
            `类型：${instance.db_type}`,
            instance.type ? `角色：${instance.type}` : "",
            instance.id !== undefined ? `ID：${instance.id}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
          raw: instance,
          parent: node,
        }),
      );
    } catch (error) {
      return [this.errorNode(error, node, "无法加载实例")];
    }
  }

  private async loadDatabases(node: ArcheryNode): Promise<ArcheryNode[]> {
    const key = this.resourceKey(node, "database");
    try {
      const items = await this.cached(key, () =>
        this.service.listResources(node.connectionId, node.instanceName ?? "", "database"),
      );
      if (items.length === 0) {
        return [
          new ArcheryNode({
            kind: "empty",
            label: "没有可访问的数据库",
            connectionId: node.connectionId,
            connectionName: node.connectionName,
            instanceName: node.instanceName,
            dbType: node.dbType,
            detail: "该实例下没有可见数据库，或 Archery 未配置数据库名称过滤规则。",
            parent: node,
          }),
        ];
      }
      const databases = items.map((item) =>
        new ArcheryNode({
          kind: "database",
          label: item.displayName ?? item.name,
          connectionId: node.connectionId,
          connectionName: node.connectionName,
          instanceName: node.instanceName,
          dbName: item.name,
          dbType: node.dbType,
          raw: item.raw,
          parent: node,
        }),
      );
      return databases;
    } catch (error) {
      return [this.errorNode(error, node, "无法加载数据库")];
    }
  }

  private async loadSchemas(node: ArcheryNode): Promise<ArcheryNode[]> {
    const key = this.resourceKey(node, "schema");
    try {
      const items = await this.cached(key, () =>
        this.service.listResources(
          node.connectionId,
          node.instanceName ?? "",
          "schema",
          { dbName: node.dbName },
        ),
      );
      if (items.length === 0) {
        return this.loadTables(node);
      }
      return items.map((item) =>
        new ArcheryNode({
          kind: "schema",
          label: item.name,
          connectionId: node.connectionId,
          connectionName: node.connectionName,
          instanceName: node.instanceName,
          dbName: node.dbName,
          schemaName: item.name,
          dbType: node.dbType,
          raw: item.raw,
          parent: node,
        }),
      );
    } catch (error) {
      return [this.errorNode(error, node, "无法加载 schema")];
    }
  }

  private async loadTables(node: ArcheryNode): Promise<ArcheryNode[]> {
    const key = this.resourceKey(node, "table");
    try {
      const items = await this.cached(key, () =>
        this.service.listResources(
          node.connectionId,
          node.instanceName ?? "",
          "table",
          { dbName: node.dbName, schemaName: node.schemaName },
        ),
      );
      if (items.length === 0) {
        return [
          new ArcheryNode({
            kind: "empty",
            label: "没有数据表",
            connectionId: node.connectionId,
            connectionName: node.connectionName,
            instanceName: node.instanceName,
            dbName: node.dbName,
            schemaName: node.schemaName,
            dbType: node.dbType,
            detail: "该数据库/schema 下没有可见的数据表或视图。",
            parent: node,
          }),
        ];
      }
      return items.map((item) =>
        new ArcheryNode({
          kind: "table",
          label: item.name,
          connectionId: node.connectionId,
          connectionName: node.connectionName,
          instanceName: node.instanceName,
          dbName: node.dbName,
          schemaName: node.schemaName,
          tableName: item.name,
          dbType: node.dbType,
          detail: [
            `表：${item.name}`,
            node.dbName ? `数据库：${node.dbName}` : "",
            node.schemaName ? `Schema：${node.schemaName}` : "",
            "使用右键菜单新建查询 / 查询前 100 行 / 查看表结构。",
          ]
            .filter(Boolean)
            .join("\n"),
          raw: item.raw,
          parent: node,
        }),
      );
    } catch (error) {
      return [this.errorNode(error, node, "无法加载数据表")];
    }
  }

  private async loadColumns(node: ArcheryNode): Promise<ArcheryNode[]> {
    const key = this.resourceKey(node, "column");
    try {
      const items = await this.cached(key, () =>
        this.service.listResources(
          node.connectionId,
          node.instanceName ?? "",
          "column",
          {
            dbName: node.dbName,
            schemaName: node.schemaName,
            tableName: node.tableName,
          },
        ),
      );
      return items.map((item) => {
        const info = columnInfo(item);
        return new ArcheryNode({
          kind: "column",
          label: info.name,
          description: info.type,
          connectionId: node.connectionId,
          connectionName: node.connectionName,
          instanceName: node.instanceName,
          dbName: node.dbName,
          schemaName: node.schemaName,
          tableName: node.tableName,
          dbType: node.dbType,
          raw: item.raw,
          detail: info.detail,
          parent: node,
        });
      });
    } catch (error) {
      return [this.errorNode(error, node, "无法加载列信息")];
    }
  }

  private errorNode(error: unknown, parent: ArcheryNode, prefix: string): ArcheryNode {
    const message = isArcheryError(error)
      ? [error.message, error.hint].filter(Boolean).join(" ")
      : error instanceof Error
        ? error.message
        : String(error);
    return new ArcheryNode({
      kind: "error",
      label: `${prefix}：${truncate(message, 90)}`,
      connectionId: parent.connectionId,
      connectionName: parent.connectionName,
      instanceName: parent.instanceName,
      dbName: parent.dbName,
      schemaName: parent.schemaName,
      tableName: parent.tableName,
      dbType: parent.dbType,
      detail: `点击重试。\n\n${message}`,
      parent,
    });
  }

  private resourceKey(node: ArcheryNode, type: string): string {
    return [
      "resource",
      node.connectionId,
      node.instanceName ?? "",
      type,
      node.dbName ?? "",
      node.schemaName ?? "",
      node.tableName ?? "",
    ].join("\u0000");
  }

  private async cached<T>(key: string, loader: () => Promise<T>): Promise<T> {
    if (this.cache.has(key)) {
      return this.cache.get(key) as T;
    }
    const value = await loader();
    this.cache.set(key, value);
    return value;
  }

  private clearCacheFor(_node: ArcheryNode): void {
    // Resource cache keys differ by resource type, so the safest refresh is to
    // drop the whole provider cache. The service itself only drops one connection.
    this.cache.clear();
  }

  private nodeId(node: ArcheryNode): string {
    return [
      node.kind,
      node.connectionId,
      node.instanceName ?? "",
      node.dbName ?? "",
      node.schemaName ?? "",
      node.tableName ?? "",
      node.label,
    ].join(":");
  }
}

function iconFor(node: ArcheryNode): vscode.ThemeIcon {
  switch (node.kind) {
    case "connection":
      return new vscode.ThemeIcon("plug");
    case "instance":
      return new vscode.ThemeIcon("server");
    case "database":
      return new vscode.ThemeIcon("database");
    case "schema":
      return new vscode.ThemeIcon("symbol-namespace");
    case "table":
      return new vscode.ThemeIcon("table");
    case "column":
      return new vscode.ThemeIcon("symbol-field");
    case "error":
      return new vscode.ThemeIcon("error", new vscode.ThemeColor("errorForeground"));
    case "empty":
      return new vscode.ThemeIcon("info");
  }
}

function instanceLabel(instance: ArcheryInstance): string {
  const role =
    instance.type === "master"
      ? "主库"
      : instance.type === "slave"
        ? "从库"
        : instance.type
          ? String(instance.type)
          : "";
  return [instance.db_type, role].filter(Boolean).join(" · ");
}

function columnInfo(item: ResourceItem): { name: string; type: string; detail: string } {
  const raw = item.raw;
  if (Array.isArray(raw)) {
    const name = String(raw[0] ?? item.name);
    const type = [raw[1], raw[3], raw[4]].filter((v) => v !== undefined && v !== null).join(" ");
    return {
      name,
      type: String(type || ""),
      detail: raw
        .map((value, index) => `字段 ${index + 1}: ${formatValue(value)}`)
        .join("\n"),
    };
  }
  if (isRecord(raw)) {
    const name = String(raw.Field ?? raw.name ?? raw.column_name ?? raw.COLUMN_NAME ?? item.name);
    const type = String(
      raw.Type ?? raw.type ?? raw.column_type ?? raw.COLUMN_TYPE ?? raw.data_type ?? "",
    );
    const extra = String(raw.Extra ?? raw.extra ?? raw.column_default ?? raw.COLUMN_DEFAULT ?? "");
    const detail = Object.entries(raw)
      .map(([key, value]) => `${key}: ${formatValue(value)}`)
      .join("\n");
    return { name, type: [type, extra].filter(Boolean).join(" · "), detail };
  }
  return { name: item.name, type: "", detail: formatValue(raw) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatValue(value: unknown): string {
  if (value === null) {
    return "NULL";
  }
  if (value === undefined) {
    return "";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

function truncate(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length)}…` : value;
}
