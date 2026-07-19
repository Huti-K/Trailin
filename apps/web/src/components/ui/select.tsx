import { Check, ChevronDown } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

const LIST_MAX_HEIGHT = 240; // Tailwind's max-h-60
const LIST_MIN_HEIGHT = 128; // never squeeze below ~4 rows, even on short windows
const LIST_VIEWPORT_MARGIN = 12; // field↔list gap plus breathing room at the viewport edge
const LIST_ROW_HEIGHT = 34; // pre-render estimate of one option row incl. gap
const LIST_CHROME = 10; // listbox padding + border

// Scroll only the listbox. scrollIntoView would also scroll every scrollable
// ancestor, yanking the whole page whenever the list pokes past the viewport.
function scrollRowIntoView(list: HTMLDivElement | null, selector: string) {
  const el = list?.querySelector<HTMLElement>(selector);
  if (!list || !el) return;
  if (el.offsetTop < list.scrollTop) {
    list.scrollTop = el.offsetTop;
  } else if (el.offsetTop + el.offsetHeight > list.scrollTop + list.clientHeight) {
    list.scrollTop = el.offsetTop + el.offsetHeight - list.clientHeight;
  }
}

/**
 * Dropdown select. Plain by default; pass `searchable` for a type-to-filter
 * combobox — only worth it on long lists (languages, timezones), not on
 * two-or-three-option pickers.
 *
 * Mouse and keyboard share one `highlighted` row so the active option is
 * never ambiguous: accent tint = chosen, neutral fill = active.
 */
export function Select({
  id,
  value,
  onChange,
  options,
  className,
  placeholder,
  searchable = false,
  "aria-label": ariaLabel,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  className?: string;
  /** Shown when nothing is selected yet; defaults to a localized "Select…". */
  placeholder?: string;
  /** Opt-in type-to-filter for long option lists. */
  searchable?: boolean;
  "aria-label"?: string;
}) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const [highlighted, setHighlighted] = React.useState(0);
  const [placement, setPlacement] = React.useState({ dropUp: false, maxHeight: LIST_MAX_HEIGHT });
  const containerRef = React.useRef<HTMLDivElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  // While arrowing, the list scrolls under a stationary cursor and would fire
  // mouse events that steal the highlight back — real mouse movement clears it.
  const keyNav = React.useRef(false);

  const selectedOption = options.find((o) => o.value === value);
  const displayValue = searchable && isOpen ? search : selectedOption?.label || "";

  const filteredOptions = searchable
    ? options.filter((o) => o.label.toLowerCase().includes(search.toLowerCase()))
    : options;

  // Measured once per open. Below is home: a list that doesn't fully fit
  // shrinks and scrolls there first, and only flips above the field when
  // below can't even show a comfortable minimum and above offers more room.
  const measurePlacement = () => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const spaceBelow = window.innerHeight - rect.bottom - LIST_VIEWPORT_MARGIN;
    const spaceAbove = rect.top - LIST_VIEWPORT_MARGIN;
    const needed = Math.min(LIST_MAX_HEIGHT, options.length * LIST_ROW_HEIGHT + LIST_CHROME);
    const dropUp = spaceBelow < needed && spaceBelow < LIST_MIN_HEIGHT && spaceAbove > spaceBelow;
    const maxHeight = Math.min(
      LIST_MAX_HEIGHT,
      Math.max(LIST_MIN_HEIGHT, dropUp ? spaceAbove : spaceBelow),
    );
    setPlacement({ dropUp, maxHeight });
  };

  const open = () => {
    measurePlacement();
    setSearch("");
    setHighlighted(
      Math.max(
        0,
        options.findIndex((o) => o.value === value),
      ),
    );
    setIsOpen(true);
  };
  const close = () => {
    setIsOpen(false);
    setSearch("");
  };
  const commit = (option: { value: string; label: string }) => {
    onChange(option.value);
    close();
  };

  React.useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
        setSearch("");
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Anchor the eye on open: the current value starts visible.
  React.useEffect(() => {
    if (!isOpen) return;
    scrollRowIntoView(listRef.current, '[data-selected="true"]');
  }, [isOpen]);

  // Keep the active row visible while arrowing through a long list.
  // biome-ignore lint/correctness/useExhaustiveDependencies: highlighted isn't read here — it drives which DOM node the [data-highlighted] query matches after re-render, so the effect must re-run whenever it changes
  React.useEffect(() => {
    if (!isOpen || !keyNav.current) return;
    scrollRowIntoView(listRef.current, '[data-highlighted="true"]');
  }, [highlighted, isOpen]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      keyNav.current = true;
      if (!isOpen) {
        open();
        return;
      }
      const delta = e.key === "ArrowDown" ? 1 : -1;
      setHighlighted((h) => Math.min(filteredOptions.length - 1, Math.max(0, h + delta)));
    } else if (e.key === "Enter" || (!searchable && e.key === " ")) {
      if (!isOpen) {
        // Enter on a closed searchable field falls through to the form.
        if (!searchable) {
          e.preventDefault();
          open();
        }
        return;
      }
      e.preventDefault();
      const option = filteredOptions[highlighted];
      if (option) commit(option);
    } else if (e.key === "Escape") {
      if (!isOpen) return;
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "Tab") {
      if (isOpen) close();
    }
  };

  return (
    <div className={cn("relative w-full", className)} ref={containerRef}>
      <div className="relative flex items-center w-full">
        <input
          ref={inputRef}
          id={id}
          type="text"
          role="combobox"
          aria-expanded={isOpen}
          aria-controls={`${id}-listbox`}
          aria-autocomplete={searchable ? "list" : "none"}
          aria-activedescendant={
            isOpen && filteredOptions[highlighted] ? `${id}-option-${highlighted}` : undefined
          }
          value={displayValue}
          aria-label={ariaLabel}
          readOnly={!searchable}
          onChange={(e) => {
            setSearch(e.target.value);
            setHighlighted(0);
            if (!isOpen) {
              measurePlacement();
              setIsOpen(true);
            }
          }}
          onClick={() => {
            if (searchable) {
              if (!isOpen) open();
            } else {
              if (isOpen) close();
              else open();
            }
          }}
          onKeyDown={handleKeyDown}
          className={cn("field h-9 w-full px-3 text-sm pr-8", !searchable && "cursor-pointer")}
          placeholder={selectedOption?.label || placeholder || t("ui.select.placeholder")}
          autoComplete="off"
          spellCheck={false}
        />
        <ChevronDown
          aria-hidden
          className={cn(
            "pointer-events-none absolute right-2.5 h-4 w-4 text-muted-foreground transition-transform duration-200",
            isOpen && "rotate-180",
          )}
        />
      </div>

      {isOpen && (
        <div
          ref={listRef}
          id={`${id}-listbox`}
          role="listbox"
          style={{ maxHeight: placement.maxHeight }}
          className={cn(
            "surface-pop absolute z-50 flex w-full flex-col gap-0.5 overflow-y-auto p-1",
            placement.dropUp ? "animate-in-down bottom-full mb-1" : "animate-in-up mt-1",
          )}
        >
          {filteredOptions.length === 0 ? (
            <div className="p-2 text-center text-sm text-muted-foreground">
              {t("ui.select.noResults")}
            </div>
          ) : (
            filteredOptions.map((option, index) => {
              const isSelected = value === option.value;
              const isActive = index === highlighted;
              return (
                // Options stay out of the tab order by design: the input above is the
                // combobox's one real focus target, and aria-activedescendant (set from
                // `highlighted`) plus the input's own onKeyDown carry all keyboard
                // interaction — giving each option its own tab stop would fight that.
                // biome-ignore lint/a11y/useFocusableInteractive: aria-activedescendant pattern — the input owns focus, not the option
                // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard interaction goes through the input's onKeyDown, not this row
                <div
                  key={option.value}
                  id={`${id}-option-${index}`}
                  role="option"
                  aria-selected={isSelected}
                  data-selected={isSelected || undefined}
                  data-highlighted={isActive || undefined}
                  onMouseMove={() => {
                    keyNav.current = false;
                    if (highlighted !== index) setHighlighted(index);
                  }}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => commit(option)}
                  className={cn(
                    "relative flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none",
                    isSelected
                      ? isActive
                        ? "bg-accent/26 text-accent"
                        : "bg-accent/18 text-accent"
                      : isActive
                        ? "bg-surface-2 text-foreground"
                        : "text-foreground",
                  )}
                >
                  <span className="flex-1 truncate">{option.label}</span>
                  {isSelected && <Check className="ml-2 h-4 w-4 shrink-0" />}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
