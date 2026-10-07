# Student Experience & Product Polish (Phase 12)

Goal: one continuous learning loop - **Learn -> Practice -> Test -> Analyze -> Improve -> Repeat** - instead of eight separate mini-apps.
Nothing here adds an AI feature. Everything is built from records the app already had; nothing is invented to look busy.

## What changed

| Area | Change |
| --- | --- |
| Frame | A top bar on every screen: **global search** (Ctrl/Cmd+K, or the search button) and **notifications**. Nav is Dashboard, AI Tutor, My Notes, Quiz, Study Plan, Progress, Viva, Recommendations; Settings is separate. Active page is marked (`aria-current`). Phones: a bottom bar with four modules + **More**. |
| Dashboard | Order: welcome (+ honest one-line summary, real streak) -> **Continue learning** hero -> today's progress -> **Today's focus** + **Recommended for you** (what / why / action) -> progress snapshot, **subject overview**, weak topics, viva -> recent activity -> quick actions. |
| Continue learning | `GET /api/dashboard` now carries `resume`: the single best thing to pick up, chosen from real records in this order: session in progress -> unfinished quiz attempt (<=3 days) -> unfinished viva (<=7 days) -> next session planned today -> latest tutor chat / note / quiz result (<=14 days). With none of these the hero falls back to the top recommendation, then to a "start here" prompt. The same shortcut appears in the sidebar and on module screens (`ContinueBar`) without another request. |
| Search | `GET /api/search?q=` - one SQL statement, the student's own ready notes, ready quizzes, study plans, tutor chats, subjects and topics, 5 per group. Navigation only - no AI. |
| Notifications | `GET /api/notifications` - derived on request: missed and today's study sessions, latest quiz / viva result (3 days), the top recommendation. "Read" is remembered in this browser only (`localStorage`). Nothing stored, scheduled or pushed. |
| Hand-offs | Notes -> Quiz (`/quiz/new?document=<id>`, document pre-selected only if it is the student's own ready note), search topic -> Tutor, dashboard recommendation -> its screen. Existing: Recommendation -> Tutor/Quiz/Viva/Notes/Plan, Quiz -> Tutor, Viva -> Tutor, Notes -> Tutor, Study Plan -> Tutor, Progress -> Tutor/Quiz. **None of them creates or sends anything**; the Tutor only receives a draft. |
| States | Shared `Skeleton*`, `LoadingState`, `ErrorState` (calm sentence + Retry). `request()` turns a response the app cannot read into a plain message. Offline banner (honest: "some features may be unavailable"). |
| Settings | Profile (name, **time zone**), AI & privacy (what answers questions, where it runs - read from the public health probe), About, Sign out. No keys or credentials are shown. |
| Installable | `manifest.webmanifest`, icons (192/512/maskable/Apple), theme colour, shortcuts. **No service worker, no push, no offline cache** (private data is never cached by the browser layer). |
| Performance | Route-level code splitting: the entry bundle fell from ~871 kB to ~517 kB; screens load when opened. The dashboard shares one recommendations request between its hero and its card. |
| Accessibility | Skip link, labelled search combobox (`aria-activedescendant`), focus trap + Escape + focus return in search/notifications/menus, 44px targets, status regions announce loading once, higher-contrast placeholders, states written out (never colour alone). |

## Not done (deliberately)

- **Bookmarks / favourites**: needs a new table and UI; deferred (documented, not started).
- **Push notifications, background jobs, scheduled work, offline sync, a service worker.**
- No new AI behaviour, provider or model.

## Safety

No database migration. Search and notifications run as the signed-in student (`withUser` -> RLS) and also filter by the verified user id.
Responses are validated and every link is an in-app path (`/...`), so server data cannot inject navigation.
