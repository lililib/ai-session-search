import { describe, expect, test } from "vitest";
import { nextHighlightIndex } from "./conversationNavigation.ts";

describe("nextHighlightIndex", () => {
  test("starts at the first highlight", () => {
    expect(nextHighlightIndex(-1, 3)).toBe(0);
  });

  test("advances and wraps to the first highlight", () => {
    expect(nextHighlightIndex(0, 3)).toBe(1);
    expect(nextHighlightIndex(2, 3)).toBe(0);
  });

  test("returns no position when there are no highlights", () => {
    expect(nextHighlightIndex(0, 0)).toBe(-1);
  });
});
