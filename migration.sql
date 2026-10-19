-- Peer Prep Academy — migration 013: session reminders.
--
-- Run once in the SQL editor, after 012_finance.sql. Safe to re-run.
--
--   * notification_prefs: one row per account. Where reminders go (a verified
--     contact email, a phone) and which ones the person wants.
--   * session_reminders: one row per (session, recipient, channel), queued up
--     to 48 hours ahead by send-reminders and marked sent / failed / skipped.
--   * reminder_settings: the scheduler's heartbeat (last_run), for the admin
--     banner.
--   * pg_cron + pg_net: call send-reminders every five minutes.
--
-- BEFORE RUNNING, put two secrets in Vault (SQL editor, once):
--
--   select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
--   select vault.create_secret('<secret key, sb_secret_…>', 'service_role_key');
--
-- The secret key is under Project Settings → API Keys → Secret keys. To change
-- one later: select vault.update_secret(id, '<new value>') with the id from
-- vault.secrets. Then deploy the functions (see CLAUDE.md, Reminders).

-- ---------------------------------------------------------------------------
-- notification_prefs
-- ---------------------------------------------------------------------------

-- Not columns on profiles: a tutee can read their tutor's profiles row and a
-- tutor their tutees', and neither should get the other's phone number or
-- personal address that way. This table is the owner's and the admins' only.
--
-- contact_email is the only address reminders ever use. A tutor signs in with
-- a synthetic username@tutors… address that reaches nobody, so a tutor has
-- none until they or an admin set one. pending_email is an address waiting on
-- its verification link; the old one keeps working until the link is used.
create table if not exists public.notification_prefs (
  profile_id                uuid primary key references public.profiles (id) on delete cascade,
  contact_email             text check (contact_email is null or (contact_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' and char_length(contact_email) <= 254)),
  contact_email_verified_at timestamptz,
  pending_email             text check (pending_email is null or (pending_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' and char_length(pending_email) <= 254)),
  pending_email_sent_at     timestamptz,
  phone                     text check (phone is null or phone ~ '^\+[1-9][0-9]{6,14}$'),
  reminder_email            boolean not null default true,
  reminder_sms              boolean not null default false,
  reminder_lead_min         integer not null default 60 check (reminder_lead_min between 15 and 1440),
  last_test_at              timestamptz,
  updated_at                timestamptz not null default now()
);

drop trigger if exists notification_prefs_touch on public.notification_prefs;
create trigger notification_prefs_touch
  before update on public.notification_prefs
  for each row execute function public.touch_updated_at();

-- Every account has a row, so the browser only ever updates (an upsert would
-- need an UPDATE grant on the key). A tutee's login address is a real inbox
-- the admin typed in, so it starts as their verified contact address.
create or replace function public.profiles_make_prefs()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.notification_prefs (profile_id, contact_email, contact_email_verified_at)
  values (
    new.id,
    case when new.role = 'tutee' then nullif(lower(btrim(new.email)), '') end,
    case when new.role = 'tutee' and nullif(btrim(new.email), '') is not null then now() end
  )
  on conflict (profile_id) do nothing;
  return new;
end;
$$;

drop trigger if exists profiles_make_prefs on public.profiles;
create trigger profiles_make_prefs
  after insert on public.profiles
  for each row execute function public.profiles_make_prefs();

insert into public.notification_prefs (profile_id, contact_email, contact_email_verified_at)
select p.id,
       case when p.role = 'tutee' then nullif(lower(btrim(u.email)), '') end,
       case when p.role = 'tutee' and nullif(btrim(u.email), '') is not null then now() end
  from public.profiles p
  left join auth.users u on u.id = p.id
on conflict (profile_id) do nothing;

alter table public.notification_prefs enable row level security;
revoke all on public.notification_prefs from anon;

drop policy if exists notification_prefs_select on public.notification_prefs;
create policy notification_prefs_select on public.notification_prefs for select to authenticated
using (profile_id = auth.uid() or public.get_my_role() = 'admin');

drop policy if exists notification_prefs_update_own on public.notification_prefs;
create policy notification_prefs_update_own on public.notification_prefs for update to authenticated
using (profile_id = auth.uid())
with check (profile_id = auth.uid());

drop policy if exists notification_prefs_active_only on public.notification_prefs;
create policy notification_prefs_active_only on public.notification_prefs as restrictive for all to authenticated
using ((select public.am_active())) with check ((select public.am_active()));

-- The switches and the phone only. contact_email changes through the
-- notification-prefs function (a verification link) or an admin's update-user.
revoke insert, update, delete on public.notification_prefs from authenticated;
grant select on public.notification_prefs to authenticated;
grant update (phone, reminder_email, reminder_sms, reminder_lead_min) on public.notification_prefs to authenticated;

-- ---------------------------------------------------------------------------
-- session_reminders
-- ---------------------------------------------------------------------------

-- session_starts_at is the start time the row was queued for. A session moved
-- after its reminder went out is a different reminder, and the sessions
-- trigger below requeues it.
--
-- A group's tutor gets one reminder per occurrence, not one per tutee: their
-- row hangs off one member's session row, and moves to another member's if
-- that one is cancelled.
create table if not exists public.session_reminders (
  id                uuid primary key default gen_random_uuid(),
  session_id        uuid not null references public.sessions (id) on delete cascade,
  recipient_id      uuid not null references public.profiles (id) on delete cascade,
  channel           text not null check (channel in ('email', 'sms', 'push')),
  scheduled_for     timestamptz not null,
  session_starts_at timestamptz not null,
  sent_at           timestamptz,
  status            text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'skipped')),
  error             text,
  attempts          integer not null default 0,
  claimed_at        timestamptz,
  provider_id       text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (session_id, recipient_id, channel)
);

create index if not exists session_reminders_due_idx on public.session_reminders (scheduled_for) where status in ('pending', 'failed');
create index if not exists session_reminders_recipient_idx on public.session_reminders (recipient_id, scheduled_for);
create index if not exists session_reminders_updated_idx on public.session_reminders (updated_at desc);

drop trigger if exists session_reminders_touch on public.session_reminders;
create trigger session_reminders_touch
  before update on public.session_reminders
  for each row execute function public.touch_updated_at();

alter table public.session_reminders enable row level security;
revoke all on public.session_reminders from anon;

-- Everyone reads their own; admins read all and may delete. Nothing in the
-- browser inserts or updates: send-reminders writes with the service role,
-- and "Resend" goes through it.
drop policy if exists session_reminders_select on public.session_reminders;
create policy session_reminders_select on public.session_reminders for select to authenticated
using (recipient_id = auth.uid() or public.get_my_role() = 'admin');

drop policy if exists session_reminders_admin_delete on public.session_reminders;
create policy session_reminders_admin_delete on public.session_reminders for delete to authenticated
using (public.get_my_role() = 'admin');

drop policy if exists session_reminders_active_only on public.session_reminders;
create policy session_reminders_active_only on public.session_reminders as restrictive for all to authenticated
using ((select public.am_active())) with check ((select public.am_active()));

revoke insert, update on public.session_reminders from authenticated;
grant select, delete on public.session_reminders to authenticated;

-- ---------------------------------------------------------------------------
-- reminder_settings
-- ---------------------------------------------------------------------------

create table if not exists public.reminder_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.reminder_settings enable row level security;
revoke all on public.reminder_settings from anon;

drop policy if exists reminder_settings_admin_select on public.reminder_settings;
create policy reminder_settings_admin_select on public.reminder_settings for select to authenticated
using (public.get_my_role() = 'admin');

drop policy if exists reminder_settings_active_only on public.reminder_settings;
create policy reminder_settings_active_only on public.reminder_settings as restrictive for all to authenticated
using ((select public.am_active())) with check ((select public.am_active()));

revoke insert, update, delete on public.reminder_settings from authenticated;
grant select on public.reminder_settings to authenticated;

-- ---------------------------------------------------------------------------
-- Keeping queued reminders in step with their session
-- ---------------------------------------------------------------------------

-- SECURITY DEFINER because a tutor cancelling or moving a session has no
-- write access to session_reminders. Skip reasons for a session's own state
-- all start with "Session ", which is how reopening finds them again.
create or replace function public.sessions_reminders_sync()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  other uuid;
begin
  if new.status <> 'scheduled' and old.status = 'scheduled' then
    -- The group's tutor reminder moves to a tutee who is still coming.
    if new.group_id is not null then
      select id into other
        from public.sessions
       where group_id = new.group_id and id <> new.id and status = 'scheduled'
       order by id
       limit 1;
      if other is not null then
        update public.session_reminders
           set session_id = other
         where session_id = new.id and recipient_id = new.tutor_id;
      end if;
    end if;
    update public.session_reminders
       set status = 'skipped',
           error = case new.status when 'cancelled' then 'Session cancelled'
                                   when 'completed' then 'Session marked completed'
                                   else 'Session marked no-show' end,
           claimed_at = null
     where session_id = new.id and status in ('pending', 'failed');
  elsif new.status = 'scheduled' and old.status <> 'scheduled' and new.starts_at > now() then
    update public.session_reminders
       set status = 'pending', error = null, attempts = 0, claimed_at = null
     where session_id = new.id and status = 'skipped' and error like 'Session %';
  end if;

  if new.starts_at is distinct from old.starts_at and new.status = 'scheduled' and new.starts_at > now() then
    update public.session_reminders r
       set scheduled_for = new.starts_at - (r.session_starts_at - r.scheduled_for),
           session_starts_at = new.starts_at,
           status = 'pending', sent_at = null, error = null, attempts = 0, claimed_at = null, provider_id = null
     where r.session_id = new.id;
  end if;
  return null;
end;
$$;

drop trigger if exists sessions_reminders_sync on public.sessions;
create trigger sessions_reminders_sync
  after update of status, starts_at on public.sessions
  for each row execute function public.sessions_reminders_sync();

-- ---------------------------------------------------------------------------
-- What send-reminders calls (service role only)
-- ---------------------------------------------------------------------------

-- Queues a pending row for every scheduled session in the next 48 hours, for
-- its tutor (once per occurrence) and its tutee, on email always and on SMS
-- when the recipient turned it on. Whether a row is actually sent is decided
-- when it falls due, against the preferences at that moment, so turning email
-- off leaves a skipped row with the reason rather than nothing at all.
create or replace function public.reminders_sync(p_now timestamptz default now())
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  queued integer;
begin
  update public.session_reminders
     set status = 'skipped', error = 'Session started before the reminder went out', claimed_at = null
   where status in ('pending', 'failed') and session_starts_at <= p_now;

  with upcoming as (
    select s.*
      from public.sessions s
     where s.status = 'scheduled'
       and s.starts_at > p_now
       and s.starts_at <= p_now + interval '48 hours'
  ), tutor_rows as (
    select distinct on (u.tutor_id, coalesce(u.group_id, u.id))
           u.id as session_id, u.tutor_id as recipient_id, u.starts_at, coalesce(u.group_id, u.id) as occ
      from upcoming u
     order by u.tutor_id, coalesce(u.group_id, u.id), u.id
  ), wanted as (
    select * from tutor_rows
    union all
    select u.id, u.tutee_id, u.starts_at, coalesce(u.group_id, u.id) from upcoming u
  ), rows_in as (
    select w.session_id, w.recipient_id, c.channel, w.starts_at, w.occ,
           w.starts_at - make_interval(mins => coalesce(np.reminder_lead_min, 60)) as scheduled_for
      from wanted w
      join public.profiles p on p.id = w.recipient_id and p.active
      left join public.notification_prefs np on np.profile_id = w.recipient_id
     cross join lateral (
       select 'email'::text as channel
       union all
       select 'sms' where coalesce(np.reminder_sms, false)
     ) c
  )
  insert into public.session_reminders (session_id, recipient_id, channel, scheduled_for, session_starts_at, status)
  select r.session_id, r.recipient_id, r.channel, r.scheduled_for, r.starts_at, 'pending'
    from rows_in r
   where not exists (
     select 1
       from public.session_reminders x
       join public.sessions s2 on s2.id = x.session_id
      where x.recipient_id = r.recipient_id
        and x.channel = r.channel
        and x.session_id <> r.session_id
        and coalesce(s2.group_id, s2.id) = r.occ
   )
  on conflict (session_id, recipient_id, channel) do update
     set scheduled_for = excluded.scheduled_for
   where public.session_reminders.status = 'pending'
     and public.session_reminders.claimed_at is null
     and public.session_reminders.scheduled_for is distinct from excluded.scheduled_for;
  get diagnostics queued = row_count;
  return queued;
end;
$$;

-- Takes the rows that are due (up to five minutes early, so a five-minute
-- cadence never sends late) and stamps them claimed, so two overlapping runs
-- cannot both send one. A claim older than ten minutes is a run that died
-- part-way and is taken again; a failed row is retried up to three attempts.
create or replace function public.reminders_claim(p_now timestamptz default now(), p_limit integer default 100)
returns setof public.session_reminders
language sql
security definer
set search_path = public
as $$
  update public.session_reminders r
     set claimed_at = p_now, attempts = r.attempts + 1
   where r.id in (
     select id
       from public.session_reminders
      where (status = 'pending' or (status = 'failed' and attempts < 3))
        and scheduled_for <= p_now + interval '5 minutes'
        and session_starts_at > p_now
        and (claimed_at is null or claimed_at < p_now - interval '10 minutes')
      order by scheduled_for
      limit p_limit
      for update skip locked
   )
  returning r.*;
$$;

revoke execute on function public.reminders_sync(timestamptz) from public, anon, authenticated;
revoke execute on function public.reminders_claim(timestamptz, integer) from public, anon, authenticated;
grant execute on function public.reminders_sync(timestamptz) to service_role;
grant execute on function public.reminders_claim(timestamptz, integer) to service_role;

-- ---------------------------------------------------------------------------
-- Scheduling: pg_cron → pg_net → send-reminders, every five minutes
-- ---------------------------------------------------------------------------

-- The fallback, if pg_cron is not available, is .github/workflows/reminders.yml.
-- Use one or the other: both at once only doubles the calls (the claim step
-- keeps it from doubling the mail). To stop this one:
--   select cron.unschedule('send-reminders');
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

-- cron.schedule with an existing job name replaces that job, so this is safe
-- to re-run.
select cron.schedule(
  'send-reminders',
  '*/5 * * * *',
  $cron$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/send-reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
    ),
    body := jsonb_build_object('source', 'pg_cron'),
    timeout_milliseconds := 30000
  );
  $cron$
);
