import { qualifiedTableName, quoteIdentifier } from "./sql";

export type InsertMode = "insert" | "replace" | "ignore";

export interface InsertStatementOptions {
  columns: string[];
  rows: unknown[][];
  tableName?: string;
  dbName?: string;
  schemaName?: string;
  dbType?: string;
  mode?: InsertMode;
  header?: boolean;
}

export class InsertSqlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InsertSqlError";
  }
}

const MYSQL_TYPES = new Set([
  "mysql",
  "mariadb",
  "percona",
  "tdengine",
  "doris",
  "starrocks",
  "tidb",
  "oceanbase",
]);

export function isMySqlFamily(dbType: string | undefined): boolean {
  return MYSQL_TYPES.has((dbType ?? "").toLowerCase());
}

export function supportsInsertMode(dbType: string | undefined, mode: InsertMode): boolean {
  if (mode === "insert") {
    return true;
  }
  return isMySqlFamily(dbType);
}

export function insertModeLabel(mode: InsertMode): string {
  if (mode === "replace") {
    return "覆盖插入";
  }
  if (mode === "ignore") {
    return "忽略插入";
  }
  return "普通插入";
}

export function buildInsertStatements(options: InsertStatementOptions): string {
  const mode = options.mode ?? "insert";
  if (!options.columns.length) {
    throw new InsertSqlError("结果中没有可用的字段");
  }
  if (!supportsInsertMode(options.dbType, mode)) {
    throw new InsertSqlError(
      `${insertModeLabel(mode)}仅支持 MySQL/MariaDB，当前数据库为 ${options.dbType || "未知"}`,
    );
  }
  const table = options.tableName?.split(".").pop() || "exported_rows";
  const quotedTable = qualifiedTableName({
    dbType: options.dbType,
    dbName: options.dbName,
    schemaName: options.schemaName,
    tableName: table,
  });
  const quotedColumns = options.columns
    .map((column) => quoteIdentifier(column, options.dbType))
    .join(", ");

  const prefix =
    mode === "replace"
      ? "REPLACE INTO"
      : mode === "ignore"
        ? "INSERT IGNORE INTO"
        : "INSERT INTO";

  const lines: string[] = [];
  if (options.header) {
    lines.push(
      `-- 由 Archery Query Studio 导出，${new Date().toLocaleString("zh-CN")}`,
      `-- 共 ${options.rows.length} 行`,
      "",
    );
  }
  for (const row of options.rows) {
    lines.push(
      `${prefix} ${quotedTable} (${quotedColumns}) VALUES (${row
        .map(formatSqlLiteral)
        .join(", ")});`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export function formatSqlLiteral(value: unknown): string {
  if (value === null || value === undefined) {
    return "NULL";
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "boolean") {
    return value ? "1" : "0";
  }
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return `'${text.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}
