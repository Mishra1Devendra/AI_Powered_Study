import { useTheme } from "../../lib/theme";
import { MoonIcon, SunIcon } from "./Icons";

/** One-tap light/dark switch for the top bar. The choice is remembered on this device until the student changes it back. */
export function ThemeToggle() {
  const { resolved, toggle } = useTheme();
  const dark = resolved === "dark";
  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={dark}
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      title={dark ? "Light mode" : "Dark mode"}
      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-600 transition hover:bg-slate-100 hover:text-slate-900"
    >
      {dark ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}
