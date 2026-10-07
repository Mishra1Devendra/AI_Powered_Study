# Design system: "Scholar"

The look comes from the app's emblem: **lapis blue and gold**, on warm paper (light) or deep ink-navy (dark). It is frontend-only: no data, API or database behaviour depends on it.

## Where it lives

| What | Where |
|---|---|
| Tokens (colours, fonts, radius, shadows) | `apps/web/src/index.css`, the `@theme` block |
| Dark-mode palette | `apps/web/src/theme-dark.generated.css` (the same token names, re-valued under `html.dark`) |
| Dark-mode fixes a palette swap cannot express | `index.css`, the "DARK MODE" block |
| Shell (sidebar, top bar, phone nav) | `components/layout/AppShell.tsx` |
| Shared primitives | `components/ui/*` (Button, Card, Input, Alert, EmptyState, Logo ...) |
| Hero surface (dashboard focus card, sign-in panel) | `.hero-surface` in `index.css` |

Every screen uses the utility classes `slate-*` (neutrals), `brand-*` (lapis) and `accent-*` (gold). Change a value in the tokens and the whole app follows.

## Choices

* **Neutrals** are warm paper and ink, not cold grey: page `slate-50`, cards `white`, hairlines `slate-200`, secondary text `slate-500/600`, ink `slate-900`.
* **Brand** (lapis, `brand-600` = `#2f55c9`) is for primary actions, links and the active state. In dark mode it lifts to a light lapis and the button label turns dark.
* **Accent** (gold) is for small highlights only: the active-nav bar, streaks, eyebrows on the hero. Never body text on white. On the hero it uses fixed hex values because the gold scale flips in dark mode.
* **Type:** Inter for everything, plus a serif (Newsreader) for page titles (`main h1`, `.font-display`), the hero title and flashcard faces. Both fonts are self-hosted (`@fontsource-variable/*`), so there is no third-party font request and the CSP stays `font-src 'self'`.
* **Shapes:** one shape language in both themes (12px controls, 20px cards, soft warm-tinted shadows in light and hairline borders in dark). The old dark-only pill buttons and monospace labels were removed.
* **Motion:** short, 150-250 ms, and switched off for `prefers-reduced-motion`.

## What is checked, and how

| Check | Where | Result when last run |
|---|---|---|
| Text contrast, both themes (every visible text, 21 screens + 5 overlays, light and dark; gradients judged at their worst stop) | measured in a real browser | 0 failures (AA: 4.5:1 body, 3:1 large text) |
| Token contrast (every text/background pair the design uses) | `apps/web/src/design-tokens.test.ts` (runs in the normal test suite) | 30 checks pass |
| Dark palette complete (all shades incl. 950 for every colour family) | `design-tokens.test.ts` | pass |
| Phone layout (375 px): no horizontal overflow, no interactive element under 36 px | measured in a real browser, 21 screens + 3 overlays | 0 overflow, 0 small targets |
| Heading structure: one `<h1>` per page, one `<main>`, every control has a name, no image without alt text, no duplicate ids | measured in a real browser, 21 screens | 0 problems (after adding a hidden title to the flashcard study screen) |
| Desktop sidebar fits without scrolling at 800 px and 768 px tall | measured | fits |

When you change a colour, run the web tests: `design-tokens.test.ts` fails if a pair stops reading. Rules of thumb that came out of the audits:

* Mid-tone text colours (`text-red-600`, `text-amber-600`, `text-blue-600`, `text-emerald-600`) do not flip in dark mode and are too light on white for small text. Use the 700 shade for text (it flips to a light tint in dark mode); the 600 shades are fine for icons.
* A surface with white text on a gradient must not use the brand scale (it becomes a light colour in dark mode). Use `.hero-surface` (with `palette-light`) or `.brand-chip`, which are the same in both themes.
* Interactive elements are at least 36 px tall; add padding with a negative margin if a text link must stay visually small.

## Weight

The browser only needs Supabase for sign-in (all study data goes through our own API), so `lib/supabase.ts` builds just the auth client with the same settings and storage key as the full client. That took the main JavaScript bundle from 548.9 kB to 434.3 kB (gzip 153.6 to 124.1 kB). `lib/supabase-usage.test.ts` fails if any code reaches for another part of the client (database, storage, realtime), which would not exist in production.

## Deployment note

`index.html` has one inline script (it applies the saved theme before first paint). Its hash is in the CSP of `deploy/Caddyfile` and `deploy/nginx.conf`. If you change that script (for example a theme colour in it), run `npm run csp:hash -w @copilot/web` after building and update the hash in both files.
