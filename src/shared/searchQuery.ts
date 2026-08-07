const DEFAULT_MAX_SEARCH_TERMS = 10;
const QUOTE_PAIRS: Readonly<Record<string, string>> = {
  '"': '"',
  "'": "'",
  "“": "”",
  "‘": "’",
};

export const parseSearchTerms = (
  query: string,
  maxTerms = DEFAULT_MAX_SEARCH_TERMS,
): string[] => {
  if (maxTerms <= 0) return [];
  const terms: string[] = [];
  let current = "";
  let closingQuote = "";

  const pushCurrent = (): void => {
    const term = current.trim();
    current = "";
    if (term === "") return;
    const normalized = term.toLocaleLowerCase();
    if (terms.some((existing) => existing.toLocaleLowerCase() === normalized)) return;
    if (terms.length < maxTerms) terms.push(term);
  };

  for (const character of query.trim()) {
    if (closingQuote !== "") {
      if (character === closingQuote) closingQuote = "";
      else current += character;
      continue;
    }
    const matchingQuote = QUOTE_PAIRS[character];
    if (matchingQuote !== undefined) {
      closingQuote = matchingQuote;
      continue;
    }
    if (/\s/u.test(character)) pushCurrent();
    else current += character;
  }
  pushCurrent();
  return terms;
};
