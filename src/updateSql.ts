import { formatSqlLiteral } from "./insertSql";
import { qualifiedTableName, quoteIdentifier } from "./sql";

export interface CellUpdate {
  columnIndex: number;
  value: unknown;
}

export interface RowUpdate {
  originalRow: unknown[];
  changes: CellUpdate[];
}

export interface UpdateStatementOptions {
  columns: string[];
  updates: RowUpdate[];
  tableName: string;
  dbName?: string;
  schemaName?: string;
  dbType?: string;
  primaryKey?: string[];
}

export class UpdateSqlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpdateSqlError";
  }
}

export function buildUpdateStatements(options: UpdateStatementOptions): string {
  if (!options.tableName) {
    throw new UpdateSqlError("当前结果未关联具体表，无法生成 UPDATE");
  }
  if (!options.columns.length) {
    throw new UpdateSqlError("结果中没有可用的字段");
  }
  if (!options.updates.length) {
    throw new UpdateSqlError("没有需要生成的修改");
  }
  const quotedTable = qualifiedTableName({
    dbType: options.dbType,
    dbName: options.dbName,
    schemaName: options.schemaName,
    tableName: options.tableName.split(".").pop() || options.tableName,
  });
  const primaryKey = (options.primaryKey ?? []).filter((key) =>
    options.columns.some((column) => column.toLowerCase() === key.toLowerCase()),
  );
  const whereColumns = primaryKey.length ? primaryKey : options.columns;
  const lines: string[] = [];
  for (const update of options.updates) {
    const assignments = update.changes
      .filter((change) => change.columnIndex >= 0 && change.columnIndex < options.columns.length)
      .sort((left, right) => left.columnIndex - right.columnIndex)
      .map(
        (change) =>
          `${quoteIdentifier(options.columns[change.columnIndex], options.dbType)} = ${formatSqlLiteral(change.value)}`,
      );
    if (!assignments.length) {
      continue;
    }
    const conditions = whereColumns.map((column) => {
      const index = options.columns.findIndex(
        (item) => item.toLowerCase() === column.toLowerCase(),
      );
      const value = index >= 0 ? update.originalRow[index] : null;
      const quoted = quoteIdentifier(column, options.dbType);
      return value === null || value === undefined
        ? `${quoted} IS NULL`
        : `${quoted} = ${formatSqlLiteral(value)}`;
    });
    lines.push(
      `UPDATE ${quotedTable} SET ${assignments.join(", ")} WHERE ${conditions.join(" AND ")};`,
    );
  }
  if (!lines.length) {
    throw new UpdateSqlError("没有可生成的 UPDATE 语句");
  }
  return `${lines.join("\n")}\n`;
}
