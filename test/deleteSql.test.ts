import { describe, expect, it } from "vitest";
import {
  buildDeleteStatements,
  DeleteSqlError,
  extractPrimaryKeyColumns,
} from "../src/deleteSql";

const base = {
  columns: ["id", "name", "note"],
  rows: [
    [1, "Alice", null],
    [2, "O'Reilly", "x"],
  ],
  tableName: "orders",
  dbName: "shop",
  dbType: "mysql",
};

describe("buildDeleteStatements", () => {
  it("uses the primary key when available", () => {
    const sql = buildDeleteStatements({ ...base, primaryKey: ["id"] });
    expect(sql).toContain("DELETE FROM `shop`.`orders` WHERE `id` = 1 LIMIT 1;");
    expect(sql).toContain("DELETE FROM `shop`.`orders` WHERE `id` = 2 LIMIT 1;");
    expect(sql).not.toContain("`name`");
  });

  it("uses all columns when no key is known", () => {
    const sql = buildDeleteStatements(base);
    expect(sql).toContain(
      "`id` = 1 AND `name` = 'Alice' AND `note` IS NULL LIMIT 1;",
    );
  });

  it("handles composite keys", () => {
    const sql = buildDeleteStatements({
      ...base,
      primaryKey: ["id", "name"],
    });
    expect(sql).toContain("`id` = 1 AND `name` = 'Alice' LIMIT 1;");
  });

  it("uses standard SQL NULL handling for non-MySQL databases", () => {
    const sql = buildDeleteStatements({ ...base, dbType: "pgsql", schemaName: "public" });
    expect(sql).toContain('DELETE FROM "public"."orders" WHERE "id" = 1 AND "name" = \'Alice\' AND "note" IS NULL;');
    expect(sql).not.toContain("LIMIT 1");
  });

  it("requires a table name and columns", () => {
    expect(() => buildDeleteStatements({ ...base, tableName: "" })).toThrow(DeleteSqlError);
    expect(() => buildDeleteStatements({ ...base, columns: [] })).toThrow(DeleteSqlError);
  });
});

describe("extractPrimaryKeyColumns", () => {
  it("parses a MySQL primary key", () => {
    expect(
      extractPrimaryKeyColumns(
        "CREATE TABLE `orders` (\n  `id` bigint NOT NULL,\n  `name` varchar(20),\n  PRIMARY KEY (`id`)\n)",
      ),
    ).toEqual(["id"]);
  });

  it("parses composite keys", () => {
    expect(
      extractPrimaryKeyColumns("CREATE TABLE t (`a` int, `b` int, PRIMARY KEY (`a`, `b`))"),
    ).toEqual(["a", "b"]);
  });

  it("returns an empty list when unavailable", () => {
    expect(extractPrimaryKeyColumns(undefined)).toEqual([]);
    expect(extractPrimaryKeyColumns("CREATE TABLE t (`id` int)")).toEqual([]);
  });
});
