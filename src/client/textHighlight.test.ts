import { describe, expect, test } from "vitest";
import { splitTextByLiteralQuery, splitTextBySearchQuery } from "./textHighlight.ts";

describe("splitTextByLiteralQuery", () => {
  test("highlights every Chinese literal match", () => {
    expect(splitTextByLiteralQuery("会话搜索可以搜索会话", "会话")).toEqual([
      { value: "会话", highlighted: true },
      { value: "搜索可以搜索", highlighted: false },
      { value: "会话", highlighted: true },
    ]);
  });

  test("matches English text without case sensitivity", () => {
    expect(splitTextByLiteralQuery("Codex and CODEX", "codex")).toEqual([
      { value: "Codex", highlighted: true },
      { value: " and ", highlighted: false },
      { value: "CODEX", highlighted: true },
    ]);
  });

  test("treats regular expression characters as literal text", () => {
    expect(splitTextByLiteralQuery("Use [a-z]+, not a-z", "[a-z]+")).toEqual([
      { value: "Use ", highlighted: false },
      { value: "[a-z]+", highlighted: true },
      { value: ", not a-z", highlighted: false },
    ]);
  });

  test("preserves text and limits matches in very large messages", () => {
    const text = "a".repeat(600);
    const parts = splitTextByLiteralQuery(text, "a");
    expect(parts.map((part) => part.value).join("")).toBe(text);
    expect(parts.filter((part) => part.highlighted)).toHaveLength(500);
    expect(parts.at(-1)).toEqual({ value: "a".repeat(100), highlighted: false });
  });

  test("returns the original text for an empty or missing query", () => {
    expect(splitTextByLiteralQuery("session", "")).toEqual([
      { value: "session", highlighted: false },
    ]);
    expect(splitTextByLiteralQuery("session", "missing")).toEqual([
      { value: "session", highlighted: false },
    ]);
  });

  test("highlights each unquoted term and quoted phrase", () => {
    expect(splitTextBySearchQuery(
      "推送完成，GitHub Actions 将部署到家中服务器",
      '推送 "GitHub Actions" 家中服务器',
    )).toEqual([
      { value: "推送", highlighted: true },
      { value: "完成，", highlighted: false },
      { value: "GitHub Actions", highlighted: true },
      { value: " 将部署到", highlighted: false },
      { value: "家中服务器", highlighted: true },
    ]);
  });
});
