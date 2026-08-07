export const ConversationNavigation = ({
  currentHighlightIndex,
  highlightCount,
  labels,
  onTop,
  onNextHighlight,
  onBottom,
}: {
  currentHighlightIndex: number;
  highlightCount: number;
  labels: {
    navigation: string;
    top: string;
    nextHighlight: string;
    bottom: string;
  };
  onTop: () => void;
  onNextHighlight: () => void;
  onBottom: () => void;
}) => {
  const matchPosition = highlightCount === 0
    ? ""
    : `${Math.max(0, currentHighlightIndex + 1)}/${highlightCount}`;

  return (
    <nav className="conversation-navigation" aria-label={labels.navigation}>
      <button type="button" title={labels.top} aria-label={labels.top} onClick={onTop}>
        <span aria-hidden="true">↑</span>
        <span>{labels.top}</span>
      </button>
      <button
        type="button"
        title={labels.nextHighlight}
        aria-label={labels.nextHighlight}
        disabled={highlightCount === 0}
        onClick={onNextHighlight}
      >
        <span aria-hidden="true">⌕</span>
        <span>{labels.nextHighlight}</span>
        {matchPosition !== "" && <small>{matchPosition}</small>}
      </button>
      <button type="button" title={labels.bottom} aria-label={labels.bottom} onClick={onBottom}>
        <span aria-hidden="true">↓</span>
        <span>{labels.bottom}</span>
      </button>
    </nav>
  );
};
