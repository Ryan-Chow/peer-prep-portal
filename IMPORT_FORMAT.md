# Import format

Bulk-load modules and problems from JSON, either through **Admin → Import** or
from the terminal with `scripts/import.js`. Both read the same file and apply
the same rules.

> Run `migrations/001_import.sql` in the Supabase SQL editor once before using
> either. It adds the `slug`, `source_id` and `tags` columns the importer
> relies on.

## The shape

A file is one object:

```json
{
  "module":   { "title": "...", "subject": "...", "description": "..." },
  "problems": [ { "question": "...", "type": "...", "answer": "..." } ]
}
```

…or an array of those objects, to load several modules at once:

```json
[
  { "module": { "title": "Algebra" },  "problems": [ ... ] },
  { "module": { "title": "Geometry" }, "problems": [ ... ] }
]
```

The Import tab also accepts several files at once — dropping four files is the
same as one array of four.

## `module`

| Field | Required | Notes |
| --- | --- | --- |
| `title` | yes | Must contain at least one letter or digit. Doubles as the module's identity — see [Re-importing](#re-importing). |
| `subject` | no | Defaults to `General`. Shown as the tag on the module card. |
| `description` | no | Defaults to empty. |

Two modules in one file cannot share a title.

## `problems`

An array. Each entry:

| Field | Required | Notes |
| --- | --- | --- |
| `question` | yes | The prompt. May contain LaTeX. |
| `type` | yes | `"multiple_choice"` or `"free_response"`. |
| `choices` | for `multiple_choice` | Exactly four non-empty strings, in A–D order. |
| `answer` | yes | For `multiple_choice`, a single letter `A`–`D`. For `free_response`, the exact string a tutee must type. |
| `explanation` | no | Shown after the tutee answers. May contain LaTeX. |
| `tags` | no | Array of strings. Tutors filter on these when assigning. Not shown to tutees. |
| `difficulty` | no | `"easy"`, `"medium"` or `"hard"`. See [Difficulty](#difficulty). |
| `source_id` | no | Your own identifier for this problem. See [Re-importing](#re-importing). |

Four choices is a hard requirement, not a default: the rest of the portal —
the answer buttons, the tutor's problem editor, the stored answer letter — is
built around A–D throughout.

`free_response` answers are compared as text, so `"7"` and `"7.0"` are
different answers. Write the form you expect a tutee to type.

### Difficulty

Difficulty is not a separate column: it is the tag `easy`, `medium` or `hard`.
Two ways of writing it, both accepted, both ending up as the same tag:

```json
{ "tags": ["algebra", "linear", "hard"] }
{ "tags": ["algebra", "linear"], "difficulty": "hard" }
```

Case does not matter — `"Hard"` is stored as `hard` — so a file exported from
a spreadsheet needs no tidying first. A problem carrying two different
difficulties is an error and is skipped, since it would otherwise turn up in
whichever pool a tutor asked for.

A problem with no difficulty is still importable. It simply never matches when
a tutor filters by one, so a module you plan to assign that way wants the tag
on every problem. `scripts/import.js` prints the breakdown per module before
writing anything.

Every other tag is a topic label. Tutors pick from the distinct tags found in
the module — `"Information and Ideas"`, `"word-problem"` — and can combine one
with a difficulty and a count: *Information and Ideas — Hard (10 random)*.

### LaTeX

Wrap maths in single dollar signs: `"If $3x + 5 = 20$, what is $x$?"`. It is
rendered with KaTeX everywhere the text appears, including the import preview,
so you can check a formula before committing to it.

Backslashes are escaped in JSON, so a LaTeX `\frac` is written `\\frac`, and a
literal dollar sign inside maths is `\\$`:

```json
"question": "A taxi charges a $\\$3$ flat fee plus $\\$2$ per mile."
```

### HTML

HTML tags are stripped from every text field on import. Comparison operators
survive — `$x < 5$` and `$a<b$` are maths, not markup, and are left alone.

## Re-importing

The import is idempotent: running the same file twice leaves the library the
way the first run did. Nothing is duplicated.

**Modules** are matched by a slug derived from the title: lowercased, with runs
of non-alphanumerics turned into hyphens. `"Algebra: Linear Equations"` becomes
`algebra-linear-equations`. If a module with that slug exists, the file updates
its subject and description; otherwise a new one is created.

Renaming a module in the app keeps its original slug, so a file you have
imported before goes on matching the same module.

**Problems** are matched inside their module, by `source_id` when the file
supplies one and by question text otherwise. A matched problem is updated in
place, keeping its position in the module and any submissions against it. An
unmatched one is appended.

Prefer `source_id` if you plan to reword questions — editing the text of a
problem that has no `source_id` reads as a new problem, and you will end up
with both. A `source_id` is unique across the whole library, so the same id
cannot be used in two modules; rows that try are skipped and named in the
summary.

### Existing modules: add or replace

When a module already exists, the Import tab offers a choice per module:

- **Add to existing** (default) — matched problems are updated, new ones are
  appended, and problems already in the module that the file does not mention
  are left alone.
- **Replace all problems** — every problem in the module is deleted first, then
  the file's are inserted. **This deletes tutee submissions** for the removed
  problems, and their progress on that module along with them.

From the CLI, `--replace` applies replace mode to every module in the run.

## Full example

`samples/sample-module.json`, reproduced here:

```json
{
  "module": {
    "title": "Algebra: Linear Equations",
    "subject": "SAT Math",
    "description": "One-variable linear equations: solving, rearranging, and reading them out of a word problem."
  },
  "problems": [
    {
      "question": "If $3x + 5 = 20$, what is the value of $x$?",
      "type": "multiple_choice",
      "choices": ["3", "5", "15", "25"],
      "answer": "B",
      "explanation": "Subtract 5 from both sides to get $3x = 15$, then divide by 3, so $x = 5$.",
      "tags": ["algebra", "linear", "easy"],
      "source_id": "ppa-alg-001"
    },
    {
      "question": "The equation $y = 4x - 7$ is written in slope-intercept form. What is the slope of the line?",
      "type": "multiple_choice",
      "choices": ["$-7$", "$-4$", "$4$", "$7$"],
      "answer": "C",
      "explanation": "In $y = mx + b$ the coefficient $m$ is the slope, and here $m = 4$.",
      "tags": ["algebra", "linear", "slope"],
      "difficulty": "easy",
      "source_id": "ppa-alg-002"
    },
    {
      "question": "A taxi charges a $\\$3$ flat fee plus $\\$2$ per mile. If a ride cost $\\$17$, how many miles was it?",
      "type": "free_response",
      "answer": "7",
      "explanation": "The cost is $3 + 2m = 17$. Subtracting 3 gives $2m = 14$, so $m = 7$ miles.",
      "tags": ["algebra", "word-problem", "medium"],
      "source_id": "ppa-alg-003"
    }
  ]
}
```

## Importing from the admin UI

Sign in as an admin, open **Import**, then either drop `.json` files on the
box, pick them, or paste JSON into the textarea and press **Preview**.

The preview lists every module found, its problem count, and any problems that
failed validation with the reason. Invalid rows are skipped; the rest of the
module still imports. A module whose own fields are broken — no title, no
`problems` array, nothing valid in it — is not imported at all.

Pressing **Import** writes in batches of 100 rows and reports how many modules
were created, and how many problems were inserted, updated, deleted and
skipped.

## Importing from the terminal

```
SUPABASE_URL=https://xxxx.supabase.co \
SUPABASE_SECRET_KEY=sb_secret_... \
node scripts/import.js samples/sample-module.json
```

Needs Node 18 or newer. Nothing to install.

| Option | |
| --- | --- |
| `--dry-run` | Parse, validate and report. Writes nothing. |
| `--replace` | Replace mode for every module in the run. |
| `--batch <n>` | Rows per request. Default 100. |
| `-h`, `--help` | Usage. |

Several files can be given at once. All of them are parsed before anything is
written, so a typo in the third file does not leave the first two half-loaded.

The key must be a **secret** key, not the publishable one in `config.js` — it
bypasses RLS, which is why this is a terminal tool. Keep it out of the repo and
out of the browser.

If a run fails part-way, whatever was written stays. Fix the cause and re-run
the same file: rows already in are matched and updated, not duplicated.
