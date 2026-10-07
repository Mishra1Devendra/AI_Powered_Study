import { defineConfig } from "vitest/config";

// Unit tests only. Integration tests (real Supabase database) run via `npm run test:integration`.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["src/**/*.integration.test.ts", "node_modules/**"],
  },
});
