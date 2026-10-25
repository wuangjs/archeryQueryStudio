import type {
  ArcheryInstance,
  ConnectionConfig,
  ConnectionDraft,
  ExportFormat,
  QueryExecutionRequest,
  QueryExecutionResult,
  QueryLogPage,
  ResourceItem,
  TableDescription,
  WorkbenchSnapshot,
} from "../types";

export interface ConnectionInfo extends ConnectionConfig {
  hasPassword: boolean;
  hasToken: boolean;
}

export interface ConnectionFormDraft extends ConnectionDraft {
  hasPassword?: boolean;
  hasToken?: boolean;
}

export interface WorkbenchSettings {
  defaultLimit: number;
  allowInsecureTls: boolean;
}

export interface OpenQueryContext {
  connectionId?: string;
  instanceName?: string;
  dbName?: string;
  schemaName?: string;
  tableName?: string;
  dbType?: string;
  sql?: string;
  newTab?: boolean;
  describe?: boolean;
  autoRun?: boolean;
}

export type WorkbenchAction = "add-connection" | "edit-connection" | "show-history";

export interface BootstrapMessage {
  type: "bootstrap";
  version: string;
  connections: ConnectionInfo[];
  settings: WorkbenchSettings;
  snapshot?: WorkbenchSnapshot;
  context?: OpenQueryContext;
  action?: WorkbenchAction;
  connectionDraft?: ConnectionFormDraft;
}

export interface SerializedError {
  message: string;
  hint?: string;
  code?: string;
  status?: number;
}

export type RequestPayload =
  | { type: "listInstances"; connectionId: string; force?: boolean }
  | {
      type: "listResources";
      connectionId: string;
      instanceName: string;
      resourceType: "database" | "schema" | "table" | "column";
      dbName?: string;
      schemaName?: string;
      tableName?: string;
      force?: boolean;
    }
  | { type: "queryLogs"; connectionId: string; search?: string; limit?: number }
  | { type: "testConnection"; draft: ConnectionFormDraft }
  | { type: "saveConnection"; draft: ConnectionFormDraft }
  | { type: "deleteConnection"; connectionId: string }
  | { type: "getConnectionDraft"; connectionId: string }
  | {
      type: "executeQuery";
      connectionId: string;
      request: QueryExecutionRequest;
      tabId: string;
      tableName?: string;
    }
  | {
      type: "describeTable";
      connectionId: string;
      instanceName: string;
      dbName: string;
      tableName: string;
      schemaName?: string;
      tabId: string;
    }
  | { type: "cancelRequest"; targetRequestId: string }
  | {
      type: "exportResult";
      format: ExportFormat;
      columns: string[];
      rows: unknown[][];
      sql?: string;
      tableName?: string;
      dbName?: string;
      schemaName?: string;
      dbType?: string;
      suggestedName?: string;
    }
  | { type: "copyText"; text: string }
  | { type: "saveSqlFile"; sql: string; suggestedName?: string }
  | { type: "openSqlFile" }
  | { type: "persistState"; snapshot: WorkbenchSnapshot }
  | { type: "refreshExplorer" }
  | { type: "openSettings" }
  | { type: "showLogs" }
  | { type: "openConnectionForm"; connectionId?: string }
  | { type: "showHistory" };

export type WebviewRequest = RequestPayload & { requestId: string };

export type WebviewMessage =
  | WebviewRequest
  | { type: "ready" }
  | { type: "dismissWelcome" };

export type HostMessage =
  | BootstrapMessage
  | { type: "connections"; connections: ConnectionInfo[] }
  | {
      type: "response";
      requestId: string;
      ok: boolean;
      data?: unknown;
      error?: SerializedError;
    }
  | { type: "context"; context: OpenQueryContext; action?: WorkbenchAction; connectionDraft?: ConnectionFormDraft }
  | { type: "toast"; severity: "info" | "warning" | "error"; message: string }
  | { type: "connectionRemoved"; connectionId: string }
  | { type: "exportDone"; path: string }

export interface ListInstancesData {
  instances: ArcheryInstance[];
}
export interface ListResourcesData {
  items: ResourceItem[];
}
export interface QueryLogsData extends QueryLogPage {}
export interface ExecuteQueryData extends QueryExecutionResult {}
export interface DescribeTableData extends TableDescription {}
export interface SaveConnectionData {
  connection: ConnectionInfo;
}
export interface ConnectionDraftData {
  draft: ConnectionFormDraft;
}
export interface ExportResultData {
  path: string;
}
export interface OpenSqlFileData {
  name?: string;
  content?: string;
}

export function isHostMessage(value: unknown): value is HostMessage {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}
