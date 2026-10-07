import "@fontsource-variable/inter";
import "@fontsource-variable/newsreader";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import App from "./App";
import { AuthProvider } from "./auth/AuthProvider";
import { Alert } from "./components/ui/Alert";
import "./index.css";
import { isSupabaseConfigured, supabase } from "./lib/supabase";
import { initTheme } from "./lib/theme";

initTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {supabase && isSupabaseConfigured ? (
      <BrowserRouter>
        <AuthProvider client={supabase}>
          <App />
        </AuthProvider>
      </BrowserRouter>
    ) : (
      <main className="mx-auto max-w-md px-4 py-16">
        <Alert tone="error">
          Supabase is not configured. Set SUPABASE_URL and SUPABASE_ANON_KEY in the root .env file, then restart the dev server.
        </Alert>
      </main>
    )}
  </StrictMode>,
);
