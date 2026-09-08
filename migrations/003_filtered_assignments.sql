-- Peer Prep Academy — migration 003: filtered assignments.
--
-- Run once in the SQL editor, after 002_error_log.sql. Safe to re-run.
--
-- An assignment stops meaning "the whole module" and starts meaning "this set
-- of problems out of the module". A tutor picks a difficulty, some tags and a
-- count; that filter is resolved once, at assignment time, and the resulting
-- problem ids are stored on the row. Later edits to the module — a problem
-- added, retagged or reworded by an import — cannot silently change what a
-- tutee was asked to do.
--
--   difficulty     'easy' | 'medium' | 'hard', matched against problems.tags
--   tag_filter     the non-difficulty tags the tutor chose
--   problem_limit  how many were taken at random out of the matches
--   problem_ids    the resolved set; null means "the whole module, always"
--   label          what the filter was, in words, for both sides to display
--
-- The first three are kept only so the row can explain itself; problem_ids is
-- what the app and these policies actually read.

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------

alter table public.assignments add column if not exists difficulty    text;
alter table public.assignments add column if not exists tag_filter    text[];
alter table public.assignments add column if not exists problem_limit integer;
alter table public.assignments add column if not exists problem_ids   uuid[];
alter table public.assignments add column if not exists label         text;

alter table public.assignments drop constraint if exists assignments_difficulty_check;
alter table public.assignments add constraint assignments_difficulty_check
  check (difficulty is null or difficulty in ('easy', 'medium', 'hard'));

alter table public.assignments drop constraint if exists assignments_problem_limit_check;
alter table public.assignments add constraint assignments_problem_limit_check
  check (problem_limit is null or problem_limit > 0);

-- The same module can now be assigned to the same tutee more than once — a
-- ten-question warm-up and the full set are different pieces of work — so the
-- unique key that used to forbid it has to go. It was written as a table-level
-- UNIQUE, whose constraint name depends on how the table was created, so find
-- it by the columns it covers rather than by name.
do $$
declare
  con record;
begin
  for con in
    select c.conname
      from pg_constraint c
      join pg_class      r on r.oid = c.conrelid
      join pg_namespace  n on n.oid = r.relnamespace
     where n.nspname = 'public'
       and r.relname = 'assignments'
       and c.contype = 'u'
       and c.conkey @> array[
             (select attnum from pg_attribute where attrelid = r.oid and attname = 'tutee_id'),
             (select attnum from pg_attribute where attrelid = r.oid and attname = 'module_id')
           ]::smallint[]
  loop
    execute format('alter table public.assignments drop constraint %I', con.conname);
  end loop;
end $$;

-- That unique key was also the index every "what is this tutee assigned in
-- this module?" lookup rode on, including the one below.
create index if not exists assignments_tutee_module_idx
  on public.assignments (tutee_id, module_id);

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------

-- True when the caller has an assignment that reaches this particular problem.
-- The module is checked as well as the id list, which makes a stray id inert:
-- a tutor who wrote another module's problem id into problem_ids would unlock
-- nothing, because the assignment's module would not match.
create or replace function public.is_assigned_problem(p_problem uuid, p_module uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.assignments a
     where a.tutee_id = auth.uid()
       and a.module_id = p_module
       and (a.problem_ids is null or p_problem = any (a.problem_ids))
  );
$$;

revoke execute on function public.is_assigned_problem(uuid, uuid) from public, anon;
grant execute on function public.is_assigned_problem(uuid, uuid) to authenticated;

-- problems still has no tutee SELECT policy, for the reason it never had one:
-- `answer` and `explanation` live on this table and RLS filters rows, not
-- columns. The tutee-facing gate is problems_public's WHERE clause, restated
-- below in terms of the problem rather than the module.
drop policy if exists problems_select on public.problems;
create policy problems_select on public.problems for select to authenticated
using (public.get_my_role() in ('admin', 'tutor'));

-- Same column list as 001 left it; only the access check changes. A tutee
-- assigned ten problems out of forty can read those ten.
create or replace view public.problems_public as
select p.id, p.module_id, p.question, p.type, p.choices, p.sort_order, p.tags
from public.problems p
where public.get_my_role() in ('admin', 'tutor')
   or public.is_assigned_problem(p.id, p.module_id);

revoke all on public.problems_public from public, anon;
grant select on public.problems_public to authenticated;

-- Answering is gated on the same rule: being assigned the module is no longer
-- enough to submit — and so to unlock the key for — a problem left out of the
-- assignment.
create or replace function public.submit_answer(p_problem_id uuid, p_answer text)
returns table (is_correct boolean, correct_answer text, explanation text)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  prob   public.problems%rowtype;
  graded boolean;
begin
  select * into prob from public.problems where id = p_problem_id;
  if not found then
    raise exception 'unknown problem';
  end if;

  if public.get_my_role() <> 'tutee'
     or not public.is_assigned_problem(prob.id, prob.module_id) then
    raise exception 'not assigned';
  end if;

  graded := regexp_replace(lower(btrim(coalesce(p_answer, ''))), '\s+', '', 'g')
          = regexp_replace(lower(btrim(coalesce(prob.answer, ''))), '\s+', '', 'g');

  insert into public.submissions (tutee_id, problem_id, answer, is_correct)
  values (auth.uid(), p_problem_id, p_answer, graded)
  on conflict (tutee_id, problem_id)
    do update set answer = excluded.answer,
                  is_correct = excluded.is_correct,
                  created_at = now();

  return query select graded, prob.answer, prob.explanation;
end;
$$;

revoke execute on function public.submit_answer(uuid, text) from public, anon;
grant execute on function public.submit_answer(uuid, text) to authenticated;
