import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setThemePreference } from "../../lib/theme";
import { TileSpotlight } from "./TileSpotlight";

function mouseDevice(reducedMotion = false) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((q: string) => ({ matches: q.includes("hover: hover") ? true : q.includes("reduced-motion") ? reducedMotion : false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => (cb(0), 1));
}

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe("TileSpotlight", () => {
  it("is a hidden decorative layer that only exists in dark mode", () => {
    mouseDevice();
    act(() => setThemePreference("light"));
    const light = render(<TileSpotlight />);
    expect(light.container.querySelector(".tile-spotlight")).toBeNull();
    light.unmount();
    act(() => setThemePreference("dark"));
    const dark = render(<TileSpotlight />);
    const layer = dark.container.querySelector(".tile-spotlight");
    expect(layer).toHaveAttribute("aria-hidden", "true");
  });

  it("snaps the four lit tiles to the grid corner nearest the mouse, and ignores touch", () => {
    mouseDevice();
    act(() => setThemePreference("dark"));
    const { container } = render(<TileSpotlight />);
    const layer = container.querySelector<HTMLElement>(".tile-spotlight")!;
    act(() => {
      window.dispatchEvent(Object.assign(new Event("pointermove"), { clientX: 130, clientY: 60, pointerType: "mouse" }));
    });
    expect(layer.style.getPropertyValue("--tx")).toBe("56px"); // round(130/56)*56 - 56
    expect(layer.style.getPropertyValue("--ty")).toBe("0px"); // round(60/56)*56 - 56
    expect(layer).toHaveAttribute("data-on");
    act(() => {
      window.dispatchEvent(Object.assign(new Event("pointermove"), { clientX: 500, clientY: 500, pointerType: "touch" }));
    });
    expect(layer.style.getPropertyValue("--tx")).toBe("56px"); // unchanged by touch
  });

  it("does nothing for people who asked for reduced motion", () => {
    mouseDevice(true);
    act(() => setThemePreference("dark"));
    const { container } = render(<TileSpotlight />);
    act(() => {
      window.dispatchEvent(Object.assign(new Event("pointermove"), { clientX: 130, clientY: 60, pointerType: "mouse" }));
    });
    expect(container.querySelector(".tile-spotlight")).not.toHaveAttribute("data-on");
  });
});
