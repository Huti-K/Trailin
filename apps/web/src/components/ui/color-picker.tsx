import * as React from "react";
import { createPortal } from "react-dom";
import { HexColorPicker } from "react-colorful";
import { useTranslation } from "react-i18next";

interface ColorPickerProps {
  color: string; // current hex
  onSelect: (hex: string) => void;
}

const VIEWPORT_MARGIN = 8;
const TRIGGER_GAP = 8;

/**
 * A beautiful custom color picker using react-colorful.
 * Ensures consistent UI across Windows/Mac instead of the native OS picker.
 *
 * The popover is portaled to <body> and positioned off the trigger's viewport
 * rect — rendering it in place traps it in whatever stacking context the row
 * happens to create (account rows set zIndex, cards animate transforms) and
 * lets scroll containers clip it.
 */
export function ColorPicker({ color, onSelect }: ColorPickerProps) {
  const { t } = useTranslation();
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const popoverRef = React.useRef<HTMLDivElement>(null);
  const [open, setOpen] = React.useState(false);
  const [pos, setPos] = React.useState<{ left: number; top: number } | null>(null);

  const updatePosition = React.useCallback(() => {
    const trigger = triggerRef.current;
    const popover = popoverRef.current;
    if (!trigger || !popover) return;
    const rect = trigger.getBoundingClientRect();
    const { width, height } = popover.getBoundingClientRect();

    const left = Math.min(
      Math.max(rect.left + rect.width / 2 - width / 2, VIEWPORT_MARGIN),
      window.innerWidth - width - VIEWPORT_MARGIN,
    );

    // Below the trigger; flip above when it doesn't fit but the top does.
    let top = rect.bottom + TRIGGER_GAP;
    if (top + height > window.innerHeight - VIEWPORT_MARGIN) {
      const above = rect.top - TRIGGER_GAP - height;
      if (above >= VIEWPORT_MARGIN) top = above;
    }

    setPos({ left, top });
  }, []);

  React.useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    updatePosition();
  }, [open, updatePosition]);

  React.useEffect(() => {
    if (!open) return;
    const handlePointer = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handlePointer);
    document.addEventListener("keydown", handleKey);
    // Capture phase so scrolling any ancestor container re-anchors the popover.
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("resize", updatePosition);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("keydown", handleKey);
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("resize", updatePosition);
    };
  }, [open, updatePosition]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        className="h-4 w-4 shrink-0 rounded-full transition-transform hover:scale-110 border border-border shadow-sm"
        style={{ backgroundColor: color }}
        title={t("connections.accountColor")}
      />

      {open &&
        createPortal(
          <div
            ref={popoverRef}
            className="surface-pop animate-in-up fixed z-[130] p-3 flex flex-col gap-3 rounded-xl"
            style={pos ?? { left: 0, top: 0, visibility: "hidden" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="react-colorful-custom">
              <HexColorPicker color={color} onChange={onSelect} />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider pl-1">Hex</span>
              <input
                type="text"
                value={color}
                onChange={(e) => onSelect(e.target.value)}
                className="field w-full px-2 py-1 text-xs font-mono uppercase"
                spellCheck={false}
              />
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
