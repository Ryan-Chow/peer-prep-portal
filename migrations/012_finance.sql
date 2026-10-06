-- Peer Prep Academy — migration 012: finance (admin only).
--
-- Run once in the SQL editor, after 011_group_and_biweekly_sessions.sql.
-- Safe to re-run.
--
--   * tutee_rates / tutor_rates: hourly rates with an effective date. A new
--     rate is a new row, so a change never rewrites a session already priced.
--   * session_finance: what one completed session billed and paid out. Made by
--     a trigger when a session is marked completed, editable afterwards.
--   * ledger: income and expenses not tied to a session.
--   * finance_settings: the business time zone (which local day a session
--     falls on) and the ledger's quick-add categories.
--
-- Money is integer cents everywhere. Every table here is admin-only: tutors
-- and tutees have no policy at all, the helper functions are not executable by
-- them, and no view reads these tables.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.finance_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

-- The zone decides which day an evening session belongs to (7pm Pacific is
-- already tomorrow in UTC). Change it on the Finance tab's Rates section.
insert into public.finance_settings (key, value)
values ('quick_categories', '["Ads", "Software", "Materials", "Referral bonus", "Refund", "Package prepayment"]'::jsonb),
       ('timezone', '"America/Los_Angeles"'::jsonb)
on conflict (key) do nothing;

create table if not exists public.tutee_rates (
  id                uuid primary key default gen_random_uuid(),
  tutee_id          uuid not null references public.profiles (id) on delete cascade,
  hourly_rate_cents integer not null check (hourly_rate_cents between 0 and 10000000),
  effective_from    date not null,
  created_by        uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at        timestamptz not null default now(),
  unique (tutee_id, effective_from)
);

create table if not exists public.tutor_rates (
  id                uuid primary key default gen_random_uuid(),
  tutor_id          uuid not null references public.profiles (id) on delete cascade,
  hourly_rate_cents integer not null check (hourly_rate_cents between 0 and 10000000),
  effective_from    date not null,
  created_by        uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at        timestamptz not null default now(),
  unique (tutor_id, effective_from)
);

-- Its own id rather than session_id as the key: deleting a calendar entry, or
-- an account, must not take the money record with it. session_id is unique,
-- so a session still has at most one row.
create table if not exists public.session_finance (
  id                  uuid primary key default gen_random_uuid(),
  session_id          uuid unique references public.sessions (id) on delete set null,
  tutee_id            uuid references public.profiles (id) on delete set null,
  tutor_id            uuid references public.profiles (id) on delete set null,
  session_date        date not null,
  duration_min        integer not null check (duration_min between 0 and 1440),
  billed_cents        integer not null default 0 check (billed_cents between 0 and 100000000),
  paid_to_tutor_cents integer not null default 0 check (paid_to_tutor_cents between 0 and 100000000),
  extra_cost_cents    integer not null default 0 check (extra_cost_cents between 0 and 100000000),
  extra_cost_note     text,
  payment_status      text not null default 'unpaid' check (payment_status in ('unpaid', 'paid', 'waived', 'comped')),
  paid_on             date,
  payout_status       text not null default 'owed' check (payout_status in ('owed', 'paid')),
  payout_on           date,
  notes               text,
  -- A rate was missing when the row was priced, so an amount is a placeholder 0.
  rate_missing        boolean not null default false,
  -- Set when an admin types the payout by hand, so re-splitting a group's pay
  -- leaves it alone.
  tutor_pay_locked    boolean not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists session_finance_date_idx on public.session_finance (session_date);
create index if not exists session_finance_tutee_idx on public.session_finance (tutee_id);
create index if not exists session_finance_tutor_idx on public.session_finance (tutor_id);

create table if not exists public.ledger (
  id           uuid primary key default gen_random_uuid(),
  date         date not null default current_date,
  kind         text not null check (kind in ('income', 'expense')),
  category     text not null check (length(btrim(category)) between 1 and 60),
  amount_cents integer not null check (amount_cents between 1 and 100000000),
  counterparty text,
  tutee_id     uuid references public.profiles (id) on delete set null,
  tutor_id     uuid references public.profiles (id) on delete set null,
  note         text,
  receipt_url  text check (receipt_url is null or receipt_url ~ '^https://[^[:space:]"''<>\\@]+$'),
  created_by   uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists ledger_date_idx on public.ledger (date);

drop trigger if exists session_finance_touch on public.session_finance;
create trigger session_finance_touch
  before update on public.session_finance
  for each row execute function public.touch_updated_at();

drop trigger if exists ledger_touch on public.ledger;
create trigger ledger_touch
  before update on public.ledger
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- RLS: admin only, and only while active
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array['finance_settings', 'tutee_rates', 'tutor_rates', 'session_finance', 'ledger'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('drop policy if exists %I on public.%I', t || '_admin_all', t);
    execute format(
      'create policy %I on public.%I for all to authenticated '
      'using (public.get_my_role() = ''admin'') with check (public.get_my_role() = ''admin'')',
      t || '_admin_all', t);
    execute format('drop policy if exists %I on public.%I', t || '_active_only', t);
    execute format(
      'create policy %I on public.%I as restrictive for all to authenticated '
      'using ((select public.am_active())) with check ((select public.am_active()))',
      t || '_active_only', t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Pricing helpers. Not executable by any client role: they read rates, and
-- the trigger below calls them as the table owner.
-- ---------------------------------------------------------------------------

-- The business's own day for an instant. A zone Postgres does not know falls
-- back to UTC rather than failing the status change that called it.
create or replace function public.finance_local_date(p_at timestamptz)
returns date
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  tz text;
begin
  select value #>> '{}' into tz from public.finance_settings where key = 'timezone';
  if tz is null or not exists (select 1 from pg_timezone_names where name = tz) then
    tz := 'UTC';
  end if;
  return (p_at at time zone tz)::date;
end;
$$;

create or replace function public.finance_rate(p_kind text, p_person uuid, p_on date)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select case p_kind
    when 'tutee' then (select hourly_rate_cents from public.tutee_rates
                       where tutee_id = p_person and effective_from <= p_on
                       order by effective_from desc limit 1)
    when 'tutor' then (select hourly_rate_cents from public.tutor_rates
                       where tutor_id = p_person and effective_from <= p_on
                       order by effective_from desc limit 1)
  end;
$$;

-- The tutor's pay for one row. A group pays the tutor once for the hour,
-- split across the tutees who came (completed rows), the odd cents going to
-- the lowest ids so the shares always add up to the whole.
create or replace function public.finance_tutor_share(p_session uuid)
returns integer
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  s public.sessions;
  minutes numeric;
  rate integer;
  total integer;
  n integer;
  pos integer;
begin
  select * into s from public.sessions where id = p_session;
  if not found then return null; end if;
  rate := public.finance_rate('tutor', s.tutor_id, public.finance_local_date(s.starts_at));
  if rate is null then return null; end if;
  minutes := extract(epoch from (s.ends_at - s.starts_at)) / 60;
  total := round(rate * minutes / 60);
  if s.group_id is null then return total; end if;
  select count(*), count(*) filter (where id < s.id) into n, pos
  from public.sessions where group_id = s.group_id and status = 'completed';
  if n = 0 then return total; end if;
  return total / n + case when pos < total % n then 1 else 0 end;
end;
$$;

-- Re-divides the tutor's pay across a group's finance rows after the set of
-- tutees who came changed. Rows already paid out or typed in by hand keep
-- their amount.
create or replace function public.finance_resplit_group(p_group uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  share integer;
begin
  if p_group is null then return; end if;
  for r in
    select f.id, f.session_id from public.session_finance f
    join public.sessions s on s.id = f.session_id
    where s.group_id = p_group and s.status = 'completed'
      and f.payout_status = 'owed' and not f.tutor_pay_locked
  loop
    share := public.finance_tutor_share(r.session_id);
    if share is not null then
      update public.session_finance set paid_to_tutor_cents = share where id = r.id and paid_to_tutor_cents <> share;
    end if;
  end loop;
end;
$$;

-- A completed session gets its finance row, priced at the rates in effect on
-- its day. Leaving completed removes the row only while nothing has happened
-- to it (unpaid, payout owed); otherwise the record stays for the admin.
create or replace function public.sessions_finance_sync()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  d date;
  minutes integer;
  bill_rate integer;
  pay integer;
begin
  if tg_op <> 'DELETE' and new.status = 'completed'
     and (tg_op = 'INSERT' or old.status is distinct from 'completed') then
    d := public.finance_local_date(new.starts_at);
    minutes := round(extract(epoch from (new.ends_at - new.starts_at)) / 60);
    bill_rate := public.finance_rate('tutee', new.tutee_id, d);
    pay := public.finance_tutor_share(new.id);
    insert into public.session_finance
      (session_id, tutee_id, tutor_id, session_date, duration_min, billed_cents, paid_to_tutor_cents, rate_missing)
    values
      (new.id, new.tutee_id, new.tutor_id, d, minutes,
       coalesce(round(bill_rate * minutes / 60.0), 0), coalesce(pay, 0),
       bill_rate is null or pay is null)
    on conflict (session_id) do nothing;
  end if;

  if tg_op = 'UPDATE' and old.status = 'completed' and new.status <> 'completed' then
    delete from public.session_finance
    where session_id = new.id and payment_status = 'unpaid' and payout_status = 'owed';
  end if;

  if tg_op = 'DELETE' then
    perform public.finance_resplit_group(old.group_id);
  elsif tg_op = 'INSERT' then
    perform public.finance_resplit_group(new.group_id);
  elsif old.status is distinct from new.status or old.group_id is distinct from new.group_id then
    perform public.finance_resplit_group(new.group_id);
    if old.group_id is distinct from new.group_id then
      perform public.finance_resplit_group(old.group_id);
    end if;
  end if;
  return null;
end;
$$;

drop trigger if exists sessions_finance_sync on public.sessions;
create trigger sessions_finance_sync
  after insert or update or delete on public.sessions
  for each row execute function public.sessions_finance_sync();

-- Re-prices the given finance rows from the current rate tables and their
-- sessions: what the Rates tab runs after rates are filled in for rows that
-- were priced without one. Admin only.
create or replace function public.finance_recalculate(p_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  bill_rate integer;
  pay integer;
  n integer := 0;
begin
  if not public.am_active() or public.get_my_role() is distinct from 'admin' then
    raise exception 'Only an admin can recalculate finance rows.' using errcode = '42501';
  end if;
  for r in
    select f.id, f.session_id, f.tutee_id, f.session_date, f.duration_min, f.tutor_pay_locked, f.payout_status, f.paid_to_tutor_cents
    from public.session_finance f where f.id = any(p_ids)
  loop
    bill_rate := public.finance_rate('tutee', r.tutee_id, r.session_date);
    pay := case when r.session_id is null or r.tutor_pay_locked or r.payout_status = 'paid' then r.paid_to_tutor_cents
                else public.finance_tutor_share(r.session_id) end;
    update public.session_finance set
      billed_cents = coalesce(round(bill_rate * r.duration_min / 60.0), billed_cents),
      paid_to_tutor_cents = coalesce(pay, paid_to_tutor_cents),
      rate_missing = bill_rate is null or pay is null
    where id = r.id;
    n := n + 1;
  end loop;
  return n;
end;
$$;

revoke execute on function public.finance_local_date(timestamptz) from public, anon, authenticated;
revoke execute on function public.finance_rate(text, uuid, date) from public, anon, authenticated;
revoke execute on function public.finance_tutor_share(uuid) from public, anon, authenticated;
revoke execute on function public.finance_resplit_group(uuid) from public, anon, authenticated;
revoke execute on function public.sessions_finance_sync() from public, anon, authenticated;
revoke execute on function public.finance_recalculate(uuid[]) from public, anon;
grant execute on function public.finance_recalculate(uuid[]) to authenticated;

-- Sessions already marked completed before this migration get their rows now,
-- priced at whatever rates exist (none yet, on a first run: rate_missing).
insert into public.session_finance
  (session_id, tutee_id, tutor_id, session_date, duration_min, billed_cents, paid_to_tutor_cents, rate_missing)
select s.id, s.tutee_id, s.tutor_id, public.finance_local_date(s.starts_at),
       round(extract(epoch from (s.ends_at - s.starts_at)) / 60),
       coalesce(round(public.finance_rate('tutee', s.tutee_id, public.finance_local_date(s.starts_at))
                      * extract(epoch from (s.ends_at - s.starts_at)) / 3600), 0),
       coalesce(public.finance_tutor_share(s.id), 0),
       public.finance_rate('tutee', s.tutee_id, public.finance_local_date(s.starts_at)) is null
         or public.finance_tutor_share(s.id) is null
from public.sessions s
where s.status = 'completed'
on conflict (session_id) do nothing;
