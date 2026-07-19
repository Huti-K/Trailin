import * as React from "react";
import { useSearchParams } from "react-router-dom";
import { LibrarySection } from "./LibrarySection";

/**
 * Knowledge: the agent home browsed as files (memory, skills, documents).
 * A full-height workspace — the browser fills the canvas and scrolls its own
 * listing; the page itself never scrolls (App.tsx sizes it with a flex chain
 * instead of the reading-column max-width).
 */

/** How long a search-palette hit stays highlighted before it fades back. */
const HIGHLIGHT_MS = 2400;

export function KnowledgePanel() {
  // Set by the search palette (see SearchPalette.tsx) when a document/memory
  // hit is opened. Both land in the browser: node ids are the entry ids.
  const [focusId, setFocusId] = React.useState<string | null>(null);

  // The palette lands here with ?focus=<type>:<id>. Consumed once — the param
  // is cleared — so back/forward doesn't replay the highlight.
  const [searchParams, setSearchParams] = useSearchParams();
  const focusParam = searchParams.get("focus");
  React.useEffect(() => {
    if (!focusParam) return;
    const separator = focusParam.indexOf(":");
    if (separator > 0) {
      const type = focusParam.slice(0, separator);
      if (type === "memory" || type === "document") setFocusId(focusParam.slice(separator + 1));
    }
    setSearchParams({}, { replace: true });
  }, [focusParam, setSearchParams]);

  // Let the highlight fade once it has done its job. Clearing it also means
  // re-opening the same hit registers as a change and scrolls to it again.
  React.useEffect(() => {
    if (!focusId) return;
    const timer = setTimeout(() => setFocusId(null), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [focusId]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <LibrarySection focusId={focusId} />
    </div>
  );
}
