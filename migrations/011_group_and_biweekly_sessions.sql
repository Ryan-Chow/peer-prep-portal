-- Peer Prep Academy — migration 011: group sessions, and series that repeat
-- every other week.
--
-- Run once in the SQL editor, after 010_problem_images_and_user_admin.sql.
-- Safe to re-run.
--
--   * sessions.group_id: a group session is one row per tutee sharing a
--     group_id, all at the same time with the same tutor. Each tutee keeps their
--     own status (one can be a no-show while the rest attend) and their own
--     session log, and a tutee's RLS still shows them only their own row.
--   * sessions.repeat_weeks: how many weeks apart a series was scheduled (1 or
--     2 from the form), so the calendar can say "every other week".
--   * sessions_no_overlap now lets the rows of one group overlap each other.

alter table public.sessions add column if not exists group_id uuid;
alter table public.sessions add column if not exists repeat_weeks smallint;

create index if not exists sessions_group_idx on public.sessions (group_id) where group_id is not null;

-- A tutee is in a group once.
create unique index if not exists sessions_group_tutee_uniq on public.sessions (group_id, tutee_id) where group_id is not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'sessions_repeat_weeks_range') then
    alter table public.sessions add constraint sessions_repeat_weeks_range
      check (repeat_weeks is null or repeat_weeks between 1 and 4);
  end if;

  -- Still one tutor, one place at a time, except that the rows of the same
  -- group are the same place. A solo session's key is its own id, so it can
  -- overlap nothing. Rebuilt only when the old definition is still in place.
  if not exists (
    select 1 from pg_constraint
    where conname = 'sessions_no_overlap' and pg_get_constraintdef(oid) like '%group_id%'
  ) then
    alter table public.sessions drop constraint if exists sessions_no_overlap;
    alter table public.sessions add constraint sessions_no_overlap
      exclude using gist (
        tutor_id with =,
        (coalesce(group_id, id)) with <>,
        tstzrange(starts_at, ends_at, '[)') with &&
      )
      where (status <> 'cancelled')
      deferrable initially immediate;
  end if;
end;
$$;
