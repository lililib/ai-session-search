export const nextHighlightIndex = (currentIndex: number, total: number): number =>
  total <= 0 ? -1 : (currentIndex + 1 + total) % total;
