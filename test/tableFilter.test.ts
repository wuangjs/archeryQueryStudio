import { describe, expect, it } from "vitest";
import { createTableNameMatcher } from "../src/tableFilter";

describe("createTableNameMatcher", () => {
  it("matches literal substrings case-insensitively", () => {
    const matcher = createTableNameMatcher("ORD", false);
    expect(matcher.test("orders")).toBe(true);
    expect(matcher.test("customers")).toBe(false);
  });

  it("matches regular expressions", () => {
    const matcher = createTableNameMatcher("^user_\\d+$", true);
    expect(matcher.test("user_12")).toBe(true);
    expect(matcher.test("user_admin")).toBe(false);
    expect(matcher.test("USER_7")).toBe(true);
  });

  it("reports invalid regular expressions", () => {
    const matcher = createTableNameMatcher("[", true);
    expect(matcher.error).toBeTruthy();
    expect(matcher.test("orders")).toBe(false);
  });

  it("matches everything for an empty term", () => {
    expect(createTableNameMatcher("", true).test("anything")).toBe(true);
  });
});
