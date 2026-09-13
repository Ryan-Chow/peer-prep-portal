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

`index.html` loads the local scripts with `?v=N`. Bump **all four together**
(`config.js`, `supabaseClient.js`, `importer.js`, `db.js`) whenever any one of
them changes. There is no build step to fingerprint them, and a returning tab
that pairs a fresh `index.html` with a cached `db.js` calls functions that are
not there yet.

## Layout

- `index.html` — the whole UI: a dc-runtime template (`<x-dc>`) plus one
  `Component extends DCLogic` class in `<script type="text/x-dc">`.
- `db.js` — Supabase data layer. Presents a **synchronous** cache to the UI
  (the UI was written against a mock); mutations are optimistic and roll back.
- `importer.js` — shared JSON import engine (browser + Node CLI).
- `supabaseClient.js` — the single Supabase client. Guard against double
  evaluation: dc-runtime re-injects `<helmet>` scripts into `<head>`.

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

## Conventions

- Data-layer scripts belong in the real `<head>`, never in `<helmet>`.
- Template holes are `{{name}}` and must have a matching `v.name` in
  `renderVals()`; an undefined hole logs a runtime warning.
- Events are `sc-camel-on-click`, loops `<sc-for list as>`, conditionals
  `<sc-if value>`. HTML tags inside the template need the `sc-raw-` prefix
  (`sc-raw-table`, `sc-raw-td`, `sc-raw-select`, …).
- Answer keys never reach a tutee's browser before they answer. Tutees read
  `problems_public` (no key) and get the key back through `revealed_answers`
  or the `submit_answer()` RPC.
- RLS policies that read other tables go through `SECURITY DEFINER` helpers
  (`get_my_role()`, `is_my_tutee()`, …) so they do not recurse.
- No comments in code unless they explain something non-obvious.
