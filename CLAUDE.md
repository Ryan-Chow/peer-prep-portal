# Peer Prep Academy — working notes

Static site on GitHub Pages (no build step, no bundler) talking to Supabase.
Everything must keep working as plain files served from the repo root.

## Schema changes

Two places, every time:

1. **`migrations/NNN_name.sql`** — the permanent, numbered history.
   `001_import.sql`, `002_error_log.sql`, and so on. Never edit a migration
   that has already been applied; add the next number instead.
2. **`migration.sql` at the repo root** — overwritten each change to hold
   **only the SQL from that change**, so it can be pasted into the Supabase
   SQL editor in one go without hunting through the folder.

The root file is a copy of the newest numbered migration, not a running total.

`schema.sql` is the from-scratch definition for a fresh project. Do not edit it
for incremental changes — it stays as the baseline the migrations build on.

Write migrations to be re-runnable: `if not exists`, `create or replace`,
`drop policy if exists` before `create policy`.

## Script cache versions

`index.html` loads the local scripts with `?v=N`. Bump **all five together**
(`config.js`, `supabaseClient.js`, `importer.js`, `db.js`, `finance.js`)
whenever any one of them changes. There is no build step to fingerprint them, and a returning tab
that pairs a fresh `index.html` with a cached `db.js` calls functions that are
not there yet.

## Layout

- `index.html` — the whole UI: a dc-runtime template (`<x-dc>`) plus one
  `Component extends DCLogic` class in `<script type="text/x-dc">`.
- `db.js` — Supabase data layer. Presents a **synchronous** cache to the UI
  (the UI was written against a mock); mutations are optimistic and roll back.
- `importer.js` — shared JSON import engine (browser + Node CLI).
- `finance.js` — the admin Finance tab: one React component, `PpaFinance`,
  built with `createElement` and rendered into the `{{financeEl}}` hole. Its
  view state lives in hooks; its data is `db.finance`.
- `supabaseClient.js` — the single Supabase client. Guard against double
  evaluation: dc-runtime re-injects `<helmet>` scripts into `<head>`.
- `supabase/functions/` — Edge Functions, each holding the service-role key
  the browser must never see: `create-user` (create, PIN reset),
  `update-user` (edit, deactivate, reactivate), `delete-user`, `cache-image`.
  The three newer ones share the admin check in `_shared/admin.ts`. Every one
  refuses a non-admin, a deactivated admin, the caller's own account, and any
  admin account. Deploy each with `supabase functions deploy <name>`.

## Sidebar

The left sidebar replaced the top nav for every role. `renderSidebar()` builds
it with `createElement` (inline SVG icons from `Component.ICONS`, CSS
tooltips from `data-tip`), into the `{{sidebarEl}}` hole. Its state is mirrored
onto `<html>` by `syncShell()` as `ppa-sb` (signed in), `ppa-sb-collapsed`, and
`ppa-nav-open` (phone drawer). The CSS turns those into `--sb-w`: 240, 56, or 0
below 800px and while signed out. `.app-main`, `.calc-launch` and `calcGeom()`
all read `--sb-w`, so the calculator never sits under the sidebar. Collapsed
is saved in `localStorage` (`ppa-sidebar-v1`). The active item scales only
its inner row, from the left, so it cannot clip. A new tab is one entry in
`linkDefs`: `[label, route, icon, badgeCount]`.

## Problem images

`problems.image_url` / `image_alt` / `image_position` (`above` | `below`) and
`choice_images` (null, or exactly four URLs-or-nulls), from migration 010.
`problems_public` and `error_log_view` carry them too.

- **Links only, never markup.** A URL reaches nothing but an `<img src>`.
  `ppaImport.cleanImageUrl()` and SQL `is_image_url()` are the same rule
  (plain `https://`, no spaces, quotes, angle brackets or credentials). Keep
  them in step.
- **Rendering:** every figure goes through `PpaImage` (defined above
  `Component`) via `pic()` in `renderVals()`. It handles lazy loading, no
  referrer, the 420px cap (160px for a choice), click-to-enlarge, and the
  "Image unavailable" box on error. The lightbox is the `{{lightboxLayer}}`
  hole, outside every screen.
- **Storage:** public bucket `problem-images`, objects named
  `img/<sha256>.<ext>`. The editor's Upload, the `cache-image` function and
  `scripts/import.js --cache-images` all use that name, so the same picture
  is stored once. PNG, JPEG, GIF and WebP only; SVG is refused because, opened
  directly from the bucket, it would run script in the storage origin.
- **Re-imports** carry an image field the file leaves out over from the stored
  row (`imageColumns()` in `importer.js`), so a figure attached in the editor
  survives. An explicit `null` clears it.
- Saving a flagged problem with an image unflags it. `flag_missing_figures()`
  skips rows that have one.

## Accounts: deactivate, edit, delete

- `profiles.active` (010). Deactivating goes through `update-user`, which bans
  the account in auth (no sign-in, no refresh) and sets the flag. For the
  access token still alive, every table has a RESTRICTIVE `<table>_active_only`
  policy on `am_active()`. The views and the tutee RPCs check `am_active()`
  themselves, because they run as owner and bypass RLS. **A new table needs
  its own `_active_only` policy, and a new SECURITY DEFINER function a tutee
  can call needs the check.**
- Deactivated users get a grey badge, are left out of every picker that
  creates work (assign, calendar form, tutor links), and stay in the filters
  and history views.
- Permanent delete is `delete-user` → `auth.admin.deleteUser`, which cascades.
  `session_logs.tutor_id` is SET NULL and `tutor_name` (a trigger keeps it
  current, and `delete-user` refreshes it first) keeps the author's name.
  `user_delete_counts()` feeds the confirmation dialog.
- Self-service is a tutor's own `display_name` and nothing else. The
  `profiles` UPDATE policy is tutor-only, and `authenticated` has a column
  grant on `display_name` alone. Admins write other columns through the Edge
  Functions.
- No parent role exists yet. The Users-tab row actions and both functions are
  role-generic, so one is a listing away.

## Module / problem viewer modes

The tutee's module list and problem screen (`route.name` of `module` /
`problem`) are the one viewer for everybody. `route.mode` picks the behaviour:

- `live` — the tutee working an assignment. Answers go through
  `db.submitAnswer()`; the error-log offer appears on a wrong answer.
- `preview` — a tutor or admin seeing exactly what a tutee sees. Answers are
  graded in the browser with `db.gradeAnswer()` (the same comparison as the
  `submit_answer()` RPC) and kept in `state.viewer`; nothing is written. The
  banner's "Show answers" toggle reveals the key for every problem.
- `review` — a tutor or admin reading a tutee's submitted answers. Read-only,
  key always shown, error-log status shown per problem.

`viewerContext(route, me)` is the only place that resolves the route: it forces
`live` for a tutee whatever the route says, refuses `live` for staff, and
refuses a tutor any assignment whose tutee is not in `tutor_tutees` (RLS
already keeps such rows out of the cache; the screen refuses for the same
reason). A preview is over an `assignmentId`, a `moduleId` (all non-flagged
problems), or a `moduleId` plus a `spec` (the assign screen's filter, resolved
by `db.previewAssignment()` — the same resolver `db.assignModule()` uses).
`route.from` names the screen the viewer was opened from, for the back link and
the nav highlight. Every way in goes through `openViewer()`, which clears the
scratch answers of the last preview.

Tutees must never see a Preview button or the Show-answers toggle: both are
rendered only from staff screens or when `mode !== 'live'`.

## Session calendar

`sessions` (migration 009) holds one row per tutoring session. The browser
works in its own zone and stores UTC. `db.atLocal(date, 'HH:MM', plusDays)` is
the one place local wall-clock times become instants, so a weekly 4pm stays
4pm across a DST change.

- **Series** are N concrete rows that share a `recurrence_id`, `repeat_weeks`
  (1 or 2 from the form) apart. There is no RRULE. `db.updateSessions(id, patch, 'one' | 'future')` applies to every
  session in scope only the fields the patch *changes* relative to the session
  it was opened on, so a week that was moved on its own keeps its time when
  only the room changes. The whole scope goes up in one upsert.
- **Group sessions** (migration 011) are one row per tutee sharing a
  `group_id`, same tutor and time. Each tutee keeps their own status and log,
  and RLS still shows a tutee only their own row. `db.collapseSessions()` turns
  rows into one entry per occurrence (with `members`) for every screen that
  draws a session once. Scopes: `'self'` is one tutee's row, `'one'` the whole
  occurrence, `'future'` the rest of the series. A `tuteeIds` patch adds or
  removes tutees across the scope. `db.setSessionStatus(ids, status)` marks
  several rows in one upsert ("Mark everyone completed" skips no-shows).
- **Overlap guard** is the `sessions_no_overlap` exclusion constraint
  (btree_gist, rows of one group exempt from each other via
  `coalesce(group_id, id) with <>`, cancelled rows excluded, `deferrable initially immediate` so a
  series can shift in one statement). `db.js` checks the cache first to name
  the clashing session; a `23P01` from Postgres is still mapped to a readable
  message.
- **RLS:** a tutor *reads* every session with their `tutor_id`, including
  sessions with tutees since reassigned, because the constraint still counts
  those. They *write* only for current tutees. Tutees read their own. Admins
  have full access. No parent role exists yet.
- **Availability** (`tutor_availability`, weekday 0 = Sunday, wall-clock
  times) is advice only. It hatches the week grid and greys time options, and
  never blocks a booking.
- **Logs:** `session_logs.session_id` links a sheet to its session.
  `db.getLogForSession()` falls back to an unlinked sheet for the same tutee on
  the same local day.
- The event popover (`state.calPop`) and the create/edit form
  (`state.calForm`) are overlays outside any screen, because My Students opens
  them too. The grid is built with `createElement` in `renderCalGrid()`, the
  same way the calculator layer is.

## Finance (admin only)

Migration 012. Money is **integer cents** everywhere; `db.finance.parseMoney()`
("45", "45.00", "$45", "$1,234.56") and `fmtMoney()` are the only conversions.

- **Tables:** `tutee_rates` / `tutor_rates` (hourly, `effective_from`; a change
  is a new row, never an edit of history), `session_finance` (one row per
  completed session row), `ledger` (income/expense not tied to a session),
  `finance_settings` (`timezone`, `quick_categories`). Every one is admin-only
  plus `_active_only`. No view reads them; the pricing helpers
  (`finance_rate`, `finance_tutor_share`, …) are revoked from every client
  role, and `finance_recalculate()` checks admin itself.
- **Trigger** `sessions_finance_sync` (SECURITY DEFINER, so a tutor marking a
  session completed still creates the row): prices a newly completed session
  at the rates in effect on its local day (`finance_settings.timezone`).
  Leaving completed deletes the row only if it is still unpaid and owed. A
  group pays the tutor once, split across the tutees who came, re-split as
  that set changes, except rows paid out or typed by hand
  (`tutor_pay_locked`). No rate → $0 with `rate_missing`; the Rates tab's
  "Recalculate" reprices those.
- `session_finance.id` is its own key, with `session_id` unique and SET NULL,
  so deleting a calendar entry or an account keeps the money record.
- **Revenue** = billed on unpaid + paid sessions + ledger income, except a
  "Package prepayment" (the sessions it covers are billed and marked paid, so
  counting both would double it). Costs = tutor pay + session extra costs +
  ledger expenses. "Overdue" = unpaid and more than 14 days old; that count is
  the Finance badge.
- Admin session writes call `financeTouched()`, which rereads
  `session_finance`; the tab also reloads on entry, for sessions tutors
  completed elsewhere.
- No tutee, tutor or parent visibility yet.

## Conventions

- Data-layer scripts belong in the real `<head>`, never in `<helmet>`.
- Template holes are `{{name}}` and must have a matching `v.name` in
  `renderVals()`; an undefined hole logs a runtime warning.
- Events are `sc-camel-on-click`, loops `<sc-for list as>`, conditionals
  `<sc-if value>`. HTML tags inside the template need the `sc-raw-` prefix
  (`sc-raw-table`, `sc-raw-td`, `sc-raw-select`, …).
- Every RLS-enabled table gets a RESTRICTIVE `_active_only` policy (see
  Accounts above).
- Answer keys never reach a tutee's browser before they answer. Tutees read
  `problems_public` (no key) and get the key back through `revealed_answers`
  or the `submit_answer()` RPC.
- RLS policies that read other tables go through `SECURITY DEFINER` helpers
  (`get_my_role()`, `is_my_tutee()`, …) so they do not recurse.
- No comments in code unless they explain something non-obvious.
