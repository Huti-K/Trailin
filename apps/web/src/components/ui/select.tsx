import * as React from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { ChevronDown, Check } from "lucide-react";

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
  const containerRef = React.useRef<HTMLDivElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  // While arrowing, the list scrolls under a stationary cursor and would fire
  // mouse events that steal the highlight back — real mouse movement clears it.
  const keyNav = React.useRef(false);

  const selectedOption = options.find((o) => o.value === value);
  const displayValue = searchable && isOpen ? search : (selectedOption?.label || "");

  const filteredOptions = searchable
    ? options.filter((o) => o.label.toLowerCase().includes(search.toLowerCase()))
    : options;

  const open = () => {
    setSearch("");
    setHighlighted(Math.max(0, options.findIndex((o) => o.value === value)));
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
    listRef.current
      ?.querySelector('[data-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [isOpen]);

  // Keep the active row visible while arrowing through a long list.
  React.useEffect(() => {
    if (!isOpen || !keyNav.current) return;
    listRef.current
      ?.querySelector('[data-highlighted="true"]')
      ?.scrollIntoView({ block: "nearest" });
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
            if (!isOpen) setIsOpen(true);
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
            isOpen && "rotate-180"
          )}
        />
      </div>

      {isOpen && (
        <div
          ref={listRef}
          id={`${id}-listbox`}
          role="listbox"
          className="surface-pop animate-in-up absolute z-50 mt-1 flex max-h-60 w-full flex-col gap-0.5 overflow-y-auto p-1"
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
                        : "text-foreground"
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
