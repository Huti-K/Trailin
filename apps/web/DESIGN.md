# Trailin — Design Rules

The Trailin UI is **borderless neutral minimalism**. Think a quiet document, not a
dashboard. Structure comes from *space and surface tone*, never from lines. Color is a
scarce resource used for meaning, not decoration.

These rules are binding. If a change would break one, change the rule here first.

## The two hard constraints

1. **No borders, outlines, or strokes.** Nothing has a visible edge line at rest — no
   `border`, no `divide-*`, no outlined buttons, no ring at rest, no hairline dividers.
   Separation is achieved with surface tone and whitespace. (The one exception is the
   keyboard `:focus-visible` ring, which exists only for accessibility and only appears
   during keyboard navigation.)
2. **No card-in-card.** A surface is never nested inside another surface. Group content
   with a section heading + whitespace. If you need one elevated panel, it holds plain
   rows — not more panels.

## Surfaces — depth by tone, three levels only

| Token         | Role                                             | When to use                          |
| ------------- | ------------------------------------------------ | ------------------------------------ |
| `background`  | The canvas. Everything sits on it.               | Page body, main content column       |
| `surface`     | One step **up** (lighter in light, lighter in dark). | An elevated panel: composer, one grouped block |
| `surface-2` / `muted` | One step **down**, recessed.             | Inputs, chips, hover fills, list-row fills |

Never stack `surface` on `surface`. A grouped block is `surface`; the rows inside it are
bare or `surface-2` on hover — that is the maximum depth.

**Fills recess against what they sit on, not against the page.** Raw `surface-2` on a
`surface` panel is near-invisible (worst in dark, ~0.04 L apart), so recessed and tonal
fills are painted through derived variables (`--surface-2-fill`, `--secondary-fill`)
that step one tone further inside any `.surface`/`.surface-soft`/`.surface-pop`. This is
automatic — `bg-surface-2`, `bg-secondary`, `.field`, `.tint-neutral`, and `.skeleton`
all route through it. Never hand-pick a darker gray to make a control read inside a
card; if contrast is still short, the fix belongs in the fill variables in `index.css`.

**Anchored floating panels use `.surface-pop`, not `.surface-soft`.** Select menus and
the color picker float over content with no scrim: in light mode the shadow lifts them,
but dark shadows vanish, so `.surface-pop` steps the panel itself one tone brighter than
a card in dark mode. Dialogs keep `.surface-soft` — the scrim already separates them.

## Color

- **Ink is the brand.** Primary actions (buttons, the send control, the user's chat
  bubble) are near-black warm charcoal in light mode, near-white in dark mode. This is
  what reads as "premium and clean."
- **Slate blue is the single accent** (`accent`). It appears only on: the logo mark, the
  active nav item, links, the switch's on-state, and the focus ring. Never fill a large
  area with it.
- **Semantic colors are muted pastels**, used only for status: emerald = healthy/success,
  amber = attention/paused, red = destructive/error. Always low-chroma. Rendered as a
  pale tinted background + a darker text tone (see `Badge`).
- Body text is cool charcoal (`foreground`), never pure black. Secondary text is
  `muted-foreground`.

## Type

- **Geist Sans** for everything UI. **Geist Mono** for schedules, model ids, codes,
  timestamps — anything data-shaped (also gets `tabular-nums`).
- Hierarchy is built with **weight and color**, not size jumps. Section titles are
  `text-sm font-semibold`; their descriptions are `text-xs/text-sm text-muted-foreground`.
- Tighten tracking on headings (`tracking-tight`).

## Shape & elevation

- Radius: `--radius` (0.7rem ≈ 11px) for panels/inputs/buttons; smaller for chips. No
  `rounded-full` on primary buttons or in-flow containers — pills are reserved for status
  badges, filter chips (the shared `Chip`), and floating chrome (the dock).
- **Shadows are almost invisible.** Only elevated `surface` panels (composer, popover-like
  blocks) get a soft, low-opacity, warm-tinted shadow to lift them off the canvas without
  a line. Flat sections get none.

## Floating chrome — dock, dialogs & command palette

Elements that float *over* content (the dock nav, dialogs, the Cmd+K palette) get
deeper elevation: a soft high-blur shadow lifts the panel, and everything modal shares
the `.scrim` backdrop — a light dim plus a **2px** backdrop blur. Backdrop blur is
welcome on floating chrome and scrims; just keep it turned down. The page underneath
should stay readable through it, never frost over. Everything else about floating
panels still follows the rules above:

- **Zones inside a floating panel separate by tone, never by line.** The palette's
  preview pane and footer are recessed fills (`surface-2/50`) on the panel surface —
  the borderless equivalent of a divider.
- **Loading is an accent sweep, not a spinner swap.** While a query is in flight the
  previous results stay on screen and a thin accent bar sweeps; the strip is invisible
  at rest.
- **Matched text** is marked with the same pale accent tint as `::selection`
  (`accent` at ~22%), so "found" and "selected" read as one idea.

## Texture

- A fixed, near-invisible SVG grain overlays the whole app (`body::before`,
  soft-light) so large surfaces read as paper, not flat vector.
- Scrollbars are thin, trackless, and rounded; `scrollbar-gutter: stable` wherever a
  list can grow, so nothing shifts when one appears.

## Layout & motion

- Lead with macro-whitespace. Sections are separated by generous vertical gaps
  (`gap-8`/`gap-10`), not rules.
- Content column is constrained (`max-w-3xl` for settings-style pages).
- Motion is quiet: content rises `6px` and fades in over ~360ms; lists stagger. Animate
  only `transform`/`opacity`. Respect `prefers-reduced-motion`.

## Component conventions

- **Inputs / textareas / selects:** filled `surface-2`, no border, focus lightens the fill
  plus the a11y ring.
- **Buttons:** `default` = ink fill; `secondary`/`ghost` = subtle tonal fills; there is
  **no** outline variant (it maps to a tonal fill).
- **Badges:** pill, pastel tonal fill, no border.
- **Filter chips:** the shared `Chip` (`ui/chip.tsx`) — pill, ink fill when active,
  recessed `surface-2` fill otherwise. Every "pick one/many" row uses it; never restyle
  a one-off.
- **Keyboard hints:** the shared `Kbd` chip — tiny `surface-2` rounded square. Shown in
  the palette footer and on the header search trigger; any new shortcut surfaces the
  same way.
- **Lists:** rows separated by spacing or a hover fill, never a divider line.
