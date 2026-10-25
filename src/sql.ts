export interface QualifiedTable {
  dbType?: string;
  dbName?: string;
  schemaName?: string;
  tableName: string;
}

const MYSQL_TYPES = new Set(["mysql", "mariadb", "percona", "tdengine", "doris", "starrocks"]);
const PG_TYPES = new Set(["postgresql", "postgres", "pgsql", "gaussdb", "greenplum", "opengauss", "kingbase", "highgo"]);
const MSSQL_TYPES = new Set(["mssql", "sqlserver"]);

export function quoteIdentifier(identifier: string, dbType?: string): string {
  const type = (dbType ?? "").toLowerCase();
  if (MYSQL_TYPES.has(type)) {
    return `\`${identifier.replace(/`/g, "``")}\``;
  }
  if (MSSQL_TYPES.has(type)) {
    return `[${identifier.replace(/]/g, "]]")}]`;
  }
  return `"${identifier.replace(/"/g, '""')}"`;
}

export function qualifiedTableName(table: QualifiedTable): string {
  const type = (table.dbType ?? "").toLowerCase();
  const parts: string[] = [];
  if (MYSQL_TYPES.has(type)) {
    if (table.dbName) {
      parts.push(quoteIdentifier(table.dbName, table.dbType));
    }
  } else if (PG_TYPES.has(type)) {
    if (table.schemaName) {
      parts.push(quoteIdentifier(table.schemaName, table.dbType));
    }
  } else if (type === "oracle") {
    const owner = table.schemaName || table.dbName;
    if (owner) {
      parts.push(quoteIdentifier(owner, table.dbType));
    }
  } else if (MSSQL_TYPES.has(type)) {
    if (table.schemaName) {
      if (table.dbName) {
        parts.push(quoteIdentifier(table.dbName, table.dbType));
      }
      parts.push(quoteIdentifier(table.schemaName, table.dbType));
    }
  } else {
    if (table.dbName) {
      parts.push(quoteIdentifier(table.dbName, table.dbType));
    }
    if (table.schemaName) {
      parts.push(quoteIdentifier(table.schemaName, table.dbType));
    }
  }
  parts.push(quoteIdentifier(table.tableName, table.dbType));
  return parts.join(".");
}

export function buildSelect(table: QualifiedTable): string {
  return `SELECT *\nFROM ${qualifiedTableName(table)};`;
}

export function buildCount(table: QualifiedTable): string {
  return `SELECT COUNT(*) AS total_count\nFROM ${qualifiedTableName(table)};`;
}

export function qualifiedDisplayName(table: QualifiedTable): string {
  return [table.dbName, table.schemaName, table.tableName].filter(Boolean).join(".");
}

export type SortDirection = "ASC" | "DESC";

export interface ToggleOrderByResult {
  sql: string;
  direction: SortDirection;
}

export class SqlSortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SqlSortError";
  }
}

interface SqlToken {
  word: string;
  start: number;
  end: number;
  depth: number;
}

interface ScanResult {
  tokens: SqlToken[];
  semicolons: number[];
  commas: number[];
}

/**
 * Toggle (or add) an ORDER BY item for a single SELECT/WITH statement.
 *
 * The operation is intentionally conservative: it works on the top-level
 * statement, ignores strings/comments/subqueries, and refuses multi-statement
 * input. The returned SQL can be put directly into the editor and executed.
 */
function removeOrderClause(sql: string, orderStart: number, clauseEnd: number): string {
  const before = sql.slice(0, orderStart).replace(/\s+$/, "");
  const after = sql.slice(clauseEnd);
  if (!after) {
    return before;
  }
  if (after.startsWith(";")) {
    return `${before}${after}`;
  }
  return `${before}\n${after.replace(/^\s+/, "")}`;
}

export function toggleOrderBy(
  sql: string,
  column: string,
  dbType?: string,
): ToggleOrderByResult {
  if (!sql.trim()) {
    throw new SqlSortError("SQL 不能为空");
  }
  const name = column.trim();
  if (!name) {
    throw new SqlSortError("字段名不能为空");
  }

  const scan = scanSql(sql);
  const firstSemicolon = scan.semicolons[0];
  if (firstSemicolon !== undefined) {
    if (scan.semicolons.length > 1) {
      throw new SqlSortError("当前 SQL 包含多条语句，无法自动追加 ORDER BY");
    }
    if (!scanSql(sql.slice(0, firstSemicolon)).tokens.length) {
      throw new SqlSortError("当前 SQL 不是可排序的查询语句");
    }
    if (scanSql(sql.slice(firstSemicolon + 1)).tokens.length) {
      throw new SqlSortError("当前 SQL 包含多条语句，无法自动追加 ORDER BY");
    }
  }

  const statementEnd = firstSemicolon ?? sql.length;
  const tokens = scan.tokens.filter((token) => token.end <= statementEnd);
  const firstWord = tokens[0]?.word.toUpperCase();
  if (firstWord !== "SELECT" && firstWord !== "WITH") {
    throw new SqlSortError("只有 SELECT / WITH 查询支持追加 ORDER BY");
  }
  if (firstWord === "WITH" && !tokens.some((token) => token.depth === 0 && token.word.toUpperCase() === "SELECT")) {
    throw new SqlSortError("只有 SELECT / WITH 查询支持追加 ORDER BY");
  }

  const quote = quoteIdentifier(name, dbType);
  const orderIndex = findLastOrderBy(tokens);
  if (orderIndex >= 0) {
    const orderToken = tokens[orderIndex];
    const byToken = tokens[orderIndex + 1];
    const terminator = findTerminator(tokens, orderIndex + 2, statementEnd);
    const clauseEnd = terminator ?? statementEnd;
    const itemsText = sql.slice(byToken.end, clauseEnd).trim();
    if (!itemsText) {
      throw new SqlSortError("ORDER BY 子句为空");
    }
    const items = splitTopLevel(itemsText, scanSql(itemsText).commas);
    let direction: SortDirection = "ASC";
    let matched = false;
    const nextItems = items.map((item) => {
      const parsed = parseOrderItem(item);
      if (!matched && parsed && normalizeIdentifier(parsed.expression)?.toLowerCase() === name.toLowerCase()) {
        matched = true;
        direction = parsed.direction === "ASC" ? "DESC" : "ASC";
        return `${parsed.expression} ${direction}${parsed.nulls ? ` ${parsed.nulls}` : ""}`;
      }
      return item;
    });
    if (!matched) {
      nextItems.unshift(`${quote} ASC`);
    }
    return {
      sql: compose(sql.slice(0, orderToken.start), `ORDER BY ${nextItems.join(", ")}`, sql.slice(clauseEnd)),
      direction,
    };
  }

  const terminator = findTerminator(tokens, 0, statementEnd);
  const insertAt = terminator ?? statementEnd;
  return {
    sql: compose(sql.slice(0, insertAt), `ORDER BY ${quote} ASC`, sql.slice(insertAt)),
    direction: "ASC",
  };
}

function findLastOrderBy(tokens: SqlToken[]): number {
  for (let index = tokens.length - 2; index >= 0; index -= 1) {
    if (
      tokens[index].depth === 0 &&
      tokens[index].word.toUpperCase() === "ORDER" &&
      tokens[index + 1].depth === 0 &&
      tokens[index + 1].word.toUpperCase() === "BY"
    ) {
      return index;
    }
  }
  return -1;
}

function findTerminator(
  tokens: SqlToken[],
  fromIndex: number,
  statementEnd: number,
): number | undefined {
  const terms = new Set(["LIMIT", "OFFSET", "FETCH", "FOR", "LOCK", "PROCEDURE"]);
  for (let index = fromIndex; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.depth !== 0) {
      continue;
    }
    if (terms.has(token.word.toUpperCase())) {
      return token.start;
    }
  }
  return statementEnd;
}

function compose(prefix: string, clause: string, suffix: string): string {
  const before = prefix.replace(/[ \t]+$/, "");
  let result = before;
  if (before && !before.endsWith("\n")) {
    result += "\n";
  }
  result += clause;
  if (suffix) {
    if (suffix.startsWith(";")) {
      result += suffix;
    } else if (/^[ \t]*\n/.test(suffix) || suffix.startsWith("\n")) {
      result += suffix;
    } else if (suffix.startsWith(" ") || suffix.startsWith("\t")) {
      result += suffix;
    } else {
      result += `\n${suffix}`;
    }
  }
  return result;
}

function parseOrderItem(item: string): {
  expression: string;
  direction: SortDirection;
  nulls?: string;
} | undefined {
  let core = item.trim();
  if (!core) {
    return undefined;
  }
  let nulls: string | undefined;
  const nullsMatch = /(NULLS\s+(?:FIRST|LAST))\s*$/i.exec(core);
  if (nullsMatch) {
    nulls = nullsMatch[1].toUpperCase();
    core = core.slice(0, nullsMatch.index).trim();
  }
  let direction: SortDirection = "ASC";
  const directionMatch = /(ASC|DESC)\s*$/i.exec(core);
  if (directionMatch) {
    direction = directionMatch[1].toUpperCase() as SortDirection;
    core = core.slice(0, directionMatch.index).trim();
  }
  if (!core) {
    return undefined;
  }
  return { expression: core, direction, nulls };
}

function normalizeIdentifier(expression: string): string | undefined {
  let index = 0;
  const text = expression.trim();
  const parts: string[] = [];
  while (index < text.length) {
    while (/\s/.test(text[index] ?? "")) {
      index += 1;
    }
    if (index >= text.length) {
      break;
    }
    const char = text[index];
    let part = "";
    if (char === '"' || char === "`" || char === "[") {
      const close = char === "[" ? "]" : char;
      index += 1;
      let closed = false;
      while (index < text.length) {
        if (text[index] === close) {
          if (text[index + 1] === close) {
            part += close;
            index += 2;
            continue;
          }
          index += 1;
          closed = true;
          break;
        }
        part += text[index];
        index += 1;
      }
      if (!closed) {
        return undefined;
      }
    } else {
      const start = index;
      while (index < text.length && /[A-Za-z0-9_$]/.test(text[index])) {
        index += 1;
      }
      if (index === start) {
        return undefined;
      }
      part = text.slice(start, index);
    }
    parts.push(part);
    while (/\s/.test(text[index] ?? "")) {
      index += 1;
    }
    if (index >= text.length) {
      break;
    }
    if (text[index] !== ".") {
      return undefined;
    }
    index += 1;
  }
  return parts.length ? parts[parts.length - 1] : undefined;
}

function splitTopLevel(text: string, commas: number[]): string[] {
  const result: string[] = [];
  let start = 0;
  for (const comma of commas) {
    result.push(text.slice(start, comma).trim());
    start = comma + 1;
  }
  result.push(text.slice(start).trim());
  return result.filter(Boolean);
}

function scanSql(sql: string): ScanResult {
  const tokens: SqlToken[] = [];
  const semicolons: number[] = [];
  const commas: number[] = [];
  let depth = 0;
  let index = 0;
  while (index < sql.length) {
    const char = sql[index];
    if (char === "'" || char === '"' || char === "`") {
      index = skipQuoted(sql, index, char);
      continue;
    }
    if (char === "[") {
      index = skipQuoted(sql, index, "[");
      continue;
    }
    if (char === "$") {
      const dollarQuotedEnd = skipDollarQuoted(sql, index);
      if (dollarQuotedEnd !== undefined) {
        index = dollarQuotedEnd;
        continue;
      }
    }
    if (char === "-" && sql[index + 1] === "-") {
      const newline = sql.indexOf("\n", index + 2);
      index = newline < 0 ? sql.length : newline + 1;
      continue;
    }
    if (char === "/" && sql[index + 1] === "*") {
      const end = sql.indexOf("*/", index + 2);
      index = end < 0 ? sql.length : end + 2;
      continue;
    }
    if (char === "(") {
      depth += 1;
      index += 1;
      continue;
    }
    if (char === ")") {
      depth = Math.max(0, depth - 1);
      index += 1;
      continue;
    }
    if (char === ";" && depth === 0) {
      semicolons.push(index);
      index += 1;
      continue;
    }
    if (char === "," && depth === 0) {
      commas.push(index);
      index += 1;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      const start = index;
      index += 1;
      while (index < sql.length && /[A-Za-z0-9_$]/.test(sql[index])) {
        index += 1;
      }
      tokens.push({ word: sql.slice(start, index), start, end: index, depth });
      continue;
    }
    index += 1;
  }
  return { tokens, semicolons, commas };
}

function skipQuoted(sql: string, start: number, quote: string): number {
  const close = quote === "[" ? "]" : quote;
  let index = start + 1;
  while (index < sql.length) {
    if (sql[index] === close) {
      if (sql[index + 1] === close) {
        index += 2;
        continue;
      }
      return index + 1;
    }
    if (sql[index] === "\\" && quote === "'") {
      index += 2;
      continue;
    }
    index += 1;
  }
  return sql.length;
}

function skipDollarQuoted(sql: string, start: number): number | undefined {
  const match = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(start));
  if (!match) {
    return undefined;
  }
  const tag = match[0];
  const end = sql.indexOf(tag, start + tag.length);
  return end < 0 ? sql.length : end + tag.length;
}

export interface RemoveOrderByResult {
  sql: string;
  removed: boolean;
}

export function clearOrderBy(sql: string): RemoveOrderByResult {
  if (!sql.trim()) {
    throw new SqlSortError("SQL 不能为空");
  }
  const scan = scanSql(sql);
  const firstSemicolon = scan.semicolons[0];
  const statementEnd = firstSemicolon ?? sql.length;
  const tokens = scan.tokens.filter((token) => token.end <= statementEnd);
  const firstWord = tokens[0]?.word.toUpperCase();
  if (firstWord !== "SELECT" && firstWord !== "WITH") {
    throw new SqlSortError("只有 SELECT / WITH 查询支持取消 ORDER BY");
  }
  const orderIndex = findLastOrderBy(tokens);
  if (orderIndex < 0) {
    return { sql, removed: false };
  }
  const orderToken = tokens[orderIndex];
  const clauseEnd = findTerminator(tokens, orderIndex + 2, statementEnd) ?? statementEnd;
  return { sql: removeOrderClause(sql, orderToken.start, clauseEnd), removed: true };
}

export function removeOrderBy(sql: string, column: string): RemoveOrderByResult {
  if (!sql.trim()) {
    throw new SqlSortError("SQL 不能为空");
  }
  const name = column.trim();
  if (!name) {
    throw new SqlSortError("字段名不能为空");
  }
  const scan = scanSql(sql);
  const firstSemicolon = scan.semicolons[0];
  if (firstSemicolon !== undefined) {
    if (scan.semicolons.length > 1) {
      throw new SqlSortError("当前 SQL 包含多条语句，无法自动取消排序");
    }
    if (!scanSql(sql.slice(0, firstSemicolon)).tokens.length) {
      throw new SqlSortError("当前 SQL 不是可排序的查询语句");
    }
    if (scanSql(sql.slice(firstSemicolon + 1)).tokens.length) {
      throw new SqlSortError("当前 SQL 包含多条语句，无法自动取消排序");
    }
  }
  const statementEnd = firstSemicolon ?? sql.length;
  const tokens = scan.tokens.filter((token) => token.end <= statementEnd);
  const firstWord = tokens[0]?.word.toUpperCase();
  if (firstWord !== "SELECT" && firstWord !== "WITH") {
    throw new SqlSortError("只有 SELECT / WITH 查询支持取消 ORDER BY");
  }
  const orderIndex = findLastOrderBy(tokens);
  if (orderIndex < 0) {
    return { sql, removed: false };
  }
  const orderToken = tokens[orderIndex];
  const byToken = tokens[orderIndex + 1];
  const terminator = findTerminator(tokens, orderIndex + 2, statementEnd);
  const clauseEnd = terminator ?? statementEnd;
  const itemsText = sql.slice(byToken.end, clauseEnd).trim();
  if (!itemsText) {
    return { sql, removed: false };
  }
  const items = splitTopLevel(itemsText, scanSql(itemsText).commas);
  let removed = false;
  const nextItems = items.filter((item) => {
    const parsed = parseOrderItem(item);
    if (
      !removed &&
      parsed &&
      normalizeIdentifier(parsed.expression)?.toLowerCase() === name.toLowerCase()
    ) {
      removed = true;
      return false;
    }
    return true;
  });
  if (!removed) {
    return { sql, removed: false };
  }
  if (nextItems.length === 0) {
    return { sql: removeOrderClause(sql, orderToken.start, clauseEnd), removed: true };
  }
  return {
    sql: compose(sql.slice(0, orderToken.start), `ORDER BY ${nextItems.join(", ")}`, sql.slice(clauseEnd)),
    removed: true,
  };
}
