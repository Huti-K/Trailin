import * as React from "react";

interface UseResizableWidthOptions {
  /** localStorage key the width is persisted under. */
  storageKey: string;
  defaultWidth: number;
  min: number;
  max: number;
  /** Which screen edge the panel is docked to — sets which drag direction grows it. */
  edge: "left" | "right";
}

function readStored(key: string, min: number, max: number, fallback: number): number {
  if (typeof window === "undefined") return fallback;
  const saved = Number(window.localStorage.getItem(key));
  return saved >= min && saved <= max ? saved : fallback;
}

/** Drag-to-resize width for a docked side panel, persisted across reloads. */
export function useResizableWidth({
  storageKey,
  defaultWidth,
  min,
  max,
  edge,
}: UseResizableWidthOptions) {
  const [width, setWidth] = React.useState(() => readStored(storageKey, min, max, defaultWidth));

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMove = (ev: PointerEvent) => {
      const delta = ev.clientX - startX;
      const next = edge === "right" ? startWidth - delta : startWidth + delta;
      setWidth(Math.min(max, Math.max(min, next)));
    };
    const onUp = () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    // A drag can be interrupted (touch gesture takeover, pen leaving range, OS
    // pointer steal) without a pointerup — without this the listener and the
    // body cursor/user-select styles would leak past the drag.
    window.addEventListener("pointercancel", onUp);
  };

  React.useEffect(() => {
    window.localStorage.setItem(storageKey, String(width));
  }, [storageKey, width]);

  return { width, onPointerDown };
}
