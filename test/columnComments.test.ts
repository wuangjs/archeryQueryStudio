import { describe, expect, it } from "vitest";
import { extractColumnComments } from "../src/columnComments";

describe("extractColumnComments", () => {
  it("parses MySQL SHOW CREATE TABLE comments", () => {
    const ddl = [
      "CREATE TABLE `orders` (",
      "  `id` bigint NOT NULL AUTO_INCREMENT COMMENT '主键',",
      "  `note` varchar(255) DEFAULT NULL COMMENT '备注，含逗号',",
      "  `quoted` varchar(10) DEFAULT NULL COMMENT 'it''s ok',",
      "  `status` enum('paid','pending') NOT NULL DEFAULT 'pending' COMMENT '状态',",
      "  PRIMARY KEY (`id`)",
      ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='订单表'",
    ].join("\n");
    expect(extractColumnComments([], [], ddl, "mysql")).toEqual({
      id: "主键",
      note: "备注，含逗号",
      quoted: "it's ok",
      status: "状态",
    });
  });

  it("parses PostgreSQL/Oracle comment result rows", () => {
    expect(
      extractColumnComments(
        ["column_name", "data_type", "is_nullable", "description"],
        [
          ["id", "bigint", "NO", "主键"],
          ["note", "text", "YES", "备注"],
        ],
        undefined,
        "postgresql",
      ),
    ).toEqual({ id: "主键", note: "备注" });

    expect(
      extractColumnComments(
        ["COLUMN_NAME", "DATA_TYPE", "NULLABLE", "COMMENTS"],
        [
          ["ID", "NUMBER", "N", "主键"],
          ["NOTE", "VARCHAR2", "Y", "备注"],
        ],
        undefined,
        "oracle",
      ),
    ).toEqual({ ID: "主键", NOTE: "备注" });
  });

  it("returns an empty map when the response has no comment metadata", () => {
    expect(extractColumnComments(["id", "name"], [[1, "a"]], undefined, "mysql")).toEqual({});
  });
});
