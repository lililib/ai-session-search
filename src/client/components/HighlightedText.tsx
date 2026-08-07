import { Fragment } from "react";
import { splitTextBySearchQuery } from "../textHighlight.ts";

export const HighlightedText = ({ text, query }: { text: string; query: string }) =>
  splitTextBySearchQuery(text, query).map((part, index) =>
    part.highlighted ? (
      <mark className="search-highlight" key={index}>{part.value}</mark>
    ) : (
      <Fragment key={index}>{part.value}</Fragment>
    ),
  );
