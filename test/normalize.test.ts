import { describe, expect, it } from "vitest";
import {
  normalizeExecution,
  normalizeInstances,
  normalizeQueryLogs,
  normalizeResources,
  unwrapEnvelope,
} from "../src/archery/normalize";

describe("normalize", () => {
  it("unwraps standard Archery envelopes", () => {
    expect(unwrapEnvelope({ status: 0, msg: "ok", data: [1, 2] })).toEqual([1, 2]);
    expect(unwrapEnvelope({ total: 0, rows: [] })).toEqual({ total: 0, rows: [] });
  });

  it("normalizes instance and resource aliases", () => {
    expect(
      normalizeInstances({
        status: 0,
        msg: "ok",
        data: [{ id: "3", instance_name: "prod", db_type: "MySQL" }, { name: "fallback" }],
      }).map((item) => item.instance_name),
    ).toEqual(["prod", "fallback"]);
    expect(
      normalizeResources({
        status: 0,
        msg: "ok",
        data: ["db1", { table_name: "orders" }, { name: "users" }],
      }).map((item) => item.name),
    ).toEqual(["db1", "orders", "users"]);
  });

  it("normalizes object rows and arrays from older engines", () => {
    const result = normalizeExecution({
      status: 0,
      msg: "ok",
      data: { rows: [{ id: 1, name: "a" }, { id: 2, name: "b" }], query_time: "0.5" },
    });
    expect(result.columns).toEqual(["id", "name"]);
    expect(result.rows).toEqual([
      [1, "a"],
      [2, "b"],
    ]);
    expect(result.queryTime).toBe(0.5);
  });

  it("throws query errors with the Archery message", () => {
    expect(() => normalizeExecution({ status: 1, msg: "denied", data: {} })).toThrowError("denied");
  });

  it("normalizes query history across payload shapes", () => {
    const page = normalizeQueryLogs({
      status: 0,
      msg: "ok",
      data: {
        total: 1,
        rows: [
          {
            id: 1,
            instance_name: "prod",
            db_name: "shop",
            sqllog: "select 1",
            effect_row: 1,
            cost_time: 0.01,
          },
        ],
      },
    });
    expect(page.total).toBe(1);
    expect(page.rows[0].sql).toBe("select 1");
  });

  it("normalizes scalar and array result payloads", () => {
    expect(normalizeExecution({ status: 0, msg: "ok", data: "done" }).rows).toEqual([["done"]]);
    const array = normalizeExecution([{ a: 1 }, { a: 2 }]);
    expect(array.columns).toEqual(["a"]);
    expect(array.rows).toEqual([[1], [2]]);
  });
});
