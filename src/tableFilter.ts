export interface TableNameMatcher {
  regex: boolean;
  error?: string;
  test: (name: string) => boolean;
}

/**
 * Build a case-insensitive table-name matcher.
 * Regex mode uses the input as-is; literal mode uses substring matching.
 */
export function createTableNameMatcher(term: string, regex: boolean): TableNameMatcher {
  const value = term.trim();
  if (!value) {
    return { regex, test: () => true };
  }
  if (!regex) {
    const lower = value.toLowerCase();
    return { regex, test: (name) => name.toLowerCase().includes(lower) };
  }
  try {
    const pattern = new RegExp(value, "i");
    return { regex, test: (name) => pattern.test(name) };
  } catch {
    return {
      regex,
      error: "正则表达式无效，请检查语法和转义符",
      test: () => false,
    };
  }
}
