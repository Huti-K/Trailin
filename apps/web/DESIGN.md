# Trailin — Design Rules

The Trailin UI is **borderless neutral minimalism**. Think a quiet document, not a
dashboard. Structure comes from *space and surface tone*, never from lines. Color is a
scarce resource used for meaning, not decoration.

These rules are binding. If a change would break one, change the rule here first.

## The three hard constraints

1. **No borders, outlines, or strokes.** Nothing has a visible edge line at rest — no
   `border`, no `divide-*`, no outlined buttons, no ring at rest, no hairline dividers.
   Separation is achieved with surface tone and whitespace. (Four exceptions: the keyboard
   `:focus-visible` ring, which exists only for accessibility and only appears during
   keyboard navigation; the `--border` hairline (`border-border`) as a divider *inside*
   dense content — thread rails, markdown tables/blockquotes/hr, an expanded row's meta
   section; the agent card shell (`CardShell`), outlined so the agent's work products read
   as discrete blocks against the white chat rail and each other without a heavier grey
   wrapper; and anchored floating panels (`.surface-pop`), outlined because they float
   scrimless over content that can share their tone — in light mode panel and page are
   both white, so without an edge the panel dissolves into what it covers. Always use the
   hairline plain, never with an opacity modifier, so every line in the app is the same
   tone. Beyond those two shapes it outlines nothing.)
2. **No card-in-card.** A surface is never nested inside another surface. Group content
   with a section heading + whitespace. If you need one elevated panel, it holds plain
   rows — not more panels.
3. **No drop shadows.** Nothing casts a blurred shadow — no `shadow-*` utilities, no
   `box-shadow`/`drop-shadow`, at rest or floating. Elevation is tone-only: floating
   chrome separates with the `.scrim` backdrop and, in dark mode, a brighter panel tone
   (`.surface-pop`). The Tailwind `--shadow-*` tokens are nulled in `index.css` so a
   stray utility renders nothing. (One exception: the `:focus-visible` ring is drawn
   with hard-edged `box-shadow` rings — zero blur — which is a stroke, not a shadow.)

## Surfaces — a raised tone ladder

The canvas is a true grey in **both** themes, so raised things lift off it and recessed
things sink below it. A thing that stands on its own rises to white; a thing tucked inside
another sinks to grey — that alternation is the whole model.

| Token         | Role                                     | When to use                          |
| ------------- | ---------------------------------------- | ------------------------------------ |
| `surface`     | **Raised** — white in light, a lighter panel in dark. | Anything that stands on its own on the canvas: a standalone list/feed row, an empty-state box, a grouped block, a chat/agent card |
| `background`  | The canvas everything sits on — a real grey. | Page body, the main content column, and the chat/agent column |
| `surface-2` / `muted` | **Recessed** — a step below the canvas.  | Inputs, chips, hover fills, code/data blocks, and any sub-element inside a raised surface |

Never stack `surface` on `surface` (no card-in-card). Sibling rows on the canvas each rise
on their own; but a row *inside* a grouped card stays bare or `surface-2` — the row and the
card are never both white. That alternation (raised holds recessed holds raised) is the
maximum depth.

**Standalone items on the canvas rise; grouped rows inside a card recess.** A repeated
list/feed item (a provider row, a draft, a connected account, an empty state) is its own
raised `surface` on the grey canvas — that is the `ListRow` / `EmptyState` default. When
rows are collected inside one grouped card, the card is the `surface` and its rows are bare.

**Chrome frames the canvas.** The app shell is chrome (`sidebar`): the left nav rail, the
right chat/agent column, and the frame behind the working canvas. On desktop the grey
canvas is inset into that shell — rounded (`rounded-2xl`) with a small vertical gap — so
the chrome reads as one continuous frame around it; on mobile the canvas runs edge to
edge. Inside
the chat rail the agent's cards are still `surface`; they read by their structure — the mono
eyebrow and spacing — rather than by tone contrast, since rail and card share the white.

**A neutral control's fill is relative to the surface behind it — it never has one
fixed grey.** The same input, chip, secondary button, or hover fill *rises to white on
the grey canvas* (a grey control on the grey canvas is near-invisible in light — only
~0.015 L apart) and *recesses to grey on any white surface*. That alternation is the
control-level echo of the ladder above: standalone-on-canvas rises, tucked-inside sinks.
It is painted through derived variables (`--surface-2-fill`, `--secondary-fill`) so it is
automatic — `bg-surface-2`, `bg-secondary`, `.field`, `.tint-neutral`, and `.skeleton`
all route through them. The root default lifts them to `surface`; every white surface
(`.surface`/`.surface-pop`, plus the white chrome rails via `.surface-fills`) steps them
one tone down to grey. Dark mode keeps canvas controls at the brighter `surface-2`
instead — there depth reads forward-brighter and there is no muddy grey-on-grey to escape.
Never hand-pick a grey to make a control read; if contrast is short, the fix belongs in
the fill variables in `index.css`.

**Anchored floating panels use `.surface-pop`, not `.surface`.** Select menus and the
color picker float over content with no scrim: `.surface-pop` steps the panel itself one
tone brighter than a card in dark mode and carries the `--border` hairline (a documented
exception above), because in light mode the panel is the same white as the surfaces it
floats over and tone alone gives it no edge. Dialogs keep `.surface` — the scrim
separates them.

## Color

- **Neutrals are true grey.** Every surface tone (`background`, `surface`, `surface-2`,
  `muted`, `secondary`, `sidebar`) sits at chroma 0 — never tinted toward the accent.
  Temperature lives only in the text inks and the accent; large fills must read as
  plain grey, not lavender.
- **The accent is the brand.** The primary CTA (the `default` button, the send control)
  and the user's chat bubble are filled with the brand accent — a slate-violet — the one
  saturated color in the app. Its foreground is near-white in light, near-black in dark.
- **Slate-violet is the single accent** (`accent`). Beyond the CTA and the user bubble it
  marks only the logo, the nav rail (active item's `tint-accent`, plus a paler hover
  tint on the other links), links, the switch's on-state, matched search text, and the
  focus ring. It stays scarce everywhere else — never wash a whole panel or a page
  background in it.
- **Type tints on icon chips.** A list row may front with an `IconChip` toned by the
  item's *type*: accent = email draft, emerald (`tint-success`) = outbound message
  (WhatsApp), amber (`tint-warning`) = needs-attention (the to-do section), neutral =
  schedule/log. One tone per type, applied to the chip only — never to the row
  background — so mixed lists (Home's attention list) scan by color while the page
  stays quiet. Section title chips reuse the same tones.
- **Ink** (`--primary`) is no longer a CTA fill; it remains the high-contrast "selected /
  pressed" tone — the active filter `Chip`, the skip-link — near-black in light,
  near-white in dark.
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
- Below `text-xs` there are two micro steps: `text-2xs` (11px) for meta/overline text
  and `text-3xs` (10px) for tiny marks (Kbd, count chips). Never write an arbitrary
  `text-[11px]` — the tokens live in `index.css`.
- Tighten tracking on headings (`tracking-tight`).

## Shape & elevation

- Radius: `--radius` (0.7rem ≈ 11px) for panels/inputs/buttons; smaller for chips. No
  `rounded-full` on primary buttons or in-flow containers — pills are reserved for status
  badges, filter chips (the shared `Chip`), and tiny marks (avatars, count dots).
- **No shadows at all** (hard constraint 3). Elevated `surface` panels lift off the
  canvas by tone alone; nothing in the app casts a blurred shadow.

## Floating chrome — dialogs & command palette

Elements that float *over* content (dialogs, the Cmd+K palette, select menus) separate
without shadows: everything modal shares the `.scrim` backdrop — a light dim plus a
**2px** backdrop blur — and scrimless anchored panels rely on `.surface-pop`'s tone and
hairline outline.
Backdrop blur is welcome on floating chrome and scrims; just keep it turned down. The
page underneath should stay readable through it, never frost over. Everything else
about floating panels still follows the rules above:

- **Zones inside a floating panel separate by tone, never by line.** The palette's
  footer is a recessed fill (`surface-2/50`) on the panel surface — the borderless
  equivalent of a divider.
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
- Content column is constrained: `max-w-3xl` for settings-style pages, stepping up to
  `max-w-4xl`/`max-w-5xl` via container queries when the canvas itself is wide (the
  sidebar and chat panel eat variable width, so the canvas — not the viewport — decides).
- Motion is quiet: content rises `6px` and fades in over ~360ms; lists stagger. Animate
  only `transform`/`opacity`. Respect `prefers-reduced-motion`.

## State & liveness

The UI is a function of live state, never of a page load. If seeing the new truth
requires a refresh, a remount, or closing and reopening a panel, the wiring is wrong —
fix the state, don't add a reload.

- **Everything renders from reactive state.** Server data lives in TanStack Query
  caches invalidated by their SSE topics; view state lives in React state or the URL.
  When either changes, the view follows on its own.
- **Mutations reflect immediately.** The handler that creates/edits/deletes also
  updates or invalidates the query cache (or local state) so the row appears, changes,
  or leaves right away — never leave a stale list waiting on the next fetch or poll.
- **Transitions are rendered, not skipped.** In-flight work shows on the control that
  caused it (a busy button takes `loading`), refetches keep the previous data on
  screen (the accent sweep, never a blank flash), and enter/leave motion rides the
  state change — content mounted or keyed anew snaps in and loses its animation.

## Component conventions

- **Inputs / textareas / selects:** filled `surface-2`, no border, focus lightens the fill
  plus the a11y ring.
- **Buttons:** `default` = accent (brand) fill — the CTA; `secondary`/`ghost` = subtle
  neutral fills (grey on white, rising to white on the canvas); there is **no** outline
  variant (it maps to a tonal fill). Compact icon actions use the
  `icon-sm`/`icon-xs` sizes — never hand-roll `h-8 w-8` or restate the ghost colors in
  a className. Destructive row actions (delete/discard) use `ghost-danger` — never
  restate its pale red hover in a className.
- **Badges:** pill, pastel tonal fill, no border.
- **Account dots:** the shared `AccountDot` (`ui/account-dot.tsx`) — every round dot
  marker; it owns the unassigned-grey fallback (`UNASSIGNED_ACCOUNT_COLOR`) and the
  non-account `tone` variants (`ink`, `accent`) — never hand-mix a dot fill.
- **Spinners:** the shared `Spinner` (`ui/spinner.tsx`) — the one busy glyph; a busy
  button takes `loading` (which disables it and swaps its icon) — never a raw
  `Loader2` or a hand-swapped icon ternary.
- **App logos:** the shared `AppIcon` (`ui/app-icon.tsx`) — provider logo image with
  the generic mail-glyph fallback; no per-feature img-with-fallback state.
- **Section titles:** the shared `SectionTitle` (`ui/section-header.tsx`) — icon tile,
  title, live count, optional collapse chevron, trailing controls slot — for every
  top-level page section; `SectionHeader`/`Section` stay the title+description block
  for settings/setup-style pages.
- **Settings rows:** the shared `SettingRow` (`ui/setting-row.tsx`) — label +
  description at left, control at right; `bare` inside an already-raised card or
  dialog, `ListRow`-raised otherwise. Settings auto-save on change (no Save
  buttons); secrets save on Enter/blur; the Pipedream credentials form is the
  one explicit-verify exception.
- **Menu/picker rows:** the shared `OptionRow` (`ui/option-row.tsx`) — leading mark,
  truncated label, optional detail line and trailing slot; `fill` follows the tone
  ladder (`recessed`/`ghost`/`bare`), `selected` wears the pale accent tint.
- **Row actions:** the shared `HoverActions` (`ui/hover-actions.tsx`) — the
  hover/focus-revealed trailing toolbar (always visible below `sm`); opening a URL
  outside the app is the shared `OpenExternalButton` (`ui/open-external-button.tsx`).
- **Group labels:** the shared `GroupLabel` (`ui/group-label.tsx`) — the small
  uppercase muted overline heading a group of rows; `sm` for dense meta lists.
- **Step marks:** the shared `StepCircle` (`ui/step-circle.tsx`) — the tiny numbered
  circle fronting setup/guide steps.
- **Edit-in-place:** the shared `InlineEditButton` (`ui/inline-edit-button.tsx`) —
  text-cursor button styled as the value it shows, swapping to the caller's editor.
- **Notices:** the shared `Notice` (`ui/feedback.tsx`) — pastel tone box for inline
  status/setup messages, optionally dismissible. No hand-rolled tint containers.
  A failed panel fetch renders `RetryableError` (same file) — banner + quiet retry.
- **Icon tiles:** the shared `IconChip` (`ui/icon-chip.tsx`) — the tinted square mark
  fronting section titles and palette rows; it sizes the icon, callers don't.
- **Search filters:** the shared `SearchField` (`ui/search-field.tsx`) — leading
  magnifier, trailing clear — for every list filter box.
- **Show more/less:** the shared `DisclosureToggle` (`ui/disclosure-toggle.tsx`) —
  chevron + quiet text label for every open/close disclosure; omitting `open` makes
  it a one-way reveal. Monotonic paged lists ("show N more") use `usePagedVisible`
  (`lib/usePagedVisible.ts`) + `ShowMoreButton` (same file), its count-labelled form.
- **Filter chips:** the shared `Chip` (`ui/chip.tsx`) — pill, ink fill when active,
  recessed `surface-2` fill otherwise. Every "pick one/many" row uses it; never restyle
  a one-off.
- **Keyboard hints:** the shared `Kbd` chip — tiny `surface-2` rounded square. Shown in
  the palette footer and on the header search trigger; any new shortcut surfaces the
  same way.
- **Lists:** rows separated by spacing or a hover fill, never a divider line.
- **Panel controls** are icon buttons in the panel header — never control rows inside
  the content area, and no suggestion/template chips anywhere.
- **Form actions** are right-aligned, primary action rightmost.
