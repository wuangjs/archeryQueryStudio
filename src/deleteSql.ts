import { formatSqlLiteral } from "./insertSql";
import { qualifiedTableName, quoteIdentifier } from "./sql";

export interface DeleteStatementOptions {
  columns: string[];
  rows: unknown[][];
  tableName: string;
  dbName?: string;
  schemaName?: string;
  dbType?: string;
  primaryKey?: string[];
  header?: boolean;
}

export class DeleteSqlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeleteSqlError";
  }
}

/**
 * Extract primary-key column names from a MySQL-style CREATE TABLE statement.
 * Falls back to an empty list when the DDL is unavailable or unparseable.
 */
export function extractPrimaryKeyColumns(statement: string | undefined): string[] {
  if (!statement) {
    return [];
  }
  const match = /PRIMARY\s+KEY\s*\(([^)]*)\)/i.exec(statement);
  if (!match) {
    return [];
  }
  return match[1]
    .split(",")
    .map((part) =>
      part
        .trim()
        .replace(/\(\s*\d+\s*\)$/, "")
        .replace(/^[`"[]|[`"\]]$/g, "")
        .trim(),
    )
    .filter(Boolean);
}

export function buildDeleteStatements(options: DeleteStatementOptions): string {
  if (!options.tableName) {
    throw new DeleteSqlError("当前结果未关联具体表，无法生成 DELETE");
  }
  if (!options.columns.length) {
    throw new DeleteSqlError("结果中没有可用的字段");
  }
  const primaryKey = (options.primaryKey ?? []).filter((key) =>
    options.columns.some((column) => column.toLowerCase() === key.toLowerCase()),
  );
  const keyColumns = primaryKey.length ? primaryKey : options.columns;
  const quotedTable = qualifiedTableName({
    dbType: options.dbType,
    dbName: options.dbName,
    schemaName: options.schemaName,
    tableName: options.tableName.split(".").pop() || options.tableName,
  });
  const lines: string[] = [];
  if (options.header) {
    lines.push(
      `-- 由 Archery Query Studio 生成，${new Date().toLocaleString("zh-CN")}`,
      `-- 共 ${options.rows.length} 行`,
      "",
    );
  }
  for (const row of options.rows) {
    const conditions = keyColumns.map((column) => {
      const index = options.columns.findIndex(
        (item) => item.toLowerCase() === column.toLowerCase(),
      );
      const value = index >= 0 ? row[index] : null;
      const quoted = quoteIdentifier(column, options.dbType);
      return value === null || value === undefined
        ? `${quoted} IS NULL`
        : `${quoted} = ${formatSqlLiteral(value)}`;
    });
    lines.push(
      `DELETE FROM ${quotedTable} WHERE ${conditions.join(" AND ")};`,
    );
  }
  return `${lines.join("\n")}\n`;
}
