-- Peer Prep Academy — migration 005: per-session tutor logs.
--
-- Run once in the SQL editor, after 004_cascade_problem_deletes.sql. Safe to
-- re-run.
--
--   * student_profiles: the handbook's "STUDENT PROFILE" sheet, filled once at
--     intake. One row per tutee.
--   * session_logs: the handbook's per-session sheet, one row per session.
--
-- Both tables mirror SESSION_LOG_FORMAT.txt field for field. The column order
-- below is the order the fields appear on the paper sheet, and the UI renders
-- them in that same order.

-- ---------------------------------------------------------------------------
-- student_profiles
-- ---------------------------------------------------------------------------

-- The sheet's first field is "STUDENT NAME & GRADE"; the name already lives in
-- profiles.display_name, so only the grade is stored here. Duplicating the name
-- would let the two drift.
create table if not exists public.student_profiles (
  tutee_id             uuid primary key references public.profiles (id) on delete cascade,
  grade                text,
  subjects             text,
  start_date           date,
  regular_schedule     text,
  parent_contact       text,
  goals                text,
  learning_style_notes text,
  updated_at           timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- session_logs
-- ---------------------------------------------------------------------------

-- tutor_id is ON DELETE SET NULL rather than CASCADE: a tutor leaving must not
-- erase the record of the sessions they ran. tutor_initials is on the sheet
-- anyway, so the row still says who wrote it.
--
-- payment_status: session Nº 01 of the handbook offers four options and the
-- rest offer three (they omit "Free Session"). The superset is taken, since a
-- free session can happen at any point and the sheet allows for it once.
create table if not exists public.session_logs (
  id                   uuid primary key default gen_random_uuid(),
  tutor_id             uuid references public.profiles (id) on delete set null,
  tutee_id             uuid not null references public.profiles (id) on delete cascade,
  session_date         date not null default current_date,
  duration             text,
  tutor_initials       text,
  topics_covered       text,
  homework_assigned    text,
  progress_rating      integer check (progress_rating between 1 and 5),
  struggles            text,
  parent_communication text,
  payment_status       text check (payment_status in ('paid', 'invoiced', 'pending', 'free_session')),
  -- A draft is the tutor's own scratch copy; submitting freezes it against
  -- further tutor edits (see the UPDATE policy below).
  status               text not null default 'draft' check (status in ('draft', 'submitted')),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- The tutee's log list, the "days since last submitted log" badge and the
-- admin's date-range filter all read newest first within one tutee.
create index if not exists session_logs_tutee_idx on public.session_logs (tutee_id, session_date desc);
create index if not exists session_logs_tutor_idx on public.session_logs (tutor_id);
create index if not exists session_logs_date_idx  on public.session_logs (session_date desc);

-- No unique constraint on (tutee_id, session_date): two sessions in one day is
-- unusual but legitimate, and the sheet numbers sessions rather than dating
-- them uniquely.

-- ---------------------------------------------------------------------------
-- updated_at
-- ---------------------------------------------------------------------------

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists student_profiles_touch on public.student_profiles;
create trigger student_profiles_touch
  before update on public.student_profiles
  for each row execute function public.touch_updated_at();

drop trigger if exists session_logs_touch on public.session_logs;
create trigger session_logs_touch
  before update on public.session_logs
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.student_profiles enable row level security;
alter table public.session_logs     enable row level security;

-- student_profiles ----------------------------------------------------------

drop policy if exists student_profiles_select on public.student_profiles;
create policy student_profiles_select on public.student_profiles for select to authenticated
using (
  tutee_id = auth.uid()
  or public.get_my_role() = 'admin'
  or (public.get_my_role() = 'tutor' and public.is_my_tutee(tutee_id))
);

-- Split into insert/update/delete rather than `for all` so the tutee's own row
-- stays out of USING: a tutee reads their profile through the policy above and
-- has no write policy anywhere, which is what makes it read-only for them.
drop policy if exists student_profiles_tutor_insert on public.student_profiles;
create policy student_profiles_tutor_insert on public.student_profiles for insert to authenticated
with check (public.get_my_role() = 'tutor' and public.is_my_tutee(tutee_id));

drop policy if exists student_profiles_tutor_update on public.student_profiles;
create policy student_profiles_tutor_update on public.student_profiles for update to authenticated
using (public.get_my_role() = 'tutor' and public.is_my_tutee(tutee_id))
with check (public.get_my_role() = 'tutor' and public.is_my_tutee(tutee_id));

drop policy if exists student_profiles_tutor_delete on public.student_profiles;
create policy student_profiles_tutor_delete on public.student_profiles for delete to authenticated
using (public.get_my_role() = 'tutor' and public.is_my_tutee(tutee_id));

drop policy if exists student_profiles_admin_all on public.student_profiles;
create policy student_profiles_admin_all on public.student_profiles for all to authenticated
using (public.get_my_role() = 'admin')
with check (public.get_my_role() = 'admin');

-- session_logs --------------------------------------------------------------

-- `or tutor_id = auth.uid()` is not redundant with is_my_tutee(): reassigning a
-- tutee to another tutor would otherwise blank out every log the previous tutor
-- wrote, including from their own Session Logs screen.
drop policy if exists session_logs_select on public.session_logs;
create policy session_logs_select on public.session_logs for select to authenticated
using (
  tutee_id = auth.uid()
  or public.get_my_role() = 'admin'
  or (public.get_my_role() = 'tutor' and (public.is_my_tutee(tutee_id) or tutor_id = auth.uid()))
);

drop policy if exists session_logs_tutor_insert on public.session_logs;
create policy session_logs_tutor_insert on public.session_logs for insert to authenticated
with check (
  public.get_my_role() = 'tutor'
  and public.is_my_tutee(tutee_id)
  -- A tutor cannot file a log under someone else's name.
  and tutor_id = auth.uid()
);

-- "Submitted logs are read-only for tutors" is enforced here rather than in the
-- browser. USING selects the rows a tutor may touch — drafts only — so the
-- draft -> submitted transition still passes (the row is a draft when the
-- update begins) while a row already submitted matches nothing and cannot be
-- updated again. WITH CHECK allows either status so that transition can land,
-- and pins tutor_id so the row cannot be handed to another tutor.
drop policy if exists session_logs_tutor_update on public.session_logs;
create policy session_logs_tutor_update on public.session_logs for update to authenticated
using (
  public.get_my_role() = 'tutor'
  and public.is_my_tutee(tutee_id)
  and status = 'draft'
)
with check (
  public.get_my_role() = 'tutor'
  and public.is_my_tutee(tutee_id)
  and tutor_id = auth.uid()
  and status in ('draft', 'submitted')
);

-- Same rule for deletion: an unfinished draft can be thrown away, a submitted
-- log cannot.
drop policy if exists session_logs_tutor_delete on public.session_logs;
create policy session_logs_tutor_delete on public.session_logs for delete to authenticated
using (
  public.get_my_role() = 'tutor'
  and public.is_my_tutee(tutee_id)
  and status = 'draft'
);

-- Admins are the exception the tutor policies are written around: they may edit
-- a submitted log.
drop policy if exists session_logs_admin_all on public.session_logs;
create policy session_logs_admin_all on public.session_logs for all to authenticated
using (public.get_my_role() = 'admin')
with check (public.get_my_role() = 'admin');

-- No tutee write policy of any kind, deliberately. A tutee reads their own
-- profile and their own logs and can change neither.
