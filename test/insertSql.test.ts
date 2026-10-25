import { describe, expect, it } from "vitest";
import {
  buildInsertStatements,
  insertModeLabel,
  InsertSqlError,
  supportsInsertMode,
} from "../src/insertSql";

const base = {
  columns: ["id", "name"],
  rows: [
    [1, "Alice"],
    [2, null],
  ],
  tableName: "orders",
  dbName: "shop",
  dbType: "mysql",
};

describe("buildInsertStatements", () => {
  it("builds normal INSERT statements", () => {
    const sql = buildInsertStatements(base);
    expect(sql).toContain("INSERT INTO `shop`.`orders` (`id`, `name`) VALUES (1, 'Alice');");
    expect(sql).toContain("INSERT INTO `shop`.`orders` (`id`, `name`) VALUES (2, NULL);");
    expect(sql).not.toContain("INSERT IGNORE");
    expect(sql).not.toContain("REPLACE");
  });

  it("builds MySQL INSERT IGNORE", () => {
    const sql = buildInsertStatements({ ...base, mode: "ignore" });
    expect(sql).toContain("INSERT IGNORE INTO `shop`.`orders`");
  });

  it("builds MySQL REPLACE", () => {
    const sql = buildInsertStatements({ ...base, mode: "replace" });
    expect(sql).toContain("REPLACE INTO `shop`.`orders`");
  });

  it("rejects replace/ignore for non-MySQL databases", () => {
    expect(() =>
      buildInsertStatements({ ...base, dbType: "pgsql", mode: "replace" }),
    ).toThrow(InsertSqlError);
    expect(() =>
      buildInsertStatements({ ...base, dbType: "pgsql", mode: "ignore" }),
    ).toThrow(InsertSqlError);
    expect(() =>
      buildInsertStatements({ ...base, dbType: "sqlite", mode: "replace" }),
    ).toThrow(InsertSqlError);
  });

  it("still builds normal INSERT for other databases", () => {
    const sql = buildInsertStatements({
      ...base,
      dbType: "pgsql",
      schemaName: "public",
      mode: "insert",
    });
    expect(sql).toContain('INSERT INTO "public"."orders" ("id", "name")');
  });

  it("escapes quotes and adds an optional header", () => {
    const sql = buildInsertStatements({
      ...base,
      columns: ["name"],
      rows: [["O'Reilly"]],
      header: true,
    });
    expect(sql).toContain("'O''Reilly'");
    expect(sql).toContain("-- 由 Archery Query Studio 导出");
  });

  it("reports mode support and labels", () => {
    expect(supportsInsertMode("mysql", "replace")).toBe(true);
    expect(supportsInsertMode("mariadb", "ignore")).toBe(true);
    expect(supportsInsertMode("pgsql", "ignore")).toBe(false);
    expect(supportsInsertMode("sqlite", "replace")).toBe(false);
    expect(insertModeLabel("replace")).toBe("覆盖插入");
    expect(insertModeLabel("ignore")).toBe("忽略插入");
    expect(insertModeLabel("insert")).toBe("普通插入");
  });
});
