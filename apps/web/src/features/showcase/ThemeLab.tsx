/*
 * The live theme editor half of the DEV showcase: pickers per headline token
 * plus whole-palette adjustment passes, previewed across the entire app by
 * pinning CSS variables on <html>. Keep this component mounted while the
 * gallery is open — unmounting releases every pinned variable, so a tab
 * switch inside the showcase must hide it, not remove it. Safe to delete
 * with the folder.
 */

import { Copy, Moon, RotateCcw, Sun } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ColorPicker } from "@/components/ui/color-picker";
import { LoadingRow } from "@/components/ui/feedback";
import { IconButton } from "@/components/ui/icon-button";
import { Label } from "@/components/ui/label";
import { Section } from "@/components/ui/section-header";
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
  /** root font size; Tailwind is rem-based, so this scales the entire app */
  scale: number;
}

const DEFAULT_SHAPE: Shape = { radius: 0.7, scale: 1 };

/** Base colours (hex, as the pickers speak) keyed by token, per theme. */
type Overrides = Record<ThemeName, Record<string, string>>;
type Tunings = Record<ThemeName, Tuning>;

const NO_OVERRIDES: Overrides = { light: {}, dark: {} };
const NO_TUNING: Tunings = { light: IDENTITY, dark: IDENTITY };

/** Ready-made looks — brighter, warmer, more vivid, or greyscale takes on the palette. */
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

/** The Theme Lab card plus the palette swatch section it feeds. */
export function ThemeLab() {
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
    <div className="flex flex-col gap-10">
      <Card padding="lg" className="flex flex-col gap-6">
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
          with the button above to tune the other. Changes preview across the whole app (browse the
          other tabs to inspect them) and revert when you leave this page.
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
                    className="h-9 w-9 shrink-0 rounded-lg"
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
