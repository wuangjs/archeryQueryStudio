import { describe, expect, it } from "vitest";
import { buildSelect, clearOrderBy, qualifiedTableName, quoteIdentifier, removeOrderBy, SqlSortError, toggleOrderBy } from "../src/sql";

describe("SQL identifier helpers", () => {
  it("quotes identifiers for each dialect family", () => {
    expect(quoteIdentifier("order", "mysql")).toBe("`order`");
    expect(quoteIdentifier("order", "postgresql")).toBe('"order"');
    expect(quoteIdentifier("order", "mssql")).toBe("[order]");
  });

  it("builds MySQL and PostgreSQL qualified names", () => {
    expect(
      qualifiedTableName({ dbType: "mysql", dbName: "shop", tableName: "orders" }),
    ).toBe("`shop`.`orders`");
    expect(
      qualifiedTableName({
        dbType: "postgresql",
        dbName: "shop",
        schemaName: "public",
        tableName: "orders",
      }),
    ).toBe('"public"."orders"');
  });

  it("uses the owner for Oracle and avoids an invalid SQL Server two-part name", () => {
    expect(
      qualifiedTableName({ dbType: "oracle", dbName: "APP", tableName: "ORDERS" }),
    ).toBe('"APP"."ORDERS"');
    expect(
      qualifiedTableName({ dbType: "mssql", dbName: "shop", tableName: "orders" }),
    ).toBe("[orders]");
    expect(
      qualifiedTableName({
        dbType: "mssql",
        dbName: "shop",
        schemaName: "dbo",
        tableName: "orders",
      }),
    ).toBe("[shop].[dbo].[orders]");
  });

  it("generates a select statement without client-side LIMIT", () => {
    expect(buildSelect({ dbType: "mysql", dbName: "shop", tableName: "orders" })).toBe(
      "SELECT *\nFROM `shop`.`orders`;",
    );
  });
});

describe("toggleOrderBy", () => {
  it("appends ORDER BY before an existing LIMIT", () => {
    const result = toggleOrderBy("SELECT * FROM shop.orders LIMIT 10;", "created_at", "mysql");
    expect(result.direction).toBe("ASC");
    expect(result.sql).toBe(
      "SELECT * FROM shop.orders\nORDER BY `created_at` ASC\nLIMIT 10;",
    );
  });

  it("toggles an existing ascending sort to descending", () => {
    const result = toggleOrderBy(
      "SELECT * FROM shop.orders ORDER BY name ASC;",
      "name",
      "mysql",
    );
    expect(result.direction).toBe("DESC");
    expect(result.sql).toBe("SELECT * FROM shop.orders\nORDER BY name DESC;");
  });

  it("prepends a new column while preserving existing sort items", () => {
    const result = toggleOrderBy(
      "SELECT * FROM shop.orders ORDER BY name ASC, created_at DESC;",
      "id",
      "mysql",
    );
    expect(result.direction).toBe("ASC");
    expect(result.sql).toBe(
      "SELECT * FROM shop.orders\nORDER BY `id` ASC, name ASC, created_at DESC;",
    );
  });

  it("preserves PostgreSQL NULLS ordering when toggling", () => {
    const result = toggleOrderBy(
      'SELECT * FROM public.users ORDER BY "name" DESC NULLS LAST;',
      "name",
      "postgresql",
    );
    expect(result.direction).toBe("ASC");
    expect(result.sql).toBe(
      'SELECT * FROM public.users\nORDER BY "name" ASC NULLS LAST;',
    );
  });

  it("ignores ORDER BY inside subqueries, strings and comments", () => {
    const result = toggleOrderBy(
      "SELECT * FROM (SELECT * FROM t ORDER BY x) s -- ORDER BY ignored\nWHERE note = 'ORDER BY nope';",
      "id",
      "mysql",
    );
    expect(result.sql.endsWith("ORDER BY `id` ASC;")).toBe(true);
    expect(result.sql).toContain("ORDER BY x");
    expect(result.sql).toContain("'ORDER BY nope'");
  });

  it("matches qualified identifiers and is case-insensitive", () => {
    const result = toggleOrderBy(
      "SELECT * FROM orders o ORDER BY o.Name DESC;",
      "name",
      "mysql",
    );
    expect(result.direction).toBe("ASC");
    expect(result.sql).toContain("ORDER BY o.Name ASC");
  });

  it("rejects multiple statements and non-SELECT statements", () => {
    expect(() => toggleOrderBy("SELECT 1; SELECT 2;", "id")).toThrow(SqlSortError);
    expect(() => toggleOrderBy("UPDATE t SET a = 1", "id")).toThrow(SqlSortError);
  });
});

describe("removeOrderBy", () => {
  it("removes the only order item and the ORDER BY clause", () => {
    const result = removeOrderBy("SELECT * FROM shop.orders\nORDER BY `created_at` DESC;", "created_at");
    expect(result.removed).toBe(true);
    expect(result.sql).toBe("SELECT * FROM shop.orders;");
  });

  it("keeps other sort items", () => {
    const result = removeOrderBy(
      "SELECT * FROM shop.orders ORDER BY `id` ASC, name DESC LIMIT 10;",
      "name",
    );
    expect(result.removed).toBe(true);
    expect(result.sql).toContain("ORDER BY `id` ASC");
    expect(result.sql).toContain("LIMIT 10;");
  });

  it("does nothing when the field is not sorted", () => {
    const sql = "SELECT * FROM shop.orders ORDER BY id ASC;";
    expect(removeOrderBy(sql, "name")).toEqual({ sql, removed: false });
  });
});

describe("clearOrderBy", () => {
  it("removes the whole ORDER BY clause including secondary fields", () => {
    const result = clearOrderBy(
      "SELECT * FROM shop.orders ORDER BY `id` ASC, name DESC LIMIT 10;",
    );
    expect(result.removed).toBe(true);
    expect(result.sql).toBe("SELECT * FROM shop.orders\nLIMIT 10;");
  });

  it("leaves a query without ORDER BY untouched", () => {
    const sql = "SELECT * FROM shop.orders;";
    expect(clearOrderBy(sql)).toEqual({ sql, removed: false });
  });
});
