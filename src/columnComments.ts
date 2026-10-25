export type ColumnCommentMap = Record<string, string>;

const NAME_HEADERS = new Set(["field", "columnname", "column", "name", "colname"]);
const COMMENT_HEADERS = new Set([
  "comment",
  "comments",
  "description",
  "columncomment",
  "remarks",
  "remark",
]);

/**
 * Best-effort extraction of column comments from an Archery table-description
 * response. MySQL/MariaDB describe_table returns SHOW CREATE TABLE, while
 * PostgreSQL/GaussDB/Oracle include a comment column in the result rows.
 */
export function extractColumnComments(
  columns: string[],
  rows: unknown[][],
  statement: string | undefined,
  dbType: string | undefined,
): ColumnCommentMap {
  const fromDdl = statement ? parseCreateTableComments(statement) : {};
  if (Object.keys(fromDdl).length > 0) {
    return fromDdl;
  }

  const normalized = columns.map(normalizeHeader);
  const nameIndex = normalized.findIndex((name) => NAME_HEADERS.has(name));
  const commentIndex = normalized.findIndex((name) => COMMENT_HEADERS.has(name));
  if (nameIndex >= 0 && commentIndex >= 0) {
    return collectRows(rows, nameIndex, commentIndex);
  }

  const type = (dbType ?? "").toLowerCase();
  if (
    columns.length >= 2 &&
    ["postgresql", "postgres", "gaussdb", "greenplum", "opengauss", "kingbase", "highgo", "oracle"].includes(type)
  ) {
    return collectRows(rows, 0, columns.length - 1);
  }
  return {};
}

function collectRows(rows: unknown[][], nameIndex: number, commentIndex: number): ColumnCommentMap {
  const result: ColumnCommentMap = {};
  for (const row of rows) {
    const name = String(row[nameIndex] ?? "").trim();
    const comment = String(row[commentIndex] ?? "").trim();
    if (name && comment) {
      result[name] = comment;
    }
  }
  return result;
}

function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function parseCreateTableComments(statement: string): ColumnCommentMap {
  const create = /CREATE\s+TABLE\b/i.exec(statement);
  if (!create) {
    return {};
  }
  const open = statement.indexOf("(", create.index);
  if (open < 0) {
    return {};
  }
  const body = extractParenthesized(statement, open);
  if (!body) {
    return {};
  }
  const result: ColumnCommentMap = {};
  for (const definition of splitTopLevelCommas(body)) {
    const text = definition.trim();
    if (!text || /^(?:PRIMARY|UNIQUE|KEY|INDEX|CONSTRAINT|FOREIGN|FULLTEXT|SPATIAL|CHECK|PARTITION)\b/i.test(text)) {
      continue;
    }
    const parsedName = parseLeadingIdentifier(text);
    if (!parsedName) {
      continue;
    }
    const comment = parseCommentClause(text.slice(parsedName.end));
    if (comment) {
      result[parsedName.name] = comment.trim();
    }
  }
  return result;
}

function extractParenthesized(text: string, open: number): string | undefined {
  let depth = 0;
  let quote = "";
  let index = open;
  while (index < text.length) {
    const char = text[index];
    if (quote) {
      if (char === "\\" && quote === "'") {
        index += 2;
        continue;
      }
      if (char === quote) {
        if (text[index + 1] === quote) {
          index += 2;
          continue;
        }
        quote = "";
      }
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      index += 1;
      continue;
    }
    if (char === "(") {
      depth += 1;
      if (depth === 1) {
        index += 1;
        continue;
      }
    }
    if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(open + 1, index);
      }
    }
    index += 1;
  }
  return undefined;
}

function splitTopLevelCommas(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (quote) {
      if (char === "\\" && quote === "'") {
        index += 2;
        continue;
      }
      if (char === quote) {
        if (text[index + 1] === quote) {
          index += 2;
          continue;
        }
        quote = "";
      }
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      index += 1;
      continue;
    }
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth = Math.max(0, depth - 1);
    } else if (char === "," && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
    index += 1;
  }
  parts.push(text.slice(start));
  return parts;
}

function parseLeadingIdentifier(text: string): { name: string; end: number } | undefined {
  let index = 0;
  while (/\s/.test(text[index] ?? "")) {
    index += 1;
  }
  if (text[index] === "`" || text[index] === '"' || text[index] === "[") {
    const quote = text[index];
    const close = quote === "[" ? "]" : quote;
    let name = "";
    index += 1;
    while (index < text.length) {
      if (text[index] === close) {
        if (text[index + 1] === close) {
          name += close;
          index += 2;
          continue;
        }
        return { name, end: index + 1 };
      }
      name += text[index];
      index += 1;
    }
    return undefined;
  }
  const match = /^[A-Za-z0-9_$]+/.exec(text.slice(index));
  return match ? { name: match[0], end: index + match[0].length } : undefined;
}

function parseCommentClause(text: string): string | undefined {
  let index = 0;
  while (index < text.length) {
    if (text[index] === "'" || text[index] === '"' || text[index] === "`") {
      index = skipString(text, index, text[index]);
      continue;
    }
    if (text[index] === "(") {
      index = skipParentheses(text, index);
      continue;
    }
    if (/[A-Za-z_]/.test(text[index])) {
      const start = index;
      index += 1;
      while (index < text.length && /[A-Za-z0-9_$]/.test(text[index])) {
        index += 1;
      }
      if (text.slice(start, index).toUpperCase() !== "COMMENT") {
        continue;
      }
      while (/\s/.test(text[index] ?? "")) {
        index += 1;
      }
      if (text[index] !== "'") {
        continue;
      }
      const parsed = parseQuotedString(text, index);
      if (parsed) {
        return parsed.value;
      }
    }
    index += 1;
  }
  return undefined;
}

function skipString(text: string, start: number, quote: string): number {
  const close = quote === "[" ? "]" : quote;
  let index = start + 1;
  while (index < text.length) {
    if (text[index] === "\\" && quote === "'") {
      index += 2;
      continue;
    }
    if (text[index] === close) {
      if (text[index + 1] === close) {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }
  return text.length;
}

function skipParentheses(text: string, start: number): number {
  let depth = 0;
  let index = start;
  while (index < text.length) {
    if (text[index] === "'" || text[index] === '"' || text[index] === "`") {
      index = skipString(text, index, text[index]);
      continue;
    }
    if (text[index] === "(") {
      depth += 1;
    } else if (text[index] === ")") {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
    index += 1;
  }
  return text.length;
}

function parseQuotedString(text: string, start: number): { value: string; end: number } | undefined {
  if (text[start] !== "'") {
    return undefined;
  }
  let index = start + 1;
  let value = "";
  while (index < text.length) {
    const char = text[index];
    if (char === "\\") {
      const next = text[index + 1] ?? "";
      value += decodeEscape(next);
      index += 2;
      continue;
    }
    if (char === "'") {
      if (text[index + 1] === "'") {
        value += "'";
        index += 2;
        continue;
      }
      return { value, end: index + 1 };
    }
    value += char;
    index += 1;
  }
  return undefined;
}

function decodeEscape(char: string): string {
  switch (char) {
    case "n":
      return "\n";
    case "r":
      return "\r";
    case "t":
      return "\t";
    case "0":
      return "\0";
    default:
      return char;
  }
}
