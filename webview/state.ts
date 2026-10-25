import type {
  ArcheryInstance,
  ConnectionConfig,
  QueryExecutionResult,
  QueryLogEntry,
  ResourceItem,
  WorkbenchSnapshot,
} from "../src/types";
import type { ConnectionInfo, WorkbenchSettings } from "../src/webview/protocol";

export type TabStatus = "idle" | "running" | "success" | "error";
export type ResultTab = "results" | "messages" | "history";

export interface QueryErrorInfo {
  message: string;
  hint?: string;
  code?: string;
  status?: number;
}

import type { InsertMode } from "../src/insertSql";
import { sanitizeTableFilterHistory } from "../src/filterHistory";

export interface TableStructureSnapshot {
  columns: string[];
  rows: unknown[][];
  statement?: string;
}

export interface TabState {
  id: string;
  title: string;
  connectionId?: string;
  instanceName: string;
  dbName: string;
  schemaName: string;
  tableName: string;
  dbType: string;
  sql: string;
  limit: number;
  status: TabStatus;
  requestId?: string;
  result?: QueryExecutionResult;
  error?: QueryErrorInfo;
  executedSql?: string;
  columnComments?: Record<string, string>;
  tableStructure?: TableStructureSnapshot;
  startedAt?: number;
  elapsedMs?: number;
  resultTab: ResultTab;
  page: number;
  pageSize: number;
  filter: string;
  columnFilter: string;
  selectedRows: Set<number>;
  hasMoreRows: boolean;
  pageLoading: boolean;
  insertMode: InsertMode;
  sort?: { column: number; direction: 1 | -1 };
  describeStatement?: string;
}

export interface CatalogState {
  instances: ArcheryInstance[];
  instanceName: string;
  databases: ResourceItem[];
  dbName: string;
  schemas: ResourceItem[];
  schemaName: string;
  tables: ResourceItem[];
  instancesLoading: boolean;
  databasesLoading: boolean;
  schemasLoading: boolean;
  tablesLoading: boolean;
  error?: QueryErrorInfo;
  tablesError?: QueryErrorInfo;
}

export interface HistoryState {
  connectionId?: string;
  loading: boolean;
  loaded: boolean;
  error?: QueryErrorInfo;
  entries: QueryLogEntry[];
  total: number;
  search: string;
}

export interface AppState {
  connections: ConnectionInfo[];
  settings: WorkbenchSettings;
  activeConnectionId?: string;
  tabs: TabState[];
  activeTabId?: string;
  catalog: CatalogState;
  history: HistoryState;
  sidebarOpen: boolean;
  catalogVersion: number;
  tableFilterHistory: string[];
}

export function initialState(connections: ConnectionInfo[], settings: WorkbenchSettings): AppState {
  const activeConnectionId = connections[0]?.id;
  return {
    connections,
    settings,
    activeConnectionId,
    tabs: [],
    activeTabId: undefined,
    catalog: emptyCatalog(),
    history: emptyHistory(),
    sidebarOpen: true,
    catalogVersion: 0,
    tableFilterHistory: [],
  };
}

export function emptyCatalog(): CatalogState {
  return {
    instances: [],
    instanceName: "",
    databases: [],
    dbName: "",
    schemas: [],
    schemaName: "",
    tables: [],
    instancesLoading: false,
    databasesLoading: false,
    schemasLoading: false,
    tablesLoading: false,
  };
}

export function emptyHistory(): HistoryState {
  return {
    loading: false,
    loaded: false,
    entries: [],
    total: 0,
    search: "",
  };
}

let tabCounter = 0;

export function createTab(
  state: AppState,
  input: {
    connectionId?: string;
    instanceName?: string;
    dbName?: string;
    schemaName?: string;
    tableName?: string;
    dbType?: string;
    sql?: string;
    title?: string;
    limit?: number;
  } = {},
): TabState {
  tabCounter += 1;
  const titleBase = input.tableName || input.dbName || input.instanceName;
  return {
    id: `tab-${Date.now().toString(36)}-${tabCounter.toString(36)}`,
    title: input.title || titleBase || `查询 ${state.tabs.length + 1}`,
    connectionId: input.connectionId ?? state.activeConnectionId,
    instanceName: input.instanceName ?? "",
    dbName: input.dbName ?? "",
    schemaName: input.schemaName ?? "",
    tableName: input.tableName ?? "",
    dbType: input.dbType ?? "",
    sql: input.sql ?? "",
    limit: input.limit ?? state.settings.defaultLimit,
    status: "idle",
    resultTab: "results",
    page: 0,
    pageSize: 100,
    filter: "",
    columnFilter: "",
    selectedRows: new Set<number>(),
    hasMoreRows: false,
    pageLoading: false,
    insertMode: "insert",
  };
}

export function activeTab(state: AppState): TabState | undefined {
  return state.tabs.find((tab) => tab.id === state.activeTabId);
}

export function activeConnection(state: AppState): ConnectionInfo | undefined {
  return state.connections.find((connection) => connection.id === state.activeConnectionId);
}

export function tabConnection(state: AppState, tab: TabState): ConnectionInfo | undefined {
  return state.connections.find((connection) => connection.id === tab.connectionId);
}

export function restoreTabs(snapshot: WorkbenchSnapshot | undefined, state: AppState): TabState[] {
  if (!snapshot?.tabs?.length) {
    return [];
  }
  return snapshot.tabs.slice(0, 40).map((saved, index) => ({
    ...createTab(state, {
      connectionId: saved.connectionId,
      instanceName: saved.instanceName,
      dbName: saved.dbName,
      schemaName: saved.schemaName,
      sql: saved.sql,
      title: saved.title || `查询 ${index + 1}`,
    }),
    id: saved.id,
  }));
}

export function toSnapshot(state: AppState): WorkbenchSnapshot {
  return {
    activeTabId: state.activeTabId,
    activeConnectionId: state.activeConnectionId,
    tabs: state.tabs.map((tab) => ({
      id: tab.id,
      title: tab.title,
      connectionId: tab.connectionId,
      instanceName: tab.instanceName,
      dbName: tab.dbName,
      schemaName: tab.schemaName,
      sql: tab.sql,
    })),
    tableFilterHistory: sanitizeTableFilterHistory(state.tableFilterHistory),
  };
}

export function connectionLabel(connection: ConnectionConfig | undefined): string {
  return connection?.name ?? "未选择连接";
}

export function isSchemaDbType(dbType: string | undefined): boolean {
  return new Set([
    "postgresql",
    "postgres",
    "pgsql",
    "gaussdb",
    "greenplum",
    "opengauss",
    "kingbase",
    "highgo",
  ]).has((dbType ?? "").toLowerCase());
}

export function tabContextLabel(tab: TabState): string {
  return [tab.instanceName, tab.dbName, tab.schemaName].filter(Boolean).join(" / ");
}

export function resultRowCount(tab: TabState): number {
  return tab.result?.rows.length ?? 0;
}

export function queryTabTitle(tab: TabState): string {
  if (tab.title) {
    return tab.title;
  }
  return tab.tableName || tab.dbName || "查询";
}
