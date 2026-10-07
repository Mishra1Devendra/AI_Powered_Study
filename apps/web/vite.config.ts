/// <reference types="vitest/config" />
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

// The repo-root `.env` is shared with the API. Only the two PUBLIC Supabase values below are
// exposed to the browser bundle (explicit allowlist) - nothing else from `.env` can leak in,
// in particular never SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL or ANTHROPIC_API_KEY.
export default defineConfig(({ mode }) => {
  // Only these two keys are read (a prefix list, not "everything").
  const env = loadEnv(mode, "../..", ["SUPABASE_URL", "SUPABASE_ANON_KEY"]);
  // loadEnv records NODE_ENV from the root .env as VITE_USER_NODE_ENV, which silently flips
  // `vite build` into development mode (dev React, sample/preview code). Never let that happen.
  delete process.env.VITE_USER_NODE_ENV;
  return {
    plugins: [react(), tailwindcss()],
    define: {
      "import.meta.env.VITE_SUPABASE_URL": JSON.stringify(env.SUPABASE_URL ?? ""),
      "import.meta.env.VITE_SUPABASE_ANON_KEY": JSON.stringify(env.SUPABASE_ANON_KEY ?? ""),
    },
    server: {
      port: 5173,
      // The browser only talks to /api on its own origin; Vite proxies it to Fastify.
      proxy: { "/api": { target: "http://127.0.0.1:3001", changeOrigin: false } },
    },
    test: {
      environment: "jsdom",
      globals: true,
      setupFiles: ["./src/test-setup.ts"],
      css: false,
      // The UI tests drive real user events in jsdom; with every file running in parallel on a laptop a few exceed vitest's 5 s default
      // although each takes about 1 s alone. This only gives slow machines room - no assertion was changed.
      testTimeout: 20_000,
    },
  };
});
