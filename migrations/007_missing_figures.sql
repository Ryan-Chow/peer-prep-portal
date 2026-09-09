-- Peer Prep Academy — migration 007: catch the rest of the questions whose
-- figure never arrived.
--
-- Run once in the SQL editor, after 006_math_macros_and_flagging.sql. Safe to
-- re-run.
--
-- 006 flagged these with ten literal phrases, and only when the question
-- carried no maths at all. Both halves of that were too narrow:
--
--   * "In the figure, angle $A$ is $40^\circ$" has maths, so it was exempt —
--     but the angle is still marked on a figure nobody imported. Carrying
--     maths says nothing about whether the question also leans on a picture.
--   * The wording varies far more than ten phrases: "the table below shows",
--     "refer to the scatterplot", "the graph of f is shown", "not drawn to
--     scale", "Figure 1", and so on.
--
-- So the test moves out of a WHERE clause and into a function, built from a
-- noun list crossed with the ways a question points at something it expects
-- you to be looking at. It is deliberately generous: everything it catches
-- lands on the Flagged problems screen, where unflagging is one click and is
-- recorded permanently, so a false positive costs a click and a false negative
-- costs a tutee an unanswerable question.

-- ---------------------------------------------------------------------------
-- Detection
-- ---------------------------------------------------------------------------

-- Returns the reason a question looks figure-dependent, or null if it stands
-- on its own.
create or replace function public.missing_figure_reason(p_question text)
returns text
language plpgsql
immutable
as $$
declare
  -- Nouns for the thing that is missing. Deliberately without "xy-plane" or
  -- "coordinate plane": "In the xy-plane, the graph of $y = x^2 - 4$..." names
  -- its own curve and needs no picture, and that phrasing is everywhere in the
  -- library. Those two are matched below only when something points at them.
  fig constant text :=
    '((bar|line|pie|circle|double ?bar|dot|box|box-and-whisker|stem-and-leaf|'
    'scatter) ?)?'
    '(graph|plot|figure|table|chart|diagram|histogram|scatterplot|boxplot|'
    'number line|picture|image|illustration|drawing|sketch|map|grid|spinner|'
    'venn diagram|tree diagram)';
  q    text := lower(coalesce(p_question, ''));
  pats text[];
  pat  text;
  hit  text;
begin
  if q = '' then
    return null;
  end if;

  -- Three ways a question can carry its own figure, and so be answerable:
  -- an image, a LaTeX table or matrix, or a pipe-delimited table written out
  -- in the text. The last needs two lines each containing a pipe, because a
  -- single pair of pipes is far more likely to be |x - 3| than a table.
  if q ~ '(<img|https?://|\.(png|jpe?g|gif|svg|webp))' then
    return null;
  end if;
  if q ~ '\\begin\{(array|tabular|matrix|bmatrix|pmatrix|vmatrix)\}' then
    return null;
  end if;
  if q ~ '\|[^\n]*\|[^\n]*(\n|\r)[^\n]*\|' then
    return null;
  end if;

  pats := array[
    -- pointed at: "according to the graph", "shown in the table below"
    '\y(according to|based on|refer to|referring to|as shown in|shown in|'
      'graphed in|given in|listed in|displayed in|represented in|'
      'summari[sz]ed in|use|using) the ' || fig || 's?',
    -- A bare preposition is a much weaker signal, and "in the graph of
    -- $y = f(x)$" is the commonest phrasing in the library that needs no
    -- picture at all — the curve is named right there. So these three only
    -- count when the noun is not immediately qualified by "of", which also
    -- keeps "in the table of contents" out.
    '\y(in|on|from) the ' || fig || 's?(?! of\y)',
    -- placed: "the graph above", "the table to the right"
    '\ythe ' || fig || 's? (above|below|shown|given|provided|displayed|'
      '(at|to) the (left|right))',
    '\ythe (above|following|preceding|given|shown|attached|accompanying) ' || fig,
    -- narrated: "the table shows the number of..."
    '\y(this|each|the) ' || fig || 's? (shows|show|displays|display|represents|'
      'represent|gives|give|lists|list|summari[sz]es|indicates|indicate|'
      'models|model|contains|contain)',
    -- "the graph of the function f is shown", with the clause in between
    '\ythe ' || fig || 's?[^.?!]{0,80}(is|are) shown\y',
    -- numbered, as an export of a printed paper leaves them
    '\y(figure|table|graph|diagram|chart|exhibit) \d',
    -- the plane nouns, but only when something points at them
    '\y(xy-?plane|coordinate plane|grid) (above|below|shown)\y',
    -- said of a picture and nothing else
    '\ynot drawn to scale\y',
    '\yas shown\y',
    '\y(pictured|graphed|depicted|illustrated) (above|below|here)\y'
  ];

  foreach pat in array pats loop
    -- The wrapping parens matter: substring() returns the first capture group
    -- when the pattern has any, and every pattern here is full of them, so
    -- without this it would return "the" or "graph" rather than the phrase.
    hit := substring(q from '(' || pat || ')');
    if hit is not null then
      return 'refers to "' || left(btrim(hit), 60) || '" but no figure was imported';
    end if;
  end loop;

  return null;
end $$;

revoke execute on function public.missing_figure_reason(text) from public, anon;

-- ---------------------------------------------------------------------------
-- Backfill
-- ---------------------------------------------------------------------------

-- flag_reason is still the marker that a row has been judged: unflagging in
-- the app clears `flagged` and keeps the reason, so this cannot re-flag
-- anything an admin has already decided is fine. That also means the rows 006
-- caught keep 006's wording, which is harmless — they are already flagged.
do $$
declare
  hits integer;
begin
  update public.problems p
     set flagged = true,
         flag_reason = public.missing_figure_reason(p.question)
   where p.flag_reason is null
     and public.missing_figure_reason(p.question) is not null;
  get diagnostics hits = row_count;

  raise notice 'flagged % further problem(s) that lean on a figure they do not carry', hits;
end $$;

-- ---------------------------------------------------------------------------
-- Rescanning from the app
-- ---------------------------------------------------------------------------

-- The importer does not run this check — it would mean keeping the pattern
-- list above in step with a second copy in JavaScript, and a copy that drifted
-- would be worse than none. So the same sweep is exposed as an RPC and the
-- Flagged problems screen offers it as a button, to be pressed after an
-- import.
--
-- security definer because the sweep must see every problem regardless of who
-- is asking, and the admin check is therefore explicit rather than left to
-- RLS.
create or replace function public.flag_missing_figures()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  hits integer;
begin
  if public.get_my_role() is distinct from 'admin' then
    raise exception 'only an admin can rescan the library';
  end if;

  update public.problems p
     set flagged = true,
         flag_reason = public.missing_figure_reason(p.question)
   where p.flag_reason is null
     and public.missing_figure_reason(p.question) is not null;
  get diagnostics hits = row_count;

  return hits;
end $$;

revoke execute on function public.flag_missing_figures() from public, anon;
grant execute on function public.flag_missing_figures() to authenticated;

-- No schema, view or policy changes. problems_public stays as 003 wrote it for
-- the reason 006 gives: an assignment freezes its problem_ids, so a flagged
-- problem already inside one still has to render. problems_admin_write already
-- covers the update behind flagging and the delete behind clearing them out.
