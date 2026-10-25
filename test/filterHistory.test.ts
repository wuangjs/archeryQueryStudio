import { describe, expect, it } from "vitest";
import {
  pushRecentTableFilter,
  sanitizeTableFilterHistory,
  TABLE_FILTER_HISTORY_LIMIT,
} from "../src/filterHistory";

describe("table filter history", () => {
  it("adds the newest term first and deduplicates", () => {
    expect(pushRecentTableFilter(["orders", "users"], "customers")).toEqual([
      "customers",
      "orders",
      "users",
    ]);
    expect(pushRecentTableFilter(["orders", "users"], "ORDERS")).toEqual([
      "ORDERS",
      "users",
    ]);
  });

  it("keeps the same list when the term is already first", () => {
    const history = ["orders", "users"];
    expect(pushRecentTableFilter(history, "orders")).toBe(history);
  });

  it("limits history to 30 entries", () => {
    const history = Array.from({ length: 30 }, (_, index) => `t${index}`);
    const next = pushRecentTableFilter(history, "new");
    expect(next).toHaveLength(TABLE_FILTER_HISTORY_LIMIT);
    expect(next[0]).toBe("new");
    expect(next).not.toContain("t29");
  });

  it("sanitizes persisted values", () => {
    expect(
      sanitizeTableFilterHistory(["  orders ", "ORDERS", 42, "", "users", null]),
    ).toEqual(["orders", "users"]);
    expect(sanitizeTableFilterHistory(undefined)).toEqual([]);
    expect(sanitizeTableFilterHistory("orders")).toEqual([]);
  });
});
