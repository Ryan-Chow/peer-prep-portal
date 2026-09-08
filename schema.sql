-- Peer Prep Academy — Supabase schema.
-- Run once in the SQL editor of a fresh project. Safe to re-run.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  username     text unique,
  display_name text,
  -- Mirrored from auth.users so tutor/admin rosters can show it; auth.users
  -- itself is not readable through the anon key.
  email        text,
  role         text not null default 'tutee' check (role in ('admin', 'tutor', 'tutee')),
  created_at   timestamptz not null default now()
);

create table if not exists public.tutor_tutees (
  tutor_id   uuid not null references public.profiles (id) on delete cascade,
  tutee_id   uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (tutor_id, tutee_id)
);

-- One tutor per tutee: the admin UI reassigns rather than adds.
create unique index if not exists tutor_tutees_tutee_key on public.tutor_tutees (tutee_id);

create table if not exists public.modules (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  subject     text not null default 'General',
  description text,
  created_at  timestamptz not null default now()
);

create table if not exists public.problems (
  id          uuid primary key default gen_random_uuid(),
  module_id   uuid not null references public.modules (id) on delete cascade,
  question    text not null,
  type        text not null default 'mc' check (type in ('mc', 'free')),
  choices     jsonb,
  answer      text not null,
  explanation text,
  sort_order  integer not null default 0
);

create index if not exists problems_module_idx on public.problems (module_id, sort_order);

create table if not exists public.assignments (
  id          uuid primary key default gen_random_uuid(),
  tutee_id    uuid not null references public.profiles (id) on delete cascade,
  module_id   uuid not null references public.modules (id) on delete cascade,
  assigned_by uuid references public.profiles (id) on delete set null,
  due_date    date,
  created_at  timestamptz not null default now(),
  unique (tutee_id, module_id)
);

create index if not exists assignments_tutee_idx on public.assignments (tutee_id);
create index if not exists assignments_assigned_by_idx on public.assignments (assigned_by);

create table if not exists public.submissions (
  id         uuid primary key default gen_random_uuid(),
  tutee_id   uuid not null references public.profiles (id) on delete cascade,
  problem_id uuid not null references public.problems (id) on delete cascade,
  answer     text,
  is_correct boolean,
  created_at timestamptz not null default now(),
  unique (tutee_id, problem_id)
);

create index if not exists submissions_tutee_idx on public.submissions (tutee_id);

-- ---------------------------------------------------------------------------
-- New-user trigger: mirror auth.users into profiles using signup metadata.
-- ---------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  meta_role text;
begin
  meta_role := nullif(new.raw_user_meta_data ->> 'role', '');
  if meta_role is null or meta_role not in ('admin', 'tutor', 'tutee') then
    meta_role := 'tutee';
  end if;

  insert into public.profiles (id, username, display_name, email, role)
  values (
    new.id,
    nullif(new.raw_user_meta_data ->> 'username', ''),
    coalesce(
      nullif(new.raw_user_meta_data ->> 'display_name', ''),
      split_part(coalesce(new.email, ''), '@', 1)
    ),
    new.email,
    meta_role
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- SECURITY DEFINER helpers.
--
-- Policies that query other tables would otherwise re-enter RLS (profiles
-- policies reading profiles, etc.) and recurse. These run as the owner, so
-- they read the underlying tables directly.
-- ---------------------------------------------------------------------------

create or replace function public.get_my_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.profiles where id = auth.uid();
$$;

-- true when the argument is a tutee of the caller
create or replace function public.is_my_tutee(p_tutee uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.tutor_tutees
    where tutor_id = auth.uid() and tutee_id = p_tutee
  );
$$;

-- true when the argument is the caller's tutor (tutees show "Assigned by …")
create or replace function public.is_my_tutor(p_tutor uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.tutor_tutees
    where tutee_id = auth.uid() and tutor_id = p_tutor
  );
$$;

-- true when the caller has an assignment for the given module
create or replace function public.is_assigned_module(p_module uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.assignments
    where tutee_id = auth.uid() and module_id = p_module
  );
$$;

revoke execute on function public.get_my_role() from public, anon;
revoke execute on function public.is_my_tutee(uuid) from public, anon;
revoke execute on function public.is_my_tutor(uuid) from public, anon;
revoke execute on function public.is_assigned_module(uuid) from public, anon;
grant execute on function public.get_my_role() to authenticated;
grant execute on function public.is_my_tutee(uuid) to authenticated;
grant execute on function public.is_my_tutor(uuid) to authenticated;
grant execute on function public.is_assigned_module(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.profiles     enable row level security;
alter table public.tutor_tutees enable row level security;
alter table public.modules      enable row level security;
alter table public.problems     enable row level security;
alter table public.assignments  enable row level security;
alter table public.submissions  enable row level security;

-- profiles -------------------------------------------------------------------

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
using (
  id = auth.uid()
  or public.get_my_role() = 'admin'
  or (public.get_my_role() = 'tutor' and public.is_my_tutee(id))
  or (public.get_my_role() = 'tutee' and public.is_my_tutor(id))
);

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles for update to authenticated
using (id = auth.uid())
with check (id = auth.uid() and role = public.get_my_role());

drop policy if exists profiles_admin_write on public.profiles;
create policy profiles_admin_write on public.profiles for all to authenticated
using (public.get_my_role() = 'admin')
with check (public.get_my_role() = 'admin');

-- tutor_tutees ---------------------------------------------------------------

drop policy if exists tutor_tutees_select on public.tutor_tutees;
create policy tutor_tutees_select on public.tutor_tutees for select to authenticated
using (
  tutor_id = auth.uid()
  or tutee_id = auth.uid()
  or public.get_my_role() = 'admin'
);

drop policy if exists tutor_tutees_admin_write on public.tutor_tutees;
create policy tutor_tutees_admin_write on public.tutor_tutees for all to authenticated
using (public.get_my_role() = 'admin')
with check (public.get_my_role() = 'admin');

-- modules --------------------------------------------------------------------

drop policy if exists modules_select on public.modules;
create policy modules_select on public.modules for select to authenticated
using (
  public.get_my_role() in ('admin', 'tutor')
  or public.is_assigned_module(id)
);

drop policy if exists modules_admin_write on public.modules;
create policy modules_admin_write on public.modules for all to authenticated
using (public.get_my_role() = 'admin')
with check (public.get_my_role() = 'admin');

-- problems -------------------------------------------------------------------
-- Deliberately no tutee SELECT: `answer` and `explanation` live on this table,
-- and RLS filters rows, not columns. Tutees read public.problems_public (no
-- answer key) and get the key back only for problems they have answered.

drop policy if exists problems_select on public.problems;
create policy problems_select on public.problems for select to authenticated
using (public.get_my_role() in ('admin', 'tutor'));

drop policy if exists problems_admin_write on public.problems;
create policy problems_admin_write on public.problems for all to authenticated
using (public.get_my_role() = 'admin')
with check (public.get_my_role() = 'admin');

-- assignments ----------------------------------------------------------------

drop policy if exists assignments_select on public.assignments;
create policy assignments_select on public.assignments for select to authenticated
using (
  tutee_id = auth.uid()
  or public.get_my_role() = 'admin'
  or (public.get_my_role() = 'tutor' and public.is_my_tutee(tutee_id))
);

drop policy if exists assignments_tutor_insert on public.assignments;
create policy assignments_tutor_insert on public.assignments for insert to authenticated
with check (
  public.get_my_role() = 'tutor'
  and public.is_my_tutee(tutee_id)
  and assigned_by = auth.uid()
);

drop policy if exists assignments_tutor_delete on public.assignments;
create policy assignments_tutor_delete on public.assignments for delete to authenticated
using (public.get_my_role() = 'tutor' and public.is_my_tutee(tutee_id));

drop policy if exists assignments_admin_write on public.assignments;
create policy assignments_admin_write on public.assignments for all to authenticated
using (public.get_my_role() = 'admin')
with check (public.get_my_role() = 'admin');

-- submissions ----------------------------------------------------------------
-- Tutees read their own rows but never write them directly: is_correct is
-- decided by public.submit_answer() so a self-graded "true" cannot be posted.

drop policy if exists submissions_select on public.submissions;
create policy submissions_select on public.submissions for select to authenticated
using (
  tutee_id = auth.uid()
  or public.get_my_role() = 'admin'
  or (public.get_my_role() = 'tutor' and public.is_my_tutee(tutee_id))
);

drop policy if exists submissions_admin_write on public.submissions;
create policy submissions_admin_write on public.submissions for all to authenticated
using (public.get_my_role() = 'admin')
with check (public.get_my_role() = 'admin');

-- ---------------------------------------------------------------------------
-- Answer-key protection
-- ---------------------------------------------------------------------------

-- Problem text without the answer key. security_invoker stays off so the view
-- reads public.problems as its owner; the WHERE clause is the access check.
create or replace view public.problems_public as
select p.id, p.module_id, p.question, p.type, p.choices, p.sort_order
from public.problems p
where public.get_my_role() in ('admin', 'tutor')
   or public.is_assigned_module(p.module_id);

-- The key, but only for problems the caller has already submitted.
create or replace view public.revealed_answers as
select p.id, p.module_id, p.answer, p.explanation
from public.problems p
join public.submissions s
  on s.problem_id = p.id
 and s.tutee_id = auth.uid();

revoke all on public.problems_public from public, anon;
revoke all on public.revealed_answers from public, anon;
grant select on public.problems_public to authenticated;
grant select on public.revealed_answers to authenticated;

-- Grade server-side and record the attempt. Mirrors the old client-side
-- comparison: trim, casefold, strip all whitespace.
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

  if public.get_my_role() <> 'tutee' or not public.is_assigned_module(prob.module_id) then
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
