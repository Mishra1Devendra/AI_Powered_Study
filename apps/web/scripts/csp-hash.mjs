// Prints the CSP hash of every inline <script> in the built index.html, for the Content-Security-Policy in deploy/Caddyfile or deploy/nginx.conf.
// Read-only: it only reads dist/index.html.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../dist/index.html", import.meta.url), "utf8");
const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
if (inline.length === 0) console.log("No inline scripts: use script-src 'self' only.");
for (const [, body] of inline) console.log(`'sha256-${createHash("sha256").update(body).digest("base64")}'`);
