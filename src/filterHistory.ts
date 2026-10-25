export const TABLE_FILTER_HISTORY_LIMIT = 30;

/** Add a term to a newest-first, case-insensitively unique history list. */
export function pushRecentTableFilter(
  history: readonly string[],
  value: string,
  limit = TABLE_FILTER_HISTORY_LIMIT,
): string[] {
  const term = value.trim();
  if (!term) {
    return history as string[];
  }
  const lower = term.toLowerCase();
  if (history[0] === term && !history.slice(1).some((item) => item.toLowerCase() === lower)) {
    return history as string[];
  }
  return [term, ...history.filter((item) => item.toLowerCase() !== lower)].slice(0, limit);
}

/** Sanitize a persisted newest-first history list. */
export function sanitizeTableFilterHistory(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }
    const term = item.trim();
    if (!term) {
      continue;
    }
    const lower = term.toLowerCase();
    if (seen.has(lower)) {
      continue;
    }
    seen.add(lower);
    result.push(term);
    if (result.length >= TABLE_FILTER_HISTORY_LIMIT) {
      break;
    }
  }
  return result;
}
