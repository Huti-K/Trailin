import * as React from "react";

export type ThemePref = "light" | "dark" | "system";

const STORAGE_KEY = "trailin-theme";
const EVENT = "trailin:theme-changed";

function readPref(): ThemePref {
  if (typeof window === "undefined") return "system";
  const saved = localStorage.getItem(STORAGE_KEY);
  return saved === "light" || saved === "dark" ? saved : "system";
}

function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function resolve(pref: ThemePref): "light" | "dark" {
  return pref === "system" ? (systemPrefersDark() ? "dark" : "light") : pref;
}

/**
 * Three-way theme preference (light/dark/system). Uses a localStorage +
 * window-event pattern so every hook instance (header toggle, Settings row)
 * stays in sync without lifting state.
 */
export function useTheme() {
  const [pref, setPref] = React.useState<ThemePref>(readPref);
  const [resolved, setResolved] = React.useState<"light" | "dark">(() => resolve(readPref()));

  // Apply the resolved theme to <html>, persist the pref, and broadcast it.
  React.useEffect(() => {
    const next = resolve(pref);
    setResolved(next);
    document.documentElement.classList.toggle("dark", next === "dark");
    localStorage.setItem(STORAGE_KEY, pref);
    window.dispatchEvent(new CustomEvent(EVENT, { detail: pref }));
  }, [pref]);

  // While following the system, keep resolving live as the OS setting changes.
  React.useEffect(() => {
    if (pref !== "system") return;
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      const next = mql.matches ? "dark" : "light";
      setResolved(next);
      document.documentElement.classList.toggle("dark", next === "dark");
    };
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [pref]);

  // Cross-instance sync — another hook instance changed the pref.
  React.useEffect(() => {
    const handlePref = (e: CustomEvent<ThemePref>) => {
      if (e.detail !== pref) setPref(e.detail);
    };
    window.addEventListener(EVENT, handlePref as EventListener);
    return () => window.removeEventListener(EVENT, handlePref as EventListener);
  }, [pref]);

  return [pref, resolved, setPref] as const;
}
