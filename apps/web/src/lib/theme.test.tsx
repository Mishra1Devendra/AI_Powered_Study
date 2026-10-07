import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeToggle } from "../components/ui/ThemeToggle";
import { THEME_STORAGE_KEY, applyTheme, initTheme, readThemePreference, resolveTheme, setThemePreference } from "./theme";

function mockSystem(dark: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation(() => ({ matches: dark, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.className = "";
  document.head.innerHTML = '<meta name="theme-color" content="#f7f5ef" />';
  mockSystem(false);
});
afterEach(() => vi.unstubAllGlobals());

describe("theme preference", () => {
  it("a new visitor starts in dark, and an unreadable saved value is ignored", () => {
    expect(readThemePreference()).toBe("dark");
    localStorage.setItem(THEME_STORAGE_KEY, "purple");
    expect(readThemePreference()).toBe("dark");
  });

  it("follows the device only while the choice is 'system'; an explicit choice always wins", () => {
    mockSystem(true);
    expect(resolveTheme("system")).toBe("dark");
    expect(resolveTheme("light")).toBe("light");
    mockSystem(false);
    expect(resolveTheme("system")).toBe("light");
    expect(resolveTheme("dark")).toBe("dark"); // device is light, the student chose dark: dark stays
  });

  it("applying dark puts the class, the colour scheme and the toolbar colour on the page; light removes them", () => {
    applyTheme("dark");
    expect(document.documentElement).toHaveClass("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute("content", "#0b1020");
    applyTheme("light");
    expect(document.documentElement).not.toHaveClass("dark");
    expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute("content", "#f7f5ef");
  });

  it("a dark choice is saved and is still dark after a 'reload' (init) - even when the device is light", () => {
    setThemePreference("dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    document.documentElement.className = ""; // a fresh page load
    initTheme();
    expect(document.documentElement).toHaveClass("dark");
  });

  it("choosing Light overrides a dark device and is remembered; choosing Device follows the device and is remembered too", () => {
    mockSystem(true);
    setThemePreference("light");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(document.documentElement).not.toHaveClass("dark");
    setThemePreference("system");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("system");
    expect(document.documentElement).toHaveClass("dark"); // device is dark
  });

  it("blocked storage never throws: the choice still applies for this visit", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(readThemePreference()).toBe("dark");
    expect(() => setThemePreference("dark")).not.toThrow();
    expect(document.documentElement).toHaveClass("dark");
    vi.restoreAllMocks();
  });
});

describe("ThemeToggle", () => {
  it("switches between light and dark, announces its state, and saves the choice", () => {
    setThemePreference("light");
    render(<ThemeToggle />);
    const btn = screen.getByRole("button", { name: "Switch to dark mode" });
    expect(btn).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(btn);
    expect(document.documentElement).toHaveClass("dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(screen.getByRole("button", { name: "Switch to light mode" })).toHaveAttribute("aria-pressed", "true");
    act(() => setThemePreference("light"));
    expect(screen.getByRole("button", { name: "Switch to dark mode" })).toBeInTheDocument();
  });
});
