import { parseSearchTerms } from "../shared/searchQuery.ts";

export type HighlightedTextPart = {
  value: string;
  highlighted: boolean;
};

const MAX_HIGHLIGHT_MATCHES = 500;

const escapeRegularExpression = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const splitTextByLiteralQuery = (
  text: string,
  query: string,
  maxMatches = MAX_HIGHLIGHT_MATCHES,
): HighlightedTextPart[] => {
  if (query === "" || maxMatches <= 0) return [{ value: text, highlighted: false }];
  const expression = new RegExp(escapeRegularExpression(query), "giu");
  const parts: HighlightedTextPart[] = [];
  let previousEnd = 0;
  let matchCount = 0;
  let match = expression.exec(text);

  while (match !== null && matchCount < maxMatches) {
    if (match.index > previousEnd) {
      parts.push({ value: text.slice(previousEnd, match.index), highlighted: false });
    }
    parts.push({ value: match[0], highlighted: true });
    previousEnd = match.index + match[0].length;
    matchCount += 1;
    match = expression.exec(text);
  }
  if (previousEnd < text.length) {
    parts.push({ value: text.slice(previousEnd), highlighted: false });
  }
  return parts.length === 0 ? [{ value: text, highlighted: false }] : parts;
};

export const splitTextBySearchQuery = (
  text: string,
  query: string,
  maxMatches = MAX_HIGHLIGHT_MATCHES,
): HighlightedTextPart[] => {
  const terms = parseSearchTerms(query).sort((left, right) => right.length - left.length);
  if (terms.length === 0 || maxMatches <= 0) return [{ value: text, highlighted: false }];
  const expression = new RegExp(terms.map(escapeRegularExpression).join("|"), "giu");
  const parts: HighlightedTextPart[] = [];
  let previousEnd = 0;
  let matchCount = 0;
  let match = expression.exec(text);

  while (match !== null && matchCount < maxMatches) {
    if (match.index > previousEnd) {
      parts.push({ value: text.slice(previousEnd, match.index), highlighted: false });
    }
    parts.push({ value: match[0], highlighted: true });
    previousEnd = match.index + match[0].length;
    matchCount += 1;
    match = expression.exec(text);
  }
  if (previousEnd < text.length) {
    parts.push({ value: text.slice(previousEnd), highlighted: false });
  }
  return parts.length === 0 ? [{ value: text, highlighted: false }] : parts;
};
