import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";

// Screens are loaded on demand (route-level code splitting), and the first import of a screen inside the test runner
// includes its transform time. This only changes how long a test WAITS for something to appear; it does not relax any assertion.
configure({ asyncUtilTimeout: 6000 });

afterEach(() => cleanup());
