-- Peer Prep Academy — migration 002: error log, module deletion, unassigning.
--
-- Run once in the SQL editor, after 001_import.sql. Safe to re-run.
--
--   * error_log_entries: a tutee's record of a problem they got wrong, with
--     their own note on why.
--   * module_delete_counts(): what a module deletion is about to destroy, so
--     the confirmation dialog can state it rather than guess.
--   * error_log_view: one readable row per entry, with the access rules baked
--     into the WHERE clause.

-- ---------------------------------------------------------------------------
-- error_log_entries
-- ---------------------------------------------------------------------------

create table if not exists public.error_log_entries (
  id            uuid primary key default gen_random_uuid(),
  tutee_id      uuid not null references public.profiles (id)    on delete cascade,
  problem_id    uuid not null references public.problems (id)    on delete cascade,
  -- Nullable: the submission it came from can be cleared without losing the
  -- tutee's note. The given answer is looked up by (tutee, problem) anyway.
  submission_id uuid references public.submissions (id) on delete set null,
  comment       text,
  resolved      boolean not null default false,
  created_at    timestamptz not null default now(),
  unique (tutee_id, problem_id)
);

create index if not exists error_log_tutee_idx on public.error_log_entries (tutee_id, created_at desc);
create index if not exists error_log_problem_idx on public.error_log_entries (problem_id);

-- Deleting a module cascades: modules -> problems -> error_log_entries, and
-- modules -> problems -> submissions. Both hops are already ON DELETE CASCADE.

-- ---------------------------------------------------------------------------
-- Helper
-- ---------------------------------------------------------------------------

-- True when the caller has already submitted the given problem.
--
-- This is the hinge of the whole feature's security. error_log_view exposes
-- problems.answer and problems.explanation, so if a tutee could log an
-- arbitrary problem_id they would have a free answer key for every problem in
-- a module they are working through. Gating writes on "you have answered this"
-- pins the view's disclosure to exactly what revealed_answers already gives
-- them, and nothing more.
create or replace function public.has_submitted(p_problem uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.submissions
    where tutee_id = auth.uid() and problem_id = p_problem
  );
$$;

revoke execute on function public.has_submitted(uuid) from public, anon;
grant execute on function public.has_submitted(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.error_log_entries enable row level security;

-- A tutee sees only their own rows. A tutor sees only rows belonging to a
-- tutee in their tutor_tutees. Nobody else sees anything.
drop policy if exists error_log_select on public.error_log_entries;
create policy error_log_select on public.error_log_entries for select to authenticated
using (
  tutee_id = auth.uid()
  or public.get_my_role() = 'admin'
  or (public.get_my_role() = 'tutor' and public.is_my_tutee(tutee_id))
);

drop policy if exists error_log_owner_insert on public.error_log_entries;
create policy error_log_owner_insert on public.error_log_entries for insert to authenticated
with check (tutee_id = auth.uid() and public.has_submitted(problem_id));

-- USING picks the rows they may touch, WITH CHECK the state they may leave
-- behind, so neither tutee_id nor problem_id can be swung onto someone else's
-- row or onto a problem they have not answered.
drop policy if exists error_log_owner_update on public.error_log_entries;
create policy error_log_owner_update on public.error_log_entries for update to authenticated
using (tutee_id = auth.uid())
with check (tutee_id = auth.uid() and public.has_submitted(problem_id));

drop policy if exists error_log_owner_delete on public.error_log_entries;
create policy error_log_owner_delete on public.error_log_entries for delete to authenticated
using (tutee_id = auth.uid());

drop policy if exists error_log_admin_write on public.error_log_entries;
create policy error_log_admin_write on public.error_log_entries for all to authenticated
using (public.get_my_role() = 'admin')
with check (public.get_my_role() = 'admin');

-- Deliberately no tutor UPDATE policy. RLS filters rows, not columns, so a
-- tutor policy here would let a tutor rewrite the tutee's comment as well as
-- flip `resolved`. Tutors go through set_error_log_resolved() below, which can
-- touch that one column and nothing else.

-- ---------------------------------------------------------------------------
-- modules: deletion
-- ---------------------------------------------------------------------------

-- schema.sql already grants admins `for all` on modules and assignments, which
-- covers DELETE. These restate the delete case on its own so the intent is
-- visible, and so a project whose `for all` policy was narrowed still has it.
drop policy if exists modules_admin_delete on public.modules;
create policy modules_admin_delete on public.modules for delete to authenticated
using (public.get_my_role() = 'admin');

-- Tutors may unassign, but only from their own tutees. schema.sql created this
-- as assignments_tutor_delete; repeated here so 002 is self-contained on a
-- project that predates it.
drop policy if exists assignments_tutor_delete on public.assignments;
create policy assignments_tutor_delete on public.assignments for delete to authenticated
using (public.get_my_role() = 'tutor' and public.is_my_tutee(tutee_id));

drop policy if exists assignments_admin_delete on public.assignments;
create policy assignments_admin_delete on public.assignments for delete to authenticated
using (public.get_my_role() = 'admin');

-- ---------------------------------------------------------------------------
-- Reading the log
-- ---------------------------------------------------------------------------

-- One row per entry with everything the UI shows. security_invoker stays off,
-- as with problems_public, so the view reads its base tables as owner and the
-- WHERE clause is the access check.
--
-- Reading the answer key here is safe only because of the write policies
-- above: an entry can exist only for a problem its tutee has already
-- submitted, and submitting is what unlocks the key anyway.
--
-- The join to submissions is on (tutee, problem) rather than submission_id so
-- the given answer survives submission_id being nulled out.
--
-- Not filtered by assignment on purpose: unassigning a module must not blank
-- out error log entries the tutee already wrote.
create or replace view public.error_log_view as
select
  e.id,
  e.tutee_id,
  e.problem_id,
  e.submission_id,
  e.comment,
  e.resolved,
  e.created_at,
  p.module_id,
  m.title      as module_title,
  m.subject    as module_subject,
  p.question,
  p.type,
  p.choices,
  p.answer     as correct_answer,
  p.explanation,
  s.answer     as given_answer,
  s.is_correct
from public.error_log_entries e
join public.problems p on p.id = e.problem_id
join public.modules  m on m.id = p.module_id
left join public.submissions s
       on s.tutee_id = e.tutee_id
      and s.problem_id = e.problem_id
where e.tutee_id = auth.uid()
   or public.get_my_role() = 'admin'
   or (public.get_my_role() = 'tutor' and public.is_my_tutee(e.tutee_id));

revoke all on public.error_log_view from public, anon;
grant select on public.error_log_view to authenticated;

-- ---------------------------------------------------------------------------
-- Writing the log
-- ---------------------------------------------------------------------------

-- Adding an entry from the feedback panel. Done as an RPC so the submission it
-- refers to is resolved server-side; the client never learns submission ids.
-- Re-adding an existing entry updates the note rather than failing on the
-- unique constraint.
create or replace function public.add_error_log_entry(p_problem_id uuid, p_comment text)
returns public.error_log_entries
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  sub public.submissions%rowtype;
  out_row public.error_log_entries%rowtype;
begin
  if public.get_my_role() <> 'tutee' then
    raise exception 'only a tutee keeps an error log';
  end if;

  select * into sub
    from public.submissions
   where tutee_id = auth.uid() and problem_id = p_problem_id;
  if not found then
    raise exception 'answer the problem first';
  end if;

  insert into public.error_log_entries (tutee_id, problem_id, submission_id, comment)
  values (auth.uid(), p_problem_id, sub.id, nullif(btrim(coalesce(p_comment, '')), ''))
  on conflict (tutee_id, problem_id)
    do update set comment = excluded.comment,
                  submission_id = excluded.submission_id
  returning * into out_row;

  return out_row;
end;
$$;

revoke execute on function public.add_error_log_entry(uuid, text) from public, anon;
grant execute on function public.add_error_log_entry(uuid, text) to authenticated;

-- The one thing a tutor may change. Also used by the tutee and by admins, so
-- the UI has a single path for the toggle.
create or replace function public.set_error_log_resolved(p_entry_id uuid, p_resolved boolean)
returns public.error_log_entries
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  entry public.error_log_entries%rowtype;
begin
  select * into entry from public.error_log_entries where id = p_entry_id;
  if not found then
    raise exception 'no such entry';
  end if;

  if not (
    entry.tutee_id = auth.uid()
    or public.get_my_role() = 'admin'
    or (public.get_my_role() = 'tutor' and public.is_my_tutee(entry.tutee_id))
  ) then
    raise exception 'not your tutee';
  end if;

  update public.error_log_entries
     set resolved = coalesce(p_resolved, false)
   where id = p_entry_id
  returning * into entry;

  return entry;
end;
$$;

revoke execute on function public.set_error_log_resolved(uuid, boolean) from public, anon;
grant execute on function public.set_error_log_resolved(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- Deleting a module
-- ---------------------------------------------------------------------------

-- What the cascade is about to take with it. Counted server-side so the
-- confirmation states a fact rather than whatever the browser cache last saw.
--
-- The WHERE makes this return no rows at all to a non-admin, so it cannot be
-- used as a side channel for the size of the library.
create or replace function public.module_delete_counts(p_module uuid)
returns table (problems bigint, assignments bigint, submissions bigint, error_log_entries bigint)
language sql
stable
security definer
set search_path = public
as $$
  select
    (select count(*) from public.problems where module_id = p_module),
    (select count(*) from public.assignments where module_id = p_module),
    (select count(*) from public.submissions s
       join public.problems p on p.id = s.problem_id
      where p.module_id = p_module),
    (select count(*) from public.error_log_entries e
       join public.problems p on p.id = e.problem_id
      where p.module_id = p_module)
  where public.get_my_role() = 'admin';
$$;

revoke execute on function public.module_delete_counts(uuid) from public, anon;
grant execute on function public.module_delete_counts(uuid) to authenticated;
