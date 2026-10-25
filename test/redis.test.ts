import { describe, expect, it } from "vitest";
import {
  buildRedisScanCommand,
  buildRedisTypeCommand,
  isRedisDbType,
  parseRedisScanRows,
  quoteRedisArgument,
} from "../src/redis";

describe("redis helpers", () => {
  it("identifies redis instances", () => {
    expect(isRedisDbType("redis")).toBe(true);
    expect(isRedisDbType("REDIS")).toBe(true);
    expect(isRedisDbType("mysql")).toBe(false);
  });

  it("quotes scan patterns and builds SCAN", () => {
    expect(quoteRedisArgument('user:* "x"')).toBe('"user:* \\"x\\""');
    expect(buildRedisScanCommand("user:*", 500)).toBe(
      'SCAN 0 MATCH "user:*" COUNT 500',
    );
    expect(buildRedisScanCommand("")).toBe('SCAN 0 MATCH "*" COUNT 1000');
  });

  it("builds TYPE commands", () => {
    expect(buildRedisTypeCommand("user:1")).toBe('TYPE "user:1"');
  });

  it("parses SCAN rows and skips the cursor", () => {
    expect(parseRedisScanRows([["0"], ["a"], ["b"]] )).toEqual(["a", "b"]);
    expect(parseRedisScanRows([])).toEqual([]);
  });
});

import { buildRedisDataCommand, parseRedisKeyType } from "../src/redis";

describe("redis key type commands", () => {
  it("parses TYPE results", () => {
    expect(parseRedisKeyType([["hash"]])).toBe("hash");
    expect(parseRedisKeyType([], "string")).toBe("string");
  });

  it("builds read commands by type", () => {
    expect(buildRedisDataCommand("user:1", "string")).toBe('GET "user:1"');
    expect(buildRedisDataCommand("user:1", "hash")).toBe('HGETALL "user:1"');
    expect(buildRedisDataCommand("user:1", "list")).toBe('LRANGE "user:1" 0 999');
    expect(buildRedisDataCommand("user:1", "set")).toBe('SMEMBERS "user:1"');
    expect(buildRedisDataCommand("user:1", "zset")).toBe(
      'ZRANGE "user:1" 0 999 WITHSCORES',
    );
    expect(buildRedisDataCommand("user:1", "stream")).toBe(
      'XRANGE "user:1" - + COUNT 1000',
    );
    expect(buildRedisDataCommand("user:1", "none")).toBeUndefined();
  });
});

import { normalizeRedisKeyPattern } from "../src/redis";

describe("normalizeRedisKeyPattern", () => {
  it("adds missing wildcards on both sides", () => {
    expect(normalizeRedisKeyPattern("user")).toBe("*user*");
    expect(normalizeRedisKeyPattern("user*")).toBe("*user*");
    expect(normalizeRedisKeyPattern("*user")).toBe("*user*");
    expect(normalizeRedisKeyPattern("*user*")).toBe("*user*");
  });

  it("handles empty and wildcard-only input", () => {
    expect(normalizeRedisKeyPattern("")).toBe("*");
    expect(normalizeRedisKeyPattern("*")).toBe("*");
  });
});
