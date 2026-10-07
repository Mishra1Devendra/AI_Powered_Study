# Release readiness scorecard (end of Phase 13)

**Verdict: ready for internal testing and continued development. NOT ready for a public launch or an open beta.**
Reasons: no real-browser run with real accounts has been done, the hosted-AI question (docs/DEPLOYMENT.md section 5) is undecided, and capacity under several simultaneous students is untested.

Legend: PASS / PARTIAL / FAIL / DEFERRED. Evidence = what was actually run (see docs/TESTING.md).

| Area | Result | Evidence |
|---|---|---|
| Authentication | PARTIAL | Token verification (ES256/RS256, issuer, audience, role) and the 401 matrix tested for real; signup/login validation in web unit tests. Real Supabase signup/login NOT run by the assistant. |
| Authorization / RLS | PASS | Journey test: student B refused on every record of student A, over the API and directly in SQL (select/insert/update/delete) for all 15 tables, anon sees nothing; RLS on for 15/15 tables in the live DB. |
| Storage security | PASS | Bucket private, 10 MB, 3 mime types; per-folder policies; cross-folder insert rejected; student delete/update cannot remove/rename. Storage HTTP API itself not exercised. |
| Dashboard | PASS | Journey step + web tests. |
| Tutor | PASS | Real Ollama: grounded answer in 4.7 s, real source returned; Mock fallback labelled when Ollama is down. |
| Notes | PASS | Real text-PDF processed and searched; unsupported/empty/oversize/image-only cases covered by unit + route tests; assistant (summarize) 17.9 s on real Ollama. |
| Knowledge grounding | PASS | Bug found and fixed (filler words / chosen document -> false "not in your notes"); regression test added. |
| Quiz | PASS | Real Ollama: 3 MCQ in 81.6 s; answers unreadable by the student role during/before review; malformed-output matrix. |
| Study plan | PASS | Validation + malformed-output matrix + Mock path; real-Ollama plan generation not timed. |
| Progress | PASS | Derived from real attempts in the journey; no double counting. |
| Viva | PASS | Real Ollama: first question 5.7 s, evaluation 22.1 s; key points hidden before evaluation. |
| Recommendations | PARTIAL | Rule-based list verified against real data; the optional AI explanation was exercised only with no history (calm "nothing to explain"), not with the real model. |
| Search | PASS | Journey + isolation. |
| Notifications | PASS | Journey + isolation; polling/timers audited (no AI behind them). |
| Mobile | PASS | 375 px: no horizontal overflow on login/signup/404/redirects. Authenticated screens verified in Phase 12 with the dev fakes, not re-run on real accounts. |
| PWA | PASS | Manifest + 4 icons served; no service worker registered; no offline claim. |
| Error handling | PASS | Calm typed errors; no stack/host/provider text in any student-visible payload (asserted for every AI feature, with Ollama stopped and with malformed output). |
| Performance | PARTIAL | Timers/listeners audited by reading code (all cleaned up; polling is plain API reads); no long-session profiling or load test. |
| AI reliability | PASS | 15 bad-reply shapes x 4 features, 300k-char reply, mid-stream failure, duplicate send -> 409, Ollama up and down. Small local model may still fail structured tasks; it fails calmly. |
| Zero-cost policy | PASS | No paid SDK/host/key; no frontend AI; no scheduler/background AI; fetch spy shows only the local Ollama host. External billing cannot be independently verified. |
| Production build | PASS | typecheck clean (shared, api, web); build OK; bundle guard OK (38 files). |
| Deployment readiness | PARTIAL | Documented (docs/DEPLOYMENT.md). Needs a same-origin proxy and a decision on where Ollama runs. Nothing deployed. |
