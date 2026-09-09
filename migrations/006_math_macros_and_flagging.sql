-- Peer Prep Academy — migration 006: text macros, and flagging problems that
-- lost their figure.
--
-- Run once in the SQL editor, after 005_session_logs.sql. Safe to re-run.
--
-- Two unrelated repairs to the imported College Board library, both about text
-- that arrived in a shape the app cannot use:
--
--   * \textdollar and \textpercent in the stored question, choices and
--     explanation, which KaTeX will not parse inside maths.
--   * Questions that ask about a graph, table or figure that was never
--     imported alongside them, and so cannot be answered at all.
--
-- Nothing here deletes a problem. The second part only marks them; an admin
-- decides what happens next on the Flagged problems screen.

-- ---------------------------------------------------------------------------
-- Text macros
-- ---------------------------------------------------------------------------

-- KaTeX defines \textdollar in text mode only, so "$\textdollar 5$" — how the
-- exports write a price — is an undefined control sequence and renders as red
-- source. \textpercent it does not define at all.
--
-- index.html carries macros for both, so this rewrite is not what makes them
-- render; it is what stops the stored text depending on those macros. Only
-- these two are rewritten, because only their replacements parse in maths and
-- in prose alike: \$ and \% are legal in both, while the natural spellings of
-- \textdegree and \textbackslash — ^\circ and \backslash — are maths-only and
-- would break every occurrence sitting outside a $…$. Those stay as they are
-- and stay the renderer's problem.
--
-- This has to agree with normalizeMacros() in importer.js exactly. matchKey()
-- there falls back to comparing question text when a file carries no
-- source_id, so a table normalised differently from the file would stop
-- matching, and the next re-import would insert duplicates instead of
-- updating the rows it could no longer recognise.
create or replace function public.normalize_text_macros(p_text text)
returns text
language sql
immutable
as $$
  -- A control word swallows one following space, so "\textdollar 5" is "$5";
  -- keeping the space would introduce one that was never in the source. The
  -- lookahead stops \textdollarsign being rewritten as \$sign.
  select regexp_replace(
           regexp_replace(coalesce(p_text, ''), '\\textdollar(?![a-zA-Z]) ?', '\\$',  'g'),
           '\\textpercent(?![a-zA-Z]) ?', '\\%', 'g')
$$;

revoke execute on function public.normalize_text_macros(text) from public, anon;

do $$
declare
  fixed_q integer;
  fixed_e integer;
  fixed_c integer;
begin
  update public.problems
     set question = public.normalize_text_macros(question)
   where question ~ '\\text(dollar|percent)';
  get diagnostics fixed_q = row_count;

  update public.problems
     set explanation = public.normalize_text_macros(explanation)
   where explanation ~ '\\text(dollar|percent)';
  get diagnostics fixed_e = row_count;

  -- choices is a jsonb array of strings. Rebuilt element by element rather
  -- than by rewriting the serialised array, because the JSON text escapes its
  -- own backslashes and a regex over it would have to match both spellings.
  -- WITH ORDINALITY and the matching ORDER BY are what keep A, B, C, D in
  -- their places: jsonb_agg has no inherent order to fall back on, and the
  -- answer is stored as a letter, so a reshuffle would silently regrade the
  -- problem.
  update public.problems p
     set choices = (
           select jsonb_agg(to_jsonb(public.normalize_text_macros(elem #>> '{}')) order by ord)
             from jsonb_array_elements(p.choices) with ordinality as t(elem, ord)
         )
   where jsonb_typeof(p.choices) = 'array'
     and p.choices::text ~ '\\\\text(dollar|percent)';
  get diagnostics fixed_c = row_count;

  raise notice 'normalised macros in % question(s), % explanation(s), % choice list(s)',
    fixed_q, fixed_e, fixed_c;
end $$;

-- ---------------------------------------------------------------------------
-- Flagging
-- ---------------------------------------------------------------------------

alter table public.problems add column if not exists flagged     boolean not null default false;
alter table public.problems add column if not exists flag_reason text;

-- Partial: the flagged rows are the small minority, and the only query that
-- wants them wants exactly them.
create index if not exists problems_flagged_idx on public.problems (flagged) where flagged;

-- A question that says "according to the graph" and carries no graph cannot be
-- answered. The importer takes plain text, so any figure that came with these
-- was dropped on the way in.
--
-- Carrying maths or an image is taken as evidence the question stands on its
-- own — "the graph of $y = 2x + 1$" describes its own graph — so those are
-- left alone. An unescaped $ is the test rather than any $, because the
-- rewrite above leaves literal dollars as \$ and a price is not maths.
--
-- flag_reason is what makes this re-runnable, and it is why unflagging in the
-- app clears `flagged` but keeps the reason: a row that has been looked at
-- once, and judged fine, must not be flagged again by a later run.
do $$
declare
  phrases constant text :=
    'according to the graph|the graph shows|in the figure|the table shows|'
    'shown in the table|the scatterplot|the bar graph|the histogram|'
    'the diagram|the xy-plane above';
  hits integer;
begin
  update public.problems p
     set flagged = true,
         flag_reason = 'mentions "' || substring(lower(p.question) from phrases) ||
                       '" but has no figure'
   where p.flag_reason is null
     and lower(p.question) ~ phrases
     -- no maths
     and p.question !~ '(^|[^\\])\$'
     and p.question !~ '\\\('
     and p.question !~ '\\\['
     -- no image
     and p.question !~* '(<img|https?://|\.(png|jpe?g|gif|svg|webp))';
  get diagnostics hits = row_count;

  raise notice 'flagged % problem(s) that reference a figure they do not carry', hits;
end $$;

-- problems_public is deliberately left as 003 wrote it. A flagged problem that
-- is already inside somebody's assignment still has to render: 003 freezes
-- problem_ids at assignment time precisely so a later edit cannot change the
-- work a tutee was set, and hiding the row here would leave them an assignment
-- with a hole in it. New assignments never pick a flagged problem — the assign
-- screen filters them out — and deleting one, which an admin does from the
-- Flagged problems screen, is what removes it from the assignments that
-- already name it.
--
-- No new policy either: problems_admin_write already covers the update behind
-- flagging and unflagging, and the delete behind clearing them out.
