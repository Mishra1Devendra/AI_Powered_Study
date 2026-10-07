import { useSyncExternalStore } from "react";

/**
 * Light / dark appearance.
 *
 * The student's choice is saved on this device (localStorage) and applied before the first paint (see the small script in
 * index.html), so a student who picked dark mode keeps it on every visit - after reload, sign-out and sign-in - until they
 * choose Light or Device again. A new visitor starts in dark (the black look of the product); "system" follows the device setting.
 * The choice is deliberately not sent to the server: it is a display preference, not study data.
 */
export type ThemePreference = "light" | "dark" | "system";

export const THEME_STORAGE_KEY = "copilot-theme";
const DEFAULT_THEME: ThemePreference = "dark";
const DARK_QUERY = "(prefers-color-scheme: dark)";
const META_COLOR = { light: "#f7f5ef", dark: "#0b1020" } as const;

function isPreference(v: unknown): v is ThemePreference {
  return v === "light" || v === "dark" || v === "system";
}

/** The saved choice; "dark" (the product look) when nothing, or something unreadable, is saved. Never throws (private mode, blocked storage). */
export function readThemePreference(): ThemePreference {
  try {
    const v = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isPreference(v) ? v : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

function systemPrefersDark(): boolean {
  try {
    return window.matchMedia?.(DARK_QUERY).matches ?? false;
  } catch {
    return false;
  }
}

export const resolveTheme = (pref: ThemePreference): "light" | "dark" => (pref === "dark" || (pref === "system" && systemPrefersDark()) ? "dark" : "light");

/** Puts the theme on the page: the `dark` class (which switches the colour palette) and the browser/phone toolbar colour. */
export function applyTheme(pref: ThemePreference): "light" | "dark" {
  const theme = resolveTheme(pref);
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", META_COLOR[theme]);
  return theme;
}

const listeners = new Set<() => void>();
let current: ThemePreference | null = null;
let watching = false;

function notify() {
  listeners.forEach((l) => l());
}

function watch() {
  if (watching) return;
  watching = true;
  // Another tab changed the choice.
  window.addEventListener("storage", (e) => {
    if (e.key !== THEME_STORAGE_KEY) return;
    current = readThemePreference();
    applyTheme(current);
    notify();
  });
  // The device switched between light and dark - only matters while the choice is "system".
  try {
    window.matchMedia?.(DARK_QUERY).addEventListener?.("change", () => {
      if ((current ?? readThemePreference()) !== "system") return;
      applyTheme("system");
      notify();
    });
  } catch {
    /* old browsers: the system setting is then read once at load */
  }
}

export function setThemePreference(pref: ThemePreference): void {
  current = pref;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, pref);
  } catch {
    /* storage blocked: the choice still applies until the page is closed */
  }
  applyTheme(pref);
  notify();
}

/** Called once at start-up (main.tsx) to match the page to the saved choice. */
export function initTheme(): void {
  current = readThemePreference();
  applyTheme(current);
  watch();
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};
const snapshot = (): ThemePreference => (current ??= readThemePreference());

export function useTheme() {
  const preference = useSyncExternalStore(subscribe, snapshot, () => DEFAULT_THEME);
  const resolved = resolveTheme(preference);
  return {
    preference,
    resolved,
    setPreference: setThemePreference,
    /** Quick switch from the top bar: an explicit light <-> dark choice. */
    toggle: () => setThemePreference(resolved === "dark" ? "light" : "dark"),
  };
}
