export function isRedisDbType(dbType: string | undefined): boolean {
  return (dbType ?? "").toLowerCase() === "redis";
}

export function quoteRedisArgument(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function buildRedisScanCommand(pattern: string, count = 1000): string {
  const match = pattern.trim() || "*";
  return `SCAN 0 MATCH ${quoteRedisArgument(match)} COUNT ${count}`;
}

export function buildRedisTypeCommand(key: string): string {
  return `TYPE ${quoteRedisArgument(key)}`;
}

/** SCAN returns [cursor, key, key, ...] in the single "Result" column. */
export function parseRedisScanRows(rows: unknown[][]): string[] {
  if (rows.length <= 1) {
    return [];
  }
  return rows
    .slice(1)
    .map((row) => (row[0] === null || row[0] === undefined ? "" : String(row[0])))
    .filter(Boolean);
}

/** Parse the single TYPE result returned by Archery. */
export function parseRedisKeyType(rows: unknown[][], message?: string): string {
  const value = rows[0]?.[0] ?? message ?? "";
  return String(value).trim().toLowerCase();
}

/** Build a read command for a Redis key based on its TYPE. */
export function buildRedisDataCommand(key: string, type: string): string | undefined {
  const quoted = quoteRedisArgument(key);
  switch (type.trim().toLowerCase()) {
    case "string":
      return `GET ${quoted}`;
    case "hash":
      return `HGETALL ${quoted}`;
    case "list":
      return `LRANGE ${quoted} 0 999`;
    case "set":
      return `SMEMBERS ${quoted}`;
    case "zset":
      return `ZRANGE ${quoted} 0 999 WITHSCORES`;
    case "stream":
      return `XRANGE ${quoted} - + COUNT 1000`;
    default:
      return undefined;
  }
}

/**
 * Redis key search is a contains search by default. Add the missing leading
 * and trailing '*' when the user has not typed them, so "user*" becomes
 * "*user*" and "*user" becomes "*user*".
 */
export function normalizeRedisKeyPattern(value: string): string {
  const term = value.trim();
  if (!term) {
    return "*";
  }
  const prefix = term.startsWith("*") ? "" : "*";
  const suffix = term.endsWith("*") ? "" : "*";
  return `${prefix}${term}${suffix}`;
}
