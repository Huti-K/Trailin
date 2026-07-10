import type { SearchResult } from "@trailin/shared";

/**
 * Module-level handoff for the search palette's draft/document/memory hits.
 *
 * SearchPalette's openHit navigates to the hit's destination route and then
 * fires a CustomEvent for the panel to pick up. react-router's navigate is a
 * batched state update, so when the palette is used from a route other than
 * the hit's destination, HomePanel/KnowledgePanel aren't mounted yet when the
 * event fires — and window events aren't queued for a listener that shows up
 * later, so the dispatch is silently dropped.
 *
 * Stashing the same payload here lets the panel's mount effect pick it up
 * (read-and-clear, see the take* functions) even when the live listener
 * missed it. The CustomEvent path is unchanged and still handles the case
 * where the panel is already mounted.
 */

export interface DraftFocus {
  accountId: string;
  draftId: string;
}

export interface KnowledgeFocus {
  type: Extract<SearchResult["type"], "document" | "memory">;
  id: string;
}

let pendingDraftFocus: DraftFocus | null = null;
let pendingKnowledgeFocus: KnowledgeFocus | null = null;

export function setPendingDraftFocus(focus: DraftFocus): void {
  pendingDraftFocus = focus;
}

/** Reads and clears in one step — a mount effect only ever applies this once. */
export function takePendingDraftFocus(): DraftFocus | null {
  const focus = pendingDraftFocus;
  pendingDraftFocus = null;
  return focus;
}

export function setPendingKnowledgeFocus(focus: KnowledgeFocus): void {
  pendingKnowledgeFocus = focus;
}

/** Reads and clears in one step — a mount effect only ever applies this once. */
export function takePendingKnowledgeFocus(): KnowledgeFocus | null {
  const focus = pendingKnowledgeFocus;
  pendingKnowledgeFocus = null;
  return focus;
}
