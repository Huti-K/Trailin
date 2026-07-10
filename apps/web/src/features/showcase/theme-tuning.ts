/*
 * ─────────────────────────────────────────────────────────────────────────────
 *  DEV SHOWCASE / THEME LAB — colour maths. Safe to delete with ShowcasePanel.
 *
 *  Everything happens in OKLCH, the space `src/index.css` authors its tokens in.
 *  Lightness, chroma and hue move independently there, so one global "brighter"
 *  or "less saturated" pass stays perceptually even across the whole palette
 *  instead of blowing out mid-tones the way an sRGB multiply would.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export interface Oklch {
  /** Perceptual lightness, 0 (black) … 1 (white). */
  l: number;
  /** Chroma. 0 is grey; the palette tops out around 0.18. */
  c: number;
  /** Hue angle in degrees, 0 … 360. */
  h: number;
}

/** The global knobs, held per theme and applied on top of every token. */
export interface Tuning {
  /** −0.5 … 0.5 — eases every colour toward white or black. */
  brightness: number;
  /** −0.5 … 0.75 — spreads lightness away from the canvas. */
  contrast: number;
  /** 0 … 2 — chroma multiplier. 0 is a greyscale UI. */
  saturation: number;
  /** −1 … 1 — tints the near-neutral tokens amber or steel. */
  warmth: number;
  /** −180 … 180 — rotates every chromatic token. */
  hue: number;
  /** 0 … 3 — multiplies the paper-grain opacity. */
  grain: number;
}

export const IDENTITY: Tuning = {
  brightness: 0,
  contrast: 0,
  saturation: 1,
  warmth: 0,
  hue: 0,
  grain: 1,
};

const RAD = Math.PI / 180;
const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);
const norm360 = (deg: number) => ((deg % 360) + 360) % 360;
/** Trim float noise so an untouched token round-trips to its authored text. */
export const round = (n: number, places = 4) => Number(n.toFixed(places));

/* ── Colour space conversion ─────────────────────────────────────────────── */

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

const labToLch = (l: number, a: number, b: number): Oklch => ({
  l,
  c: Math.hypot(a, b),
  h: norm360(Math.atan2(b, a) / RAD),
});

function linearSrgbToOklch(r: number, g: number, b: number): Oklch {
  const l_ = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m_ = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s_ = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return labToLch(
    0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  );
}

export function hexToOklch(hex: string): Oklch {
  const match = /^#?([\da-f]{3}|[\da-f]{6})$/i.exec(hex.trim());
  const digits = match?.[1];
  if (!digits) return { l: 0.5, c: 0, h: 0 };
  const full = digits.length === 3 ? digits.replace(/./g, (ch) => ch + ch) : digits;
  const channel = (i: number) => srgbToLinear(parseInt(full.slice(i, i + 2), 16) / 255);
  return linearSrgbToOklch(channel(0), channel(2), channel(4));
}

function oklchToLinearSrgb({ l, c, h }: Oklch): [number, number, number] {
  const a = c * Math.cos(h * RAD);
  const b = c * Math.sin(h * RAD);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
}

const EPSILON = 1e-4;
const inGamut = (rgb: number[]) => rgb.every((v) => v >= -EPSILON && v <= 1 + EPSILON);

/**
 * Readout/swatch companion to {@link formatOklch}: an `oklch()` we hand to the
 * browser gets gamut-mapped there, so bring the hex down the same road — bisect
 * the chroma until it fits sRGB rather than clipping each channel, which would
 * swing the hue. Only the extremes of the sliders ever leave the gamut.
 */
export function oklchToHex(color: Oklch): string {
  let mapped = { ...color, l: clamp01(color.l) };
  if (!inGamut(oklchToLinearSrgb(mapped))) {
    let lo = 0;
    let hi = mapped.c;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklchToLinearSrgb({ ...mapped, c: mid }))) lo = mid;
      else hi = mid;
    }
    mapped = { ...mapped, c: lo };
  }
  return `#${oklchToLinearSrgb(mapped)
    .map((v) =>
      Math.round(clamp01(linearToSrgb(v)) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

export function formatOklch({ l, c, h }: Oklch): string {
  const chroma = round(c);
  return chroma === 0 ? `oklch(${round(l)} 0 0)` : `oklch(${round(l)} ${chroma} ${round(h, 2)})`;
}

/**
 * Rasterise any CSS colour onto a 1×1 canvas and read the sRGB pixel back.
 * The fallback path for colours we can't parse ourselves: browsers serialise
 * computed colours inconsistently, but they all paint the same pixels.
 */
let canvasCtx: CanvasRenderingContext2D | null = null;
function rasteriseToHex(cssColor: string): string {
  if (!canvasCtx) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    canvasCtx = canvas.getContext("2d", { willReadFrequently: true });
  }
  if (!canvasCtx) return "#888888";
  canvasCtx.clearRect(0, 0, 1, 1);
  canvasCtx.fillStyle = cssColor;
  canvasCtx.fillRect(0, 0, 1, 1);
  const px = canvasCtx.getImageData(0, 0, 1, 1).data;
  return "#" + [px[0], px[1], px[2]].map((n) => (n ?? 0).toString(16).padStart(2, "0")).join("");
}

/**
 * Read a token's authored colour. A custom property computes to its own token
 * text, so `--background` comes back as the literal `oklch(…)` from index.css —
 * parse that directly and we keep full precision, including chroma too subtle to
 * survive a trip through 8-bit sRGB. Anything else falls back to the canvas.
 */
export function parseCssColor(text: string): Oklch {
  const value = text.trim();
  const fn = /^okl(ch|ab)\(([^)]*)\)$/i.exec(value);
  if (fn) {
    const parts = (fn[2] ?? "").split("/")[0]!.trim().split(/[\s,]+/);
    const num = (raw: string | undefined, pctScale: number): number => {
      if (!raw || raw === "none") return 0;
      const n = parseFloat(raw);
      if (!Number.isFinite(n)) return NaN;
      return raw.endsWith("%") ? (n / 100) * pctScale : n;
    };
    const l = num(parts[0], 1);
    const second = num(parts[1], 0.4);
    const third = num(parts[2], fn[1]?.toLowerCase() === "ch" ? 1 : 0.4);
    if (Number.isFinite(l) && Number.isFinite(second) && Number.isFinite(third)) {
      return fn[1]?.toLowerCase() === "ch"
        ? { l, c: second, h: norm360(third) }
        : labToLch(l, second, third);
    }
  }
  return hexToOklch(rasteriseToHex(value));
}

/* ── The tuning transform ────────────────────────────────────────────────── */

/** Amber. Its opposite (250°) is the steel end of the warmth slider. */
const WARM_HUE = 70;
/** Above this chroma a token counts as "a colour" and warmth leaves it alone. */
const NEUTRAL_CHROMA = 0.05;
/** Chroma a full warmth push adds to a perfectly neutral token. */
const WARM_STRENGTH = 0.03;

/**
 * Exposure-style lift: eases a lightness toward white or black rather than
 * adding a flat offset, so nothing ever clips at the ends and near-white text
 * barely moves while a dark canvas opens right up.
 */
export const lift = (l: number, brightness: number) =>
  brightness >= 0 ? l + brightness * (1 - l) : l + brightness * l;

/** The lightness everything else spreads away from when contrast rises. */
export const pivotOf = (background: Oklch, tuning: Tuning) => lift(background.l, tuning.brightness);

export function lightnessOf(l: number, tuning: Tuning, pivot: number): number {
  return clamp01(pivot + (lift(l, tuning.brightness) - pivot) * (1 + tuning.contrast));
}

export function applyTuning(base: Oklch, tuning: Tuning, pivot: number): Oklch {
  const l = lightnessOf(base.l, tuning, pivot);
  let c = Math.max(0, base.c * tuning.saturation);
  let h = norm360(base.h + tuning.hue);

  if (tuning.warmth !== 0) {
    // Tint in Oklab's a/b plane so a warm push cancels the palette's cool cast
    // instead of interpolating the long way round the hue circle. Weighted by
    // how neutral the token started out, which leaves accents and status
    // colours where the designer put them.
    const neutrality = clamp01(1 - base.c / NEUTRAL_CHROMA);
    if (neutrality > 0) {
      const push = tuning.warmth * WARM_STRENGTH * neutrality;
      const a = c * Math.cos(h * RAD) + push * Math.cos(WARM_HUE * RAD);
      const b = c * Math.sin(h * RAD) + push * Math.sin(WARM_HUE * RAD);
      c = Math.hypot(a, b);
      h = norm360(Math.atan2(b, a) / RAD);
    }
  }

  return { l, c, h };
}
