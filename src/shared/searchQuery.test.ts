import { describe, expect, test } from "vitest";
import { parseSearchTerms } from "./searchQuery.ts";

describe("parseSearchTerms", () => {
  test("splits unquoted terms and preserves quoted phrases", () => {
    expect(parseSearchTerms('  推送   "家中服务器"  "GitHub Actions" ')).toEqual([
      "推送",
      "家中服务器",
      "GitHub Actions",
    ]);
  });

  test("deduplicates terms case-insensitively and limits their count", () => {
    expect(parseSearchTerms("Codex codex one two three", 3)).toEqual([
      "Codex",
      "one",
      "two",
    ]);
  });

  test("tolerates an unmatched quote", () => {
    expect(parseSearchTerms('推送 "家中服务器')).toEqual(["推送", "家中服务器"]);
  });
});
