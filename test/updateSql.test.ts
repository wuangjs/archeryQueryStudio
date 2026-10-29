import { describe, expect, it } from "vitest";
import { buildUpdateStatements, UpdateSqlError } from "../src/updateSql";

const base = {
  columns: ["id", "name", "note"],
  tableName: "orders",
  dbName: "shop",
  dbType: "mysql",
};

describe("buildUpdateStatements", () => {
  it("builds updates using the primary key", () => {
    const sql = buildUpdateStatements({
      ...base,
      primaryKey: ["id"],
      updates: [
        {
          originalRow: [1, "Alice", null],
          changes: [{ columnIndex: 1, value: "Alicia" }],
        },
      ],
    });
    expect(sql).toBe(
      "UPDATE `shop`.`orders` SET `name` = 'Alicia' WHERE `id` = 1;\n",
    );
  });

  it("uses all original columns when no key is available", () => {
    const sql = buildUpdateStatements({
      ...base,
      updates: [
        {
          originalRow: [7, "Bob", null],
          changes: [{ columnIndex: 2, value: "note" }],
        },
      ],
    });
    expect(sql).toContain(
      "SET `note` = 'note' WHERE `id` = 7 AND `name` = 'Bob' AND `note` IS NULL;",
    );
  });

  it("supports NULL assignments and composite keys", () => {
    const sql = buildUpdateStatements({
      ...base,
      primaryKey: ["id", "name"],
      updates: [
        {
          originalRow: [1, "Alice", "old"],
          changes: [{ columnIndex: 2, value: null }],
        },
      ],
    });
    expect(sql).toContain("SET `note` = NULL WHERE `id` = 1 AND `name` = 'Alice';");
  });

  it("validates table and updates", () => {
    expect(() =>
      buildUpdateStatements({ ...base, tableName: "", updates: [] }),
    ).toThrow(UpdateSqlError);
    expect(() =>
      buildUpdateStatements({ ...base, updates: [] }),
    ).toThrow(UpdateSqlError);
  });
});
