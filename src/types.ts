export type AuthMode = "password" | "token";
export type ApiStyle = "v1" | "legacy";

export interface ConnectionConfig {
  id: string;
  name: string;
  baseUrl: string;
  username: string;
  authMode: AuthMode;
  allowInsecureTls: boolean;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
}

export interface ConnectionSecret {
  password?: string;
  token?: string;
}

export interface ConnectionDraft {
  id?: string;
  name: string;
  baseUrl: string;
  username: string;
  password?: string;
  token?: string;
  authMode: AuthMode;
  allowInsecureTls: boolean;
}

export interface ArcheryInstance {
  id?: number;
  instance_name: string;
  db_type: string;
  type?: string;
  [key: string]: unknown;
}

export interface ResourceItem {
  name: string;
  raw: unknown;
}

export interface QueryExecutionRequest {
  instanceName: string;
  dbName: string;
  sql: string;
  limit: number;
  schemaName?: string;
  tableName?: string;
}

export interface QueryExecutionResult {
  columns: string[];
  rows: unknown[][];
  queryTime?: number;
  maskTime?: number;
  secondsBehindMaster?: number;
  fullSql?: string;
  affectedRows?: number;
  message?: string;
  raw: Record<string, unknown>;
}

export interface QueryLogEntry {
  id: number;
  instanceName: string;
  dbName: string;
  sql: string;
  effectRow?: number;
  costTime?: number;
  userDisplay?: string;
  favorite?: boolean;
  alias?: string;
  createTime?: string;
}

export interface QueryLogPage {
  total: number;
  rows: QueryLogEntry[];
}

export interface TableDescription {
  result: QueryExecutionResult;
  statement?: string;
}

export interface ConnectionHealth {
  ok: boolean;
  apiStyle: ApiStyle;
  instanceCount: number;
  username: string;
  message: string;
}

export interface QueryTabSnapshot {
  id: string;
  title: string;
  connectionId?: string;
  instanceName: string;
  dbName: string;
  schemaName: string;
  sql: string;
}

export interface WorkbenchSnapshot {
  activeTabId?: string;
  tabs: QueryTabSnapshot[];
  activeConnectionId?: string;
  tableFilterHistory?: string[];
}

export type ExportFormat = "csv" | "json" | "sql";

export interface ResultSetExport {
  columns: string[];
  rows: unknown[][];
  sql?: string;
}
