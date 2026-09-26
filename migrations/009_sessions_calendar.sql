-- Peer Prep Academy — migration 009: the session calendar.
--
-- Run once in the SQL editor, after 008_tutees_cannot_read_session_logs.sql.
-- Safe to re-run.
--
--   * sessions: one row per scheduled tutoring session. A weekly series is N
--     concrete rows sharing a recurrence_id; there is no RRULE anywhere.
--   * tutor_availability: the weekly blocks a tutor says they can teach. Advice
--     for whoever schedules them, never enforced.
--   * session_logs.session_id: which calendar session a sheet was written for.

-- The overlap guard is an exclusion constraint on (tutor_id, time range), and
-- a GiST index cannot compare uuids for equality without btree_gist.
create extension if not exists btree_gist with schema extensions;

-- ---------------------------------------------------------------------------
-- sessions
-- ---------------------------------------------------------------------------

-- Times are timestamptz, so Postgres stores UTC and the browser renders local.
create table if not exists public.sessions (
  id            uuid primary key default gen_random_uuid(),
  tutor_id      uuid not null references public.profiles (id) on delete cascade,
  tutee_id      uuid not null references public.profiles (id) on delete cascade,
  starts_at     timestamptz not null,
  ends_at       timestamptz not null,
  location      text,
  notes         text,
  status        text not null default 'scheduled'
                check (status in ('scheduled', 'completed', 'cancelled', 'no_show')),
  recurrence_id uuid,
  created_by    uuid references public.profiles (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists sessions_tutor_starts_idx on public.sessions (tutor_id, starts_at);
create index if not exists sessions_tutee_starts_idx on public.sessions (tutee_id, starts_at);
create index if not exists sessions_recurrence_idx on public.sessions (recurrence_id) where recurrence_id is not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'sessions_time_order') then
    alter table public.sessions add constraint sessions_time_order
      check (ends_at > starts_at and ends_at - starts_at <= interval '12 hours');
  end if;

  -- One tutor, one place at a time. Cancelled sessions are out of the
  -- constraint, so cancelling frees the slot for something else.
  --
  -- DEFERRABLE INITIALLY IMMEDIATE moves the check from each row to the end of
  -- each statement. Moving a weekly series a day later rewrites every row in
  -- one upsert, and checked row by row, week 1's new time could collide with
  -- week 2's old time before week 2 had moved.
  if not exists (select 1 from pg_constraint where conname = 'sessions_no_overlap') then
    alter table public.sessions add constraint sessions_no_overlap
      exclude using gist (tutor_id with =, tstzrange(starts_at, ends_at, '[)') with &&)
      where (status <> 'cancelled')
      deferrable initially immediate;
  end if;
end;
$$;

-- created_by is whoever inserted the row, whatever the client sent, and an
-- update cannot rewrite it. The client never sends it at all, which is what
-- lets a tutor edit a series an admin created for them: an upsert's proposed
-- row passes the INSERT policy's check even when it ends up as an update.
create or replace function public.sessions_pin_author()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce(auth.uid(), new.created_by);
  else
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;
  return new;
end;
$$;

drop trigger if exists sessions_pin_author on public.sessions;
create trigger sessions_pin_author
  before insert or update on public.sessions
  for each row execute function public.sessions_pin_author();

drop trigger if exists sessions_touch on public.sessions;
create trigger sessions_touch
  before update on public.sessions
  for each row execute function public.touch_updated_at();

alter table public.sessions enable row level security;

-- A tutor reads every session they teach, including one with a tutee who has
-- since been reassigned. The overlap guard still counts those rows against
-- them, and a rejection caused by a session they cannot see would be
-- unexplainable. Writes stay limited to their current tutees.
drop policy if exists sessions_select on public.sessions;
create policy sessions_select on public.sessions for select to authenticated
using (
  public.get_my_role() = 'admin'
  or (public.get_my_role() = 'tutor' and tutor_id = auth.uid())
  or (public.get_my_role() = 'tutee' and tutee_id = auth.uid())
);

drop policy if exists sessions_tutor_insert on public.sessions;
create policy sessions_tutor_insert on public.sessions for insert to authenticated
with check (
  public.get_my_role() = 'tutor'
  and tutor_id = auth.uid()
  and public.is_my_tutee(tutee_id)
);

drop policy if exists sessions_tutor_update on public.sessions;
create policy sessions_tutor_update on public.sessions for update to authenticated
using (
  public.get_my_role() = 'tutor'
  and tutor_id = auth.uid()
  and public.is_my_tutee(tutee_id)
)
with check (
  public.get_my_role() = 'tutor'
  and tutor_id = auth.uid()
  and public.is_my_tutee(tutee_id)
);

drop policy if exists sessions_tutor_delete on public.sessions;
create policy sessions_tutor_delete on public.sessions for delete to authenticated
using (
  public.get_my_role() = 'tutor'
  and tutor_id = auth.uid()
  and public.is_my_tutee(tutee_id)
);

drop policy if exists sessions_admin_all on public.sessions;
create policy sessions_admin_all on public.sessions for all to authenticated
using (public.get_my_role() = 'admin')
with check (public.get_my_role() = 'admin');

-- No tutee write policy: a tutee reads their sessions and changes none.

-- ---------------------------------------------------------------------------
-- tutor_availability
-- ---------------------------------------------------------------------------

-- weekday follows JavaScript's Date.getDay(): 0 is Sunday. Times are wall-clock
-- times in the tutor's own zone with no offset attached, because "Tuesdays
-- 3–6pm" means 3–6pm local through a daylight-saving change.
create table if not exists public.tutor_availability (
  id         uuid primary key default gen_random_uuid(),
  tutor_id   uuid not null references public.profiles (id) on delete cascade,
  weekday    smallint not null check (weekday between 0 and 6),
  start_time time not null,
  end_time   time not null,
  created_at timestamptz not null default now(),
  check (end_time > start_time)
);

create index if not exists tutor_availability_tutor_idx on public.tutor_availability (tutor_id, weekday);

alter table public.tutor_availability enable row level security;

drop policy if exists tutor_availability_select on public.tutor_availability;
create policy tutor_availability_select on public.tutor_availability for select to authenticated
using (public.get_my_role() = 'admin' or tutor_id = auth.uid());

drop policy if exists tutor_availability_tutor_write on public.tutor_availability;
create policy tutor_availability_tutor_write on public.tutor_availability for all to authenticated
using (public.get_my_role() = 'tutor' and tutor_id = auth.uid())
with check (public.get_my_role() = 'tutor' and tutor_id = auth.uid());

drop policy if exists tutor_availability_admin_all on public.tutor_availability;
create policy tutor_availability_admin_all on public.tutor_availability for all to authenticated
using (public.get_my_role() = 'admin')
with check (public.get_my_role() = 'admin');

-- ---------------------------------------------------------------------------
-- session_logs.session_id
-- ---------------------------------------------------------------------------

-- Nullable: every log written before the calendar existed has no session, and
-- a tutor can still log one that was never put on the calendar. SET NULL so
-- deleting a mistaken calendar entry cannot take a submitted sheet with it.
alter table public.session_logs
  add column if not exists session_id uuid references public.sessions (id) on delete set null;

create index if not exists session_logs_session_idx on public.session_logs (session_id) where session_id is not null;
