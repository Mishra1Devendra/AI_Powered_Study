# Release readiness scorecard (end of Phase 13)

**Verdict: NOT ready for deployment or a public launch.**
AI now defaults to an explicit disabled mode so non-AI API services can start; AI-generating routes must return `503 unavailable`. Gemini remains unavailable until the active model's free-tier eligibility is verified. No real-browser run with real accounts has been done, and capacity under several simultaneous students is untested. AI results below that mention Ollama are historical and do not describe the current runtime.

Legend: PASS / PARTIAL / FAIL / DEFERRED. Evidence = what was actually run (see docs/TESTING.md).

| Area | Result | Evidence |
|---|---|---|
| Authentication | PARTIAL | Token verification (ES256/RS256, issuer, audience, role) and the 401 matrix tested for real; signup/login validation in web unit tests. Real Supabase signup/login NOT run by the assistant. |
| Authorization / RLS | PASS | Journey test: student B refused on every record of student A, over the API and directly in SQL (select/insert/update/delete) for all 15 tables, anon sees nothing; RLS on for 15/15 tables in the live DB. |
| Storage security | PASS | Bucket private, 10 MB, 3 mime types; per-folder policies; cross-folder insert rejected; student delete/update cannot remove/rename. Storage HTTP API itself not exercised. |
| Dashboard | PASS | Journey step + web tests. |
| Tutor | BLOCKED | Historical Ollama result; active Gemini AI is disabled pending free-tier model verification. |
| Notes | PARTIAL | Text-PDF processing/search tests remain applicable; AI assistant is unavailable while Gemini model eligibility is unverified. |
| Knowledge grounding | PASS | Bug found and fixed (filler words / chosen document -> false "not in your notes"); regression test added. |
| Quiz | BLOCKED | Historical Ollama result; active Gemini AI is disabled pending free-tier model verification. |
| Study plan | BLOCKED | Validation tests remain; active Gemini AI is disabled pending free-tier model verification. |
| Progress | PASS | Derived from real attempts in the journey; no double counting. |
| Viva | BLOCKED | Historical Ollama result; active Gemini AI is disabled pending free-tier model verification. |
| Recommendations | PARTIAL | Rule-based list verified against real data; the optional AI explanation was exercised only with no history (calm "nothing to explain"), not with the real model. |
| Search | PASS | Journey + isolation. |
| Notifications | PASS | Journey + isolation; polling/timers audited (no AI behind them). |
| Mobile | PASS | 375 px: no horizontal overflow on login/signup/404/redirects. Authenticated screens verified in Phase 12 with the dev fakes, not re-run on real accounts. |
| PWA | PASS | Manifest + 4 icons served; no service worker registered; no offline claim. |
| Error handling | PARTIAL | Typed errors are tested with scripted responses; no current live Gemini call was made. |
| Performance | PARTIAL | Timers/listeners audited by reading code (all cleaned up; polling is plain API reads); no long-session profiling or load test. |
| AI reliability | PARTIAL | Historical provider tests cover malformed replies and failures; focused Gemini handling tests are mocked. No network call is made, and model eligibility is still unverified. |
| AI policy | BLOCKED | Gemini-only active factory; no provider fallback. Model is not approved until its free-tier eligibility is verified. Google processing/data-use disclosure is required. |
| Production build | HISTORICAL | The earlier typecheck/build result predates the current Gemini-only changes; rerun before deployment. |
| Deployment readiness | BLOCKED | Same-origin proxy is still required; AI can stay disabled, but Gemini cannot be enabled pending model verification. Nothing deployed. |
