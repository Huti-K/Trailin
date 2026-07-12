/*
 * ─────────────────────────────────────────────────────────────────────────────
 *  DEV SHOWCASE / THEME LAB — safe to delete.
 *
 *  A single self-contained gallery of every UI primitive plus a live theme
 *  editor. Colleagues can retune the palette here (the "colours are dark and
 *  depressed" note) and copy the result straight into `src/index.css`.
 *
 *  Two layers of control, composed in that order:
 *    Base colours  — a picker per headline token, overriding what index.css says.
 *    Adjustments   — brightness / contrast / saturation / warmth / hue passes run
 *                    over *every* token afterwards, so the whole UI moves together.
 *
 *  To remove entirely: delete this folder and the one `/showcase` <Route> in
 *  App.tsx. Nothing else imports it.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type {
  AccountColor,
  AccountDrafts,
  Automation,
  EmailThreadMessage,
  OpenConversations,
} from "@trailin/shared";
import {
  Bell,
  Check,
  Copy,
  Inbox,
  Loader2,
  Mail,
  Moon,
  RotateCcw,
  Sparkles,
  Sun,
  Trash2,
  TriangleAlert,
  Wrench,
} from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { RunStatusBadge } from "@/components/RunStatusBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { ColorPicker } from "@/components/ui/color-picker";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorBanner, LoadingRow } from "@/components/ui/feedback";
import { FormField } from "@/components/ui/form-field";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LinkButton } from "@/components/ui/link-button";
import { ListRow } from "@/components/ui/list-row";
import { Markdown } from "@/components/ui/markdown";
import { Section } from "@/components/ui/section-header";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusChip } from "@/components/ui/status-chip";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { AgentCardView } from "@/features/chat/cards";
import { SHOWCASE_TURNS, type ShowcaseTurn } from "@/features/chat/cards/samples";
import { GlanceStrip } from "@/features/home/GlanceStrip";
import { OpenConversationsSection } from "@/features/home/OpenConversationsSection";
import { ThreadHistory } from "@/features/home/ThreadHistory";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import {
  applyTuning,
  formatOklch,
  hexToOklch,
  IDENTITY,
  lightnessOf,
  type Oklch,
  oklchToHex,
  parseCssColor,
  pivotOf,
  round,
  type Tuning,
} from "./theme-tuning";

type ThemeName = "light" | "dark";

/** Every colour token the lab drives. `pick` also gives it a base-colour picker. */
const COLOR_TOKENS: { name: string; label: string; pick?: boolean }[] = [
  { name: "--background", label: "Background", pick: true },
  { name: "--surface", label: "Surface", pick: true },
  { name: "--surface-2", label: "Surface 2", pick: true },
  { name: "--sidebar", label: "Sidebar" },
  { name: "--foreground", label: "Foreground", pick: true },
  { name: "--muted-foreground", label: "Muted text", pick: true },
  { name: "--muted", label: "Muted" },
  { name: "--secondary", label: "Secondary" },
  { name: "--secondary-foreground", label: "Secondary text" },
  { name: "--primary", label: "Primary (ink)", pick: true },
  { name: "--primary-foreground", label: "Primary text" },
  { name: "--accent", label: "Accent", pick: true },
  { name: "--accent-foreground", label: "Accent text" },
  { name: "--accent-soft", label: "Accent soft" },
  { name: "--ring", label: "Ring" },
  { name: "--success", label: "Success", pick: true },
  { name: "--warning", label: "Warning", pick: true },
  { name: "--destructive", label: "Destructive", pick: true },
  { name: "--destructive-foreground", label: "Destructive text" },
];

const PICKABLE = COLOR_TOKENS.filter((token) => token.pick);

/** Bare numbers rather than colours, but they ride along with the adjustments. */
const FILETYPE_L = "--filetype-l";
const FILETYPE_C = "--filetype-c";
const GRAIN = "--grain-opacity";
const SCALAR_TOKENS = [FILETYPE_L, FILETYPE_C, GRAIN];

const DRIVEN_VARS = [...COLOR_TOKENS.map((token) => token.name), ...SCALAR_TOKENS];

/** Shape and scale, shared by both themes rather than tuned per theme. */
interface Shape {
  /** rem */
  radius: number;
  /** multiplies every --shadow-* opacity */
  shadow: number;
  /** root font size; Tailwind is rem-based, so this scales the entire app */
  scale: number;
}

const DEFAULT_SHAPE: Shape = { radius: 0.7, shadow: 1, scale: 1 };

/** Base colours (hex, as the pickers speak) keyed by token, per theme. */
type Overrides = Record<ThemeName, Record<string, string>>;
type Tunings = Record<ThemeName, Tuning>;

const NO_OVERRIDES: Overrides = { light: {}, dark: {} };
const NO_TUNING: Tunings = { light: IDENTITY, dark: IDENTITY };

/** Ready-made looks that counter the "dark and depressed" feedback. */
const PRESETS: { name: string; overrides?: Overrides; tuning?: Tunings }[] = [
  {
    // Light's canvas is already near white, so brightness has nowhere to go —
    // what lifts it is chroma and a warm cast. Dark has the headroom.
    name: "Lift the gloom",
    tuning: {
      light: { ...IDENTITY, contrast: 0.06, saturation: 1.3, warmth: 0.5 },
      dark: { ...IDENTITY, brightness: 0.09, contrast: 0.12, saturation: 1.25, warmth: 0.3 },
    },
  },
  {
    name: "Warmer paper",
    overrides: {
      light: {
        "--background": "#f7f4ee",
        "--surface": "#fffdf8",
        "--surface-2": "#ece7dd",
        "--foreground": "#2c2823",
        "--accent": "#4f66cf",
      },
      dark: {
        "--background": "#221f1b",
        "--surface": "#2b2722",
        "--surface-2": "#343029",
        "--foreground": "#f2eee6",
        "--accent": "#8ba0f2",
      },
    },
  },
  {
    name: "Vivid & bright",
    overrides: {
      light: {
        "--background": "#fbfbfd",
        "--surface": "#ffffff",
        "--surface-2": "#eef0f6",
        "--accent": "#4f46e5",
        "--primary": "#1f2430",
      },
      dark: {
        "--background": "#1b2130",
        "--surface": "#242c3e",
        "--surface-2": "#2e3850",
        "--foreground": "#eef1f8",
        "--accent": "#7f8cff",
      },
    },
  },
  {
    name: "Greyscale",
    tuning: {
      light: { ...IDENTITY, saturation: 0, contrast: 0.1 },
      dark: { ...IDENTITY, saturation: 0, contrast: 0.1 },
    },
  },
];

/** The adjustment sliders, in render order. */
const KNOBS: {
  key: keyof Tuning;
  label: string;
  hint: string;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
}[] = [
  {
    key: "brightness",
    label: "Brightness",
    hint: "toward white or black",
    min: -0.5,
    max: 0.5,
    step: 0.01,
    format: signedPercent,
  },
  {
    key: "contrast",
    label: "Contrast",
    hint: "spread from the canvas",
    min: -0.5,
    max: 0.75,
    step: 0.01,
    format: signedPercent,
  },
  {
    key: "saturation",
    label: "Saturation",
    hint: "0× is greyscale",
    min: 0,
    max: 2,
    step: 0.05,
    format: (v) => `${v.toFixed(2)}×`,
  },
  {
    key: "warmth",
    label: "Warmth",
    hint: "tints the neutrals",
    min: -1,
    max: 1,
    step: 0.05,
    format: (v) =>
      v === 0 ? "neutral" : `${v > 0 ? "warm" : "cool"} ${Math.round(Math.abs(v) * 100)}%`,
  },
  {
    key: "hue",
    label: "Hue shift",
    hint: "rotates the accents",
    min: -180,
    max: 180,
    step: 1,
    format: (v) => `${v > 0 ? "+" : ""}${v}°`,
  },
  {
    key: "grain",
    label: "Grain",
    hint: "paper texture",
    min: 0,
    max: 3,
    step: 0.1,
    format: (v) => `${v.toFixed(1)}×`,
  },
];

/** The theme-independent sliders, in render order. */
const SHAPE_KNOBS: {
  key: keyof Shape;
  label: string;
  hint: string;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
}[] = [
  {
    key: "radius",
    label: "Corner radius",
    hint: "every rounded shape",
    min: 0,
    max: 1.4,
    step: 0.05,
    format: (v) => `${v.toFixed(2)}rem`,
  },
  {
    key: "shadow",
    label: "Shadow depth",
    hint: "0× flattens the UI",
    min: 0,
    max: 3,
    step: 0.1,
    format: (v) => `${v.toFixed(1)}×`,
  },
  {
    key: "scale",
    label: "UI scale",
    hint: "root font size",
    min: 0.85,
    max: 1.25,
    step: 0.01,
    format: (v) => `${Math.round(v * 100)}%`,
  },
];

function signedPercent(value: number) {
  const pct = Math.round(value * 100);
  return `${pct > 0 ? "+" : ""}${pct}%`;
}

/** The root font size, as CSS. `round` drops the trailing zero on whole values. */
const scalePercent = (scale: number) => `${round(scale * 100, 1)}%`;

/* ── Fixtures for the feature components ─────────────────────────────────── */

const hoursAgo = (n: number) => new Date(Date.now() - n * 3_600_000).toISOString();

/** Account ids match `samples.ts`, so the chat cards pick these dots up. */
const DEMO_COLORS: AccountColor[] = [
  { accountId: "demo-work", hex: "#4f46e5" },
  { accountId: "demo-personal", hex: "#0d9488" },
];

const DEMO_DRAFTS: AccountDrafts[] = [
  {
    account: "selin@nordwind-studio.de",
    accountId: "demo-work",
    drafts: [
      {
        id: "draft-acme-2291-reply",
        messageId: "msg-acme-2291-2",
        threadId: "thread-acme-2291",
        subject: "Re: Rechnung #A-2291 – Zahlungserinnerung",
        to: "t.brandt@acme-gmbh.de",
        date: hoursAgo(3),
        webUrl: "#",
        snippet: "Anbei nochmal Rechnung #A-2291 als PDF. Unser Zahlungsziel war der 30. Juni.",
      },
    ],
  },
];

const DEMO_WAITING: OpenConversations = {
  waitingOnYou: [
    {
      account: "selin@nordwind-studio.de",
      accountId: "demo-work",
      items: [
        {
          threadId: "thread-onboarding-elif",
          accountId: "demo-work",
          subject: "Re: Onboarding-Termin nächste Woche",
          counterpart: "Elif Aydın",
          gist: "Fragt nach einem Termin für das Onboarding-Gespräch am Donnerstag.",
          urgency: "high",
          webUrl: "#",
        },
      ],
    },
  ],
  waitingOnOthers: [
    {
      account: "selin@nordwind-studio.de",
      accountId: "demo-work",
      items: [
        {
          threadId: "thread-rebrand-elif",
          subject: "Angebot Rebranding – Rückfragen",
          counterpart: "Elif Aydın",
          lastSentAt: hoursAgo(72),
          webUrl: "#",
        },
      ],
    },
    {
      account: "selin.kaya.mail@gmail.com",
      accountId: "demo-personal",
      items: [
        {
          threadId: "thread-seeblick-august",
          subject: "Ferienwohnung Seeblick – Buchung im August",
          counterpart: "Sabine Möller",
          lastSentAt: hoursAgo(30),
          webUrl: "#",
        },
      ],
    },
  ],
};

const DEMO_AUTOMATIONS: Automation[] = [
  {
    id: "auto-briefing",
    name: "Morning briefing",
    instruction: "Summarise what needs my attention across both inboxes.",
    schedule: "0 8 * * 1-5",
    enabled: true,
    showInActivity: true,
    pinned: true,
    createdAt: hoursAgo(720),
    nextRunAt: new Date(Date.now() + 5 * 3_600_000).toISOString(),
  },
];

const DEMO_THREAD: EmailThreadMessage[] = [
  {
    from: "Sabine Möller <sabine.moeller@seeblick-ferien.de>",
    to: ["selin.kaya.mail@gmail.com"],
    date: hoursAgo(52),
    body: "Die Wohnung ist vom 8. bis 15. August noch frei — 95 € pro Nacht inkl. Endreinigung.",
  },
  {
    from: "Selin Kaya <selin.kaya.mail@gmail.com>",
    to: ["sabine.moeller@seeblick-ferien.de"],
    date: hoursAgo(48),
    body: "Das klingt gut, wir würden gerne für die ganze Woche buchen. Ist eine Anzahlung nötig?",
  },
  {
    from: "Sabine Möller <sabine.moeller@seeblick-ferien.de>",
    to: ["selin.kaya.mail@gmail.com"],
    date: hoursAgo(30),
    body: "Sehr gerne — 30 % Anzahlung reicht, der Rest ist bei Anreise fällig.",
  },
];

/** The file-type ink family. The hue is the only thing that varies per format. */
const FILETYPES: { label: string; hue: number }[] = [
  { label: "PDF", hue: 25 },
  { label: "DOCX", hue: 256 },
  { label: "XLSX", hue: 150 },
  { label: "PNG", hue: 300 },
  { label: "MD", hue: 70 },
];

const MARKDOWN_DEMO = `### What the assistant's replies render as

**Acme GmbH** replied to the payment reminder — Thomas Brandt
([t.brandt@acme-gmbh.de](mailto:t.brandt@acme-gmbh.de)) wants the invoice as a PDF.

- A reply draft is waiting in your mailbox
- Accounting is in Cc
- Payment was due 30 June

| Account | Unread | Drafts |
| --- | ---: | ---: |
| Work | 4 | 1 |
| Personal | 2 | 1 |

More context lives at [nordwind-studio.de](https://nordwind-studio.de).`;

/** One theme's authored values, read straight off the stylesheet. */
interface ThemeBase {
  colors: Record<string, Oklch>;
  scalars: Record<string, number>;
}

/**
 * Resolve both themes' authored values by probing inside a throwaway themed
 * host. `.light` / `.dark` declare every token we touch, so the host's own class
 * rule beats whatever we've inlined on <html> for the live preview.
 */
function resolveBase(): Record<ThemeName, ThemeBase> {
  const out: Record<ThemeName, ThemeBase> = {
    light: { colors: {}, scalars: {} },
    dark: { colors: {}, scalars: {} },
  };
  for (const theme of ["light", "dark"] as ThemeName[]) {
    const host = document.createElement("div");
    host.className = theme; // matches `:root, .light` / `.dark` in index.css
    host.style.cssText = "position:absolute;visibility:hidden;pointer-events:none";
    document.body.appendChild(host);
    const styles = getComputedStyle(host);
    for (const { name } of COLOR_TOKENS) {
      out[theme].colors[name] = parseCssColor(styles.getPropertyValue(name));
    }
    for (const name of SCALAR_TOKENS) {
      const value = parseFloat(styles.getPropertyValue(name));
      out[theme].scalars[name] = Number.isFinite(value) ? value : 0;
    }
    document.body.removeChild(host);
  }
  return out;
}

/** Base colours, with any picker overrides, run through the adjustments. */
function computePalette(
  base: ThemeBase,
  overrides: Record<string, string>,
  tuning: Tuning,
): { css: Record<string, string>; colors: Record<string, Oklch> } {
  const source = (name: string) => {
    const override = overrides[name];
    return override ? hexToOklch(override) : base.colors[name];
  };

  // Contrast spreads everything away from the canvas, so the canvas anchors it.
  const pivot = pivotOf(source("--background") ?? { l: 1, c: 0, h: 0 }, tuning);

  const css: Record<string, string> = {};
  const colors: Record<string, Oklch> = {};
  for (const { name } of COLOR_TOKENS) {
    const from = source(name);
    if (!from) continue;
    const tuned = applyTuning(from, tuning, pivot);
    colors[name] = tuned;
    css[name] = formatOklch(tuned);
  }

  const scalar = (name: string, fallback: number) => base.scalars[name] ?? fallback;
  css[FILETYPE_L] = String(round(lightnessOf(scalar(FILETYPE_L, 0.55), tuning, pivot)));
  css[FILETYPE_C] = String(round(Math.max(0, scalar(FILETYPE_C, 0.11) * tuning.saturation)));
  css[GRAIN] = String(round(Math.min(1, scalar(GRAIN, 0.02) * tuning.grain)));

  return { css, colors };
}

export function ShowcasePanel() {
  const [theme, setTheme] = React.useState<ThemeName>(() => {
    // App applies the `dark` class in an effect (after our first render), so read
    // the persisted preference it also seeds from to avoid a light/dark desync.
    const saved = localStorage.getItem("trailin-theme");
    if (saved === "dark" || saved === "light") return saved;
    return document.documentElement.classList.contains("dark") ? "dark" : "light";
  });
  const [overrides, setOverrides] = React.useState<Overrides>(NO_OVERRIDES);
  const [tuning, setTuning] = React.useState<Tunings>(NO_TUNING);
  const [shape, setShape] = React.useState<Shape>(DEFAULT_SHAPE);
  const [base, setBase] = React.useState<Record<ThemeName, ThemeBase> | null>(null);

  // BriefingCard's row actions post into the real chat panel, which App keeps
  // mounted beside every route — a curious click here would otherwise fire a
  // live agent turn. Force prefill while the gallery is open so it only fills
  // the composer. `pagehide` covers a refresh, which skips the unmount path.
  React.useEffect(() => {
    const KEY = "trailin-quick-action-mode";
    const previous = localStorage.getItem(KEY);
    const restore = () => {
      if (previous === null) localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, previous);
    };
    localStorage.setItem(KEY, "prefill");
    window.addEventListener("pagehide", restore);
    return () => {
      restore();
      window.removeEventListener("pagehide", restore);
    };
  }, []);

  // Stay in lockstep with the real theme, whichever control flips it.
  React.useEffect(() => {
    const el = document.documentElement;
    const sync = () => setTheme(el.classList.contains("dark") ? "dark" : "light");
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  // Resolve each theme's authored values once, for seeding pickers and diffing.
  React.useEffect(() => setBase(resolveBase()), []);

  // Both themes stay computed: the preview needs the active one, Copy CSS needs
  // both, and each token's untouched twin says whether it drifted at all.
  const palettes = React.useMemo(() => {
    if (!base) return null;
    const build = (name: ThemeName) => ({
      live: computePalette(base[name], overrides[name], tuning[name]),
      base: computePalette(base[name], {}, IDENTITY),
    });
    return { light: build("light"), dark: build("dark") };
  }, [base, overrides, tuning]);

  /** Only the tokens that moved — what the preview pins and Copy CSS emits. */
  const changed = React.useMemo(() => {
    const diff = (name: ThemeName) =>
      palettes
        ? Object.fromEntries(
            Object.entries(palettes[name].live.css).filter(
              ([token, value]) => value !== palettes[name].base.css[token],
            ),
          )
        : {};
    return { light: diff("light"), dark: diff("dark") };
  }, [palettes]);

  // Push the active theme onto <html> so the preview covers the whole app. A
  // token that still matches the stylesheet is released rather than pinned.
  React.useEffect(() => {
    const root = document.documentElement.style;
    const active = changed[theme];
    for (const name of DRIVEN_VARS) {
      const value = active[name];
      if (value !== undefined) root.setProperty(name, value);
      else root.removeProperty(name);
    }
  }, [changed, theme]);

  React.useEffect(() => {
    const root = document.documentElement.style;
    if (shape.radius === DEFAULT_SHAPE.radius) root.removeProperty("--radius");
    else root.setProperty("--radius", `${shape.radius}rem`);

    if (shape.shadow === DEFAULT_SHAPE.shadow) root.removeProperty("--shadow-strength");
    else root.setProperty("--shadow-strength", String(shape.shadow));

    // Not a custom property: Tailwind's spacing and type scales are rem, so the
    // root font size is the one knob that resizes the whole app at once.
    root.fontSize = shape.scale === DEFAULT_SHAPE.scale ? "" : scalePercent(shape.scale);
  }, [shape]);

  // Leave the rest of the app exactly as we found it.
  React.useEffect(
    () => () => {
      const root = document.documentElement.style;
      for (const name of DRIVEN_VARS) root.removeProperty(name);
      root.removeProperty("--radius");
      root.removeProperty("--shadow-strength");
      root.fontSize = "";
    },
    [],
  );

  const toggleTheme = () =>
    setTheme((prev) => {
      const next = prev === "dark" ? "light" : "dark";
      document.documentElement.classList.toggle("dark", next === "dark");
      try {
        localStorage.setItem("trailin-theme", next);
      } catch {
        /* ignore */
      }
      return next;
    });

  const setToken = (name: string, hex: string) =>
    setOverrides((prev) => ({ ...prev, [theme]: { ...prev[theme], [name]: hex } }));

  const setKnob = (key: keyof Tuning, value: number) =>
    setTuning((prev) => ({ ...prev, [theme]: { ...prev[theme], [key]: value } }));

  const setShapeKnob = (key: keyof Shape, value: number) =>
    setShape((prev) => ({ ...prev, [key]: value }));

  const applyPreset = (preset: (typeof PRESETS)[number]) => {
    setOverrides(
      preset.overrides
        ? { light: { ...preset.overrides.light }, dark: { ...preset.overrides.dark } }
        : NO_OVERRIDES,
    );
    setTuning(preset.tuning ?? NO_TUNING);
  };

  const reset = () => {
    setOverrides(NO_OVERRIDES);
    setTuning(NO_TUNING);
    setShape(DEFAULT_SHAPE);
  };

  const baseHex = (name: string) => {
    const authored = base?.[theme].colors[name];
    return overrides[theme][name] ?? (authored ? oklchToHex(authored) : "#888888");
  };

  const shapeChanged = SHAPE_KNOBS.filter(({ key }) => shape[key] !== DEFAULT_SHAPE[key]);

  const dirtyCount =
    Object.keys(changed.light).length + Object.keys(changed.dark).length + shapeChanged.length;

  const copyCss = async () => {
    const block = (name: ThemeName) => {
      const entries = Object.entries(changed[name]);
      if (!entries.length) return "";
      const selector = name === "light" ? ":root, .light" : ".dark";
      const lines = entries.map(([token, value]) => `  ${token}: ${value};`).join("\n");
      return `${selector} {\n${lines}\n}`;
    };
    const parts = [block("light"), block("dark")].filter(Boolean);

    const rootLines: string[] = [];
    if (shape.radius !== DEFAULT_SHAPE.radius) rootLines.push(`  --radius: ${shape.radius}rem;`);
    if (shape.shadow !== DEFAULT_SHAPE.shadow)
      rootLines.push(`  --shadow-strength: ${shape.shadow};`);
    if (rootLines.length) parts.push(`:root {\n${rootLines.join("\n")}\n}`);
    // UI scale isn't a token — it's the root font size Tailwind's rem scales read.
    if (shape.scale !== DEFAULT_SHAPE.scale) {
      parts.push(`html {\n  font-size: ${scalePercent(shape.scale)};\n}`);
    }

    const css = parts.join("\n\n");
    if (!css) {
      toast.error("Nothing to copy — no changes yet.");
      return;
    }
    try {
      await navigator.clipboard.writeText(css);
      toast.success("Theme CSS copied to clipboard.");
    } catch {
      toast.error("Clipboard blocked — copy manually from the palette below.");
    }
  };

  return (
    <div className="flex flex-col gap-10 pb-16">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-accent" />
          <h1 className="text-lg font-semibold tracking-tight">UI Showcase &amp; Theme Lab</h1>
          <Badge variant="warning">dev only</Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          Every component in one place, plus a live palette editor. Slide the whole UI brighter,
          punchier or warmer, retouch individual colours underneath, then{" "}
          <span className="font-medium text-foreground">Copy CSS</span> into{" "}
          <span className="font-mono text-xs">src/index.css</span>. Delete this folder and its route
          to remove.
        </p>
      </div>

      {/* ── Theme Lab ─────────────────────────────────────────────── */}
      <Card tone="soft" padding="lg" className="flex flex-col gap-6">
        <div className="flex flex-wrap items-center gap-2">
          <p className="mr-auto text-sm font-semibold tracking-tight">Theme Lab</p>
          <Button variant="outline" size="sm" onClick={toggleTheme}>
            {theme === "dark" ? <Sun /> : <Moon />}
            Editing: {theme}
          </Button>
          {PRESETS.map((preset) => (
            <Button
              key={preset.name}
              variant="secondary"
              size="sm"
              onClick={() => applyPreset(preset)}
            >
              {preset.name}
            </Button>
          ))}
          <Button variant="ghost" size="sm" onClick={reset} disabled={dirtyCount === 0}>
            <RotateCcw /> Reset
          </Button>
          <Button size="sm" onClick={() => void copyCss()}>
            <Copy /> Copy CSS{dirtyCount > 0 ? ` (${dirtyCount})` : ""}
          </Button>
        </div>

        <p className="text-xs text-muted-foreground">
          Editing the <span className="font-medium text-foreground">{theme}</span> theme — switch
          with the button above to tune the other. Changes preview across the whole app and revert
          when you leave this page.
        </p>

        {/* ── Global adjustments ──────────────────────────────────── */}
        <div className="flex flex-col gap-2.5">
          <GroupLabel>Colour — applied to every token in the {theme} theme</GroupLabel>
          {KNOBS.map(({ key, ...knob }) => (
            <Knob
              key={key}
              {...knob}
              value={tuning[theme][key]}
              base={IDENTITY[key]}
              onChange={(value) => setKnob(key, value)}
            />
          ))}
        </div>

        <div className="flex flex-col gap-2.5">
          <GroupLabel>Shape &amp; scale — shared by both themes</GroupLabel>
          {SHAPE_KNOBS.map(({ key, ...knob }) => (
            <Knob
              key={key}
              {...knob}
              value={shape[key]}
              base={DEFAULT_SHAPE[key]}
              onChange={(value) => setShapeKnob(key, value)}
            />
          ))}
        </div>

        {/* ── Base colours ────────────────────────────────────────── */}
        <div className="flex flex-col gap-3">
          <GroupLabel>Base colours — before adjustments</GroupLabel>
          {base ? (
            <div className="grid gap-x-5 gap-y-3 sm:grid-cols-2">
              {PICKABLE.map(({ name, label }) => (
                <div key={name} className="flex items-center gap-3">
                  <ColorPicker color={baseHex(name)} onSelect={(hex) => setToken(name, hex)} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{label}</p>
                    <p className="font-mono text-2xs text-muted-foreground">{name}</p>
                  </div>
                  <span className="font-mono text-2xs uppercase text-muted-foreground">
                    {baseHex(name)}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <LoadingRow label="Reading current palette…" />
          )}
        </div>
      </Card>

      {/* ── Palette swatches ──────────────────────────────────────── */}
      <Section title="Palette" description="Every token in the current theme, after adjustments.">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
          {palettes &&
            COLOR_TOKENS.map(({ name, label }) => {
              const tuned = palettes[theme].live.colors[name];
              if (!tuned) return null;
              return (
                <div key={name} className="flex items-center gap-2.5">
                  <span
                    className="h-9 w-9 shrink-0 rounded-lg shadow-sm"
                    style={{ background: palettes[theme].live.css[name] }}
                  />
                  <div className="min-w-0">
                    <p className="truncate text-xs font-medium">{label}</p>
                    <p className="truncate font-mono text-3xs uppercase text-muted-foreground">
                      {oklchToHex(tuned)}
                    </p>
                  </div>
                </div>
              );
            })}
        </div>
      </Section>

      {/* ── Buttons ───────────────────────────────────────────────── */}
      <Section
        title="Buttons"
        description="Ink primary, tonal fills, no outlines. Hover over the icon buttons below to see the custom cursor tooltip in action."
      >
        <div className="flex flex-wrap items-center gap-3">
          <Button data-tooltip="Default solid button">Default</Button>
          <Button variant="secondary" data-tooltip="Secondary style">
            Secondary
          </Button>
          <Button variant="outline" data-tooltip="Outline style">
            Outline
          </Button>
          <Button variant="ghost" data-tooltip="Ghost style">
            Ghost
          </Button>
          <Button variant="destructive" data-tooltip="Warning: destructive action">
            <Trash2 /> Destructive
          </Button>
          <Button disabled data-tooltip="This is currently disabled">
            Disabled
          </Button>
          <Button>
            <Loader2 className="animate-spin" /> Loading
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm">Small</Button>
          <Button size="default">Default</Button>
          <Button size="lg">Large</Button>
          <Button size="icon" aria-label="Notifications">
            <Bell />
          </Button>
          <IconButton aria-label="Dismiss row">
            <Bell className="h-4 w-4" />
          </IconButton>
          <LinkButton data-tooltip="Goes somewhere else">Link button</LinkButton>
        </div>
      </Section>

      {/* ── Badges ────────────────────────────────────────────────── */}
      <Section title="Badges" description="Pill status chips — pastel fill, no border.">
        <div className="flex flex-wrap items-center gap-2">
          <Badge>Default</Badge>
          <Badge variant="muted">Muted</Badge>
          <Badge variant="success">
            <Check className="h-3 w-3" /> Connected
          </Badge>
          <Badge variant="warning">Paused</Badge>
          <Badge variant="destructive">Error</Badge>
        </div>
      </Section>

      {/* ── Chips & run status ────────────────────────────────────── */}
      <Section
        title="Chips & run status"
        description="Filter chips, connection state, and how an automation run reports itself."
      >
        <div className="flex flex-wrap items-center gap-2">
          <ChipsDemo />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip tone="success" icon={<Check className="h-3.5 w-3.5" />}>
            Connected
          </StatusChip>
          <StatusChip tone="warning" icon={<TriangleAlert className="h-3.5 w-3.5" />}>
            Token expired
          </StatusChip>
          <StatusChip tone="muted">Never run</StatusChip>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <RunStatusBadge status="running" />
          <RunStatusBadge status="success" />
          <RunStatusBadge status="error" />
        </div>
      </Section>

      {/* ── Switches ──────────────────────────────────────────────── */}
      <Section title="Switches" description="Accent by default; warning/danger arm risky actions.">
        <div className="flex flex-wrap items-center gap-6">
          <SwitchDemo label="Accent" tone="accent" defaultOn />
          <SwitchDemo label="Warning" tone="warning" defaultOn />
          <SwitchDemo label="Danger" tone="danger" defaultOn />
          <SwitchDemo label="Off" tone="accent" />
          <div className="flex items-center gap-2 opacity-60">
            <Switch disabled />
            <span className="text-sm">Disabled</span>
          </div>
        </div>
        <DangerZoneDemo />
      </Section>

      {/* ── Form controls ─────────────────────────────────────────── */}
      <Section
        title="Form controls"
        description="Filled fields, no borders; focus lightens the fill."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField id="sc-name" label="Full name" hint="As it appears on your account.">
            <Input id="sc-name" placeholder="Ada Lovelace" />
          </FormField>
          <FormField id="sc-email" label="Email" error="That address looks invalid.">
            <Input id="sc-email" type="email" defaultValue="not-an-email" />
          </FormField>
          <FormField id="sc-plan" label="Plan">
            <SelectDemo />
          </FormField>
          <FormField
            id="sc-country"
            label="Country"
            hint="Searchable — opt-in for long lists only."
          >
            <SearchableSelectDemo />
          </FormField>
          <FormField id="sc-disabled" label="Disabled">
            <Input id="sc-disabled" disabled defaultValue="Read-only" />
          </FormField>
          <FormField id="sc-note" label="Note" className="sm:col-span-2">
            <Textarea id="sc-note" placeholder="Write something…" rows={3} />
          </FormField>
        </div>
      </Section>

      {/* ── Overlays ──────────────────────────────────────────────── */}
      <Section
        title="Overlays"
        description="Dialogs float on .surface-pop over a blurred scrim. The Cmd+K palette is the third overlay — open it from anywhere."
      >
        <div className="flex flex-wrap items-center gap-3">
          <DialogDemo />
          <ConfirmDialogDemo />
        </div>
      </Section>

      {/* ── Cards & rows ──────────────────────────────────────────── */}
      <Section
        title="Surfaces"
        description="Three tones by depth — never a border, never card-in-card."
      >
        <div className="grid gap-4 sm:grid-cols-3">
          <Card tone="flat">
            <p className="text-sm font-medium">Flat card</p>
            <p className="text-xs text-muted-foreground">surface + soft shadow.</p>
          </Card>
          <Card tone="soft">
            <p className="text-sm font-medium">Soft card</p>
            <p className="text-xs text-muted-foreground">The one elevated panel.</p>
          </Card>
          <Card tone="pop">
            <p className="text-sm font-medium">Pop card</p>
            <p className="text-xs text-muted-foreground">What select menus float on.</p>
          </Card>
        </div>
        <div className="flex flex-col gap-2">
          <ListRow>
            <div className="flex items-center gap-3">
              <Mail className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm">Gmail — personal</span>
            </div>
            <Badge variant="success">Connected</Badge>
          </ListRow>
          <ListRow>
            <div className="flex items-center gap-3">
              <Inbox className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm">Outlook — work</span>
            </div>
            <Badge variant="warning">Reconnect</Badge>
          </ListRow>
        </div>
      </Section>

      {/* ── Toasts ────────────────────────────────────────────────── */}
      <Section title="Toasts" description="Ephemeral system notifications that slide in.">
        <div className="flex flex-wrap items-center gap-3">
          <Button
            onClick={() => toast.success("Your changes have been saved.")}
            variant="secondary"
          >
            Success toast
          </Button>
          <Button
            onClick={() => toast.error("Could not connect to the server.")}
            variant="secondary"
          >
            Error toast
          </Button>
          <Button
            onClick={() => toast.info("A new draft is waiting for review.")}
            variant="secondary"
          >
            Info toast
          </Button>
          <Button
            onClick={() =>
              toast.error(
                new ApiError(
                  "Pipedream is not set up. Add your Pipedream credentials in Settings → Email.",
                  409,
                  "pipedream_not_configured",
                ),
              )
            }
            variant="secondary"
          >
            Error toast with action
          </Button>
        </div>
      </Section>

      {/* ── Status tints ──────────────────────────────────────────── */}
      <Section title="Status tints" description="The one place semantic colour fills a shape.">
        <div className="flex flex-wrap gap-2">
          {(
            ["tint-neutral", "tint-accent", "tint-success", "tint-warning", "tint-danger"] as const
          ).map((tint) => (
            <span key={tint} className={cn(tint, "rounded-lg px-3 py-1.5 text-xs font-medium")}>
              {tint.replace("tint-", "")}
            </span>
          ))}
        </div>
        {/* One class, every format: only --filetype-h varies. The lightness and
            chroma come from the theme, so the Grain/Saturation knobs move these too. */}
        <div className="flex flex-wrap gap-2">
          {FILETYPES.map(({ label, hue }) => (
            <span
              key={label}
              className="tint-file rounded-lg px-3 py-1.5 text-xs font-medium"
              style={{ "--filetype-h": hue } as React.CSSProperties}
            >
              {label}
            </span>
          ))}
        </div>
        <ErrorBanner>Something went wrong while saving your changes.</ErrorBanner>
      </Section>

      {/* ── Feedback & empty ──────────────────────────────────────── */}
      <Section
        title="Feedback & empty states"
        description="Loading, skeletons, and the nothing-here shape."
      >
        <LoadingRow label="Loading your drafts…" />
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-24 w-full" />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <EmptyState
            icon={Inbox}
            title="No drafts yet"
            description="When the agent writes a draft, it shows up here for review."
            action={<Button size="sm">Compose one</Button>}
          />
          <EmptyState
            size="lg"
            icon={Sparkles}
            title="All caught up"
            description="Nothing needs your attention right now."
          />
        </div>
      </Section>

      {/* ── Agent chat ────────────────────────────────────────────── */}
      <Section
        title="Agent chat"
        description="Bubbles, tool activity, the thinking state, and every structured card the agent can return. Same fixtures as the /showcase chat command."
      >
        <ChatTranscript />
      </Section>

      {/* ── Markdown ──────────────────────────────────────────────── */}
      <Section
        title="Markdown"
        description="The vocabulary an assistant reply may use. mailto: links copy the address."
      >
        <Card tone="flat" padding="lg">
          <Markdown content={MARKDOWN_DEMO} />
        </Card>
      </Section>

      {/* ── Home widgets ──────────────────────────────────────────── */}
      <Section
        title="Home widgets"
        description="The at-a-glance strip, the open-conversations lanes, and a collapsed thread. Fed static fixtures here — the real ones read the server."
      >
        <GlanceStrip
          drafts={DEMO_DRAFTS}
          heroRun={null}
          waiting={DEMO_WAITING}
          automations={DEMO_AUTOMATIONS}
        />
        <OpenConversationsSection waiting={DEMO_WAITING} colors={DEMO_COLORS} />
        <Card tone="flat">
          <ThreadHistory messages={DEMO_THREAD} />
        </Card>
      </Section>

      {/* ── Typography ────────────────────────────────────────────── */}
      <Section title="Typography" description="Hierarchy by weight and colour, not size jumps.">
        <div className="flex flex-col gap-1.5">
          <h1 className="text-lg font-semibold tracking-tight">Heading — text-lg semibold</h1>
          <h2 className="text-sm font-semibold tracking-tight">Section title — text-sm semibold</h2>
          <p className="text-sm">Body text sits on the foreground ink, never pure black.</p>
          <p className="text-sm text-muted-foreground">Secondary text uses muted-foreground.</p>
          <p className="font-mono text-xs tabular-nums text-muted-foreground">
            mono · 09:41 · model_id · proj_abc123
          </p>
        </div>
      </Section>
    </div>
  );
}

/** Small uppercase eyebrow above a knob/colour group in the Theme Lab card. */
function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </p>
  );
}

/** A labelled slider with a live readout and a reset that arms once it drifts. */
function Knob({
  label,
  hint,
  min,
  max,
  step,
  value,
  base,
  format,
  onChange,
}: {
  label: string;
  hint: string;
  min: number;
  max: number;
  step: number;
  value: number;
  /** The untouched value: what the readout de-emphasises and reset restores. */
  base: number;
  format: (value: number) => string;
  onChange: (value: number) => void;
}) {
  const id = `sc-knob-${label.replace(/\s+/g, "-").toLowerCase()}`;
  const dirty = value !== base;
  return (
    <div className="flex items-center gap-3">
      <div className="w-36 shrink-0">
        <Label htmlFor={id} className="text-sm">
          {label}
        </Label>
        <p className="truncate text-2xs text-muted-foreground">{hint}</p>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onDoubleClick={() => onChange(base)}
        className="w-full accent-[var(--accent)]"
      />
      <span
        className={cn(
          "w-20 shrink-0 text-right font-mono text-xs tabular-nums",
          dirty ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {format(value)}
      </span>
      <IconButton
        aria-label={`Reset ${label}`}
        onClick={() => onChange(base)}
        className={cn(!dirty && "invisible")}
      >
        <RotateCcw className="h-3.5 w-3.5" />
      </IconButton>
    </div>
  );
}

function ChipsDemo() {
  const [active, setActive] = React.useState("all");
  return (
    <>
      {["all", "unread", "needs reply", "waiting"].map((filter) => (
        <Chip key={filter} active={active === filter} onClick={() => setActive(filter)}>
          {filter}
        </Chip>
      ))}
    </>
  );
}

function DialogDemo() {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Open dialog
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Rename account"
        description="Shown wherever this connection appears."
        footer={<Button onClick={() => setOpen(false)}>Save</Button>}
      >
        <Input defaultValue="Gmail — personal" />
      </Dialog>
    </>
  );
}

function ConfirmDialogDemo() {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button variant="destructive" onClick={() => setOpen(true)}>
        <Trash2 /> Discard draft
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Discard this draft?"
        description="The draft is deleted from your mailbox. This can't be undone."
        confirmLabel="Discard"
        onConfirm={() => setOpen(false)}
      />
    </>
  );
}

/**
 * A static replay of a chat turn — same markup ChatPanel uses, so bubbles,
 * tool chips and cards all re-theme with the sliders above. The briefing card's
 * row actions still post into the real chat panel; the panel forces prefill
 * mode while this page is mounted so nothing fires a live agent turn.
 */
function ChatTranscript() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col items-end gap-2">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-accent px-4 py-2.5 text-sm leading-relaxed text-accent-foreground">
          Show me everything you can render.
        </div>
      </div>
      {SHOWCASE_TURNS.map((turn, index) => (
        // SHOWCASE_TURNS is a fixed module-level fixture — same length and
        // order on every render, so the index is a stable identity here.
        // biome-ignore lint/suspicious/noArrayIndexKey: static fixture array, never reordered/filtered
        <AssistantTurn key={index} turn={turn} />
      ))}
    </div>
  );
}

function AssistantTurn({ turn }: { turn: ShowcaseTurn }) {
  const { t } = useTranslation();
  const text = turn.contentKey ? t(turn.contentKey as never) : turn.content;
  const hasBubble = Boolean(text || turn.toolCalls?.length || turn.thinking);

  return (
    <div className="flex flex-col items-start gap-2">
      {turn.cards?.length ? (
        <div className="flex w-full max-w-[95%] flex-col gap-2">
          {turn.cards.map((card, index) => (
            // turn.cards comes from the same static fixture — fixed set of
            // cards, never reordered/filtered.
            // biome-ignore lint/suspicious/noArrayIndexKey: static fixture array, never reordered/filtered
            <AgentCardView key={index} card={card} colors={DEMO_COLORS} />
          ))}
        </div>
      ) : null}

      {hasBubble && (
        <div className="max-w-[85%] rounded-2xl rounded-bl-md bg-surface-2 px-4 py-2.5 text-sm text-foreground">
          {turn.toolCalls?.length ? (
            <div className={cn("flex flex-wrap gap-1.5", text && "mb-2")}>
              {turn.toolCalls.map((call) => (
                <Badge
                  key={call.name}
                  variant={call.isError ? "destructive" : call.done ? "success" : "muted"}
                >
                  <Wrench className="h-3 w-3" />
                  {call.name}
                  {!call.done && <Loader2 className="h-3 w-3 animate-spin" />}
                </Badge>
              ))}
            </div>
          ) : null}

          {text ? (
            <Markdown content={text} />
          ) : turn.thinking ? (
            <span className="animate-pulse text-muted-foreground">{t("chat.thinking")}</span>
          ) : null}
        </div>
      )}
    </div>
  );
}

function SwitchDemo({
  label,
  tone,
  defaultOn,
}: {
  label: string;
  tone: "accent" | "warning" | "danger";
  defaultOn?: boolean;
}) {
  const [on, setOn] = React.useState(Boolean(defaultOn));
  return (
    <div className="flex items-center gap-2">
      <Switch tone={tone} checked={on} onCheckedChange={setOn} />
      <span className="text-sm">{label}</span>
    </div>
  );
}

/** Mirrors the real "allow sending" danger-zone row so it can be tuned here. */
function DangerZoneDemo() {
  const [armed, setArmed] = React.useState(false);
  return (
    <ListRow className={cn("transition-colors", armed && "bg-warning/10")}>
      <div className="min-w-0">
        <Label className="flex items-center gap-1.5 text-sm font-medium">
          {armed && <Sparkles className="h-3.5 w-3.5 shrink-0 text-warning" />}
          Allow sending &amp; changes
        </Label>
        <p className={cn("text-xs", armed ? "text-warning" : "text-muted-foreground")}>
          {armed
            ? "The agent may send emails and make changes when you ask."
            : "Read-only: the agent can draft but never send or delete."}
        </p>
      </div>
      <Switch tone="warning" checked={armed} onCheckedChange={setArmed} />
    </ListRow>
  );
}

function SelectDemo() {
  const [value, setValue] = React.useState("pro");
  return (
    <Select
      id="sc-plan"
      value={value}
      onChange={setValue}
      options={[
        { value: "free", label: "Free" },
        { value: "pro", label: "Pro" },
        { value: "team", label: "Team" },
      ]}
    />
  );
}

function SearchableSelectDemo() {
  const [value, setValue] = React.useState("de");
  return (
    <Select
      id="sc-country"
      searchable
      value={value}
      onChange={setValue}
      options={[
        { value: "at", label: "Austria" },
        { value: "be", label: "Belgium" },
        { value: "dk", label: "Denmark" },
        { value: "fi", label: "Finland" },
        { value: "fr", label: "France" },
        { value: "de", label: "Germany" },
        { value: "it", label: "Italy" },
        { value: "nl", label: "Netherlands" },
        { value: "no", label: "Norway" },
        { value: "pl", label: "Poland" },
        { value: "es", label: "Spain" },
        { value: "se", label: "Sweden" },
        { value: "ch", label: "Switzerland" },
        { value: "gb", label: "United Kingdom" },
        { value: "us", label: "United States" },
      ]}
    />
  );
}
