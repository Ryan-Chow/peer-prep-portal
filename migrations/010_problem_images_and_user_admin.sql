-- Peer Prep Academy — migration 010: images on problems, and editing,
-- deactivating and deleting users.
--
-- Run once in the SQL editor, after 009_sessions_calendar.sql. Safe to re-run.
--
--   * problems.image_url / image_alt / image_position / choice_images: a figure
--     for the question, and optionally one per choice, as links.
--   * storage bucket problem-images: where "Save a copy" and "Upload file" put
--     an image, so a hot-linked figure cannot disappear later.
--   * profiles.active: deactivating keeps every row and shuts the account out.
--   * session_logs.tutor_name: who wrote the sheet, kept after the tutor's
--     account is deleted.
--   * profiles: a tutor may change their own display name and nothing else.
--   * user_delete_counts(): what deleting an account takes with it.

-- ---------------------------------------------------------------------------
-- Image columns
-- ---------------------------------------------------------------------------

alter table public.problems add column if not exists image_url      text;
alter table public.problems add column if not exists image_alt      text;
alter table public.problems add column if not exists image_position text not null default 'above';
alter table public.problems add column if not exists choice_images  jsonb;

-- A plain https link and nothing else. The app renders it only as the src of
-- an <img>, never as markup, but a quote or angle bracket in here has no
-- business in a URL and would be the first step of anything that did.
-- Mirrors cleanImageUrl() in importer.js.
create or replace function public.is_image_url(p_url text)
returns boolean
language sql
immutable
as $$
  select p_url ~ '^https://[^\s"''<>\\]+$' and char_length(p_url) <= 2048
$$;

-- Exactly four entries, A to D, each a URL or null. Four because the answer is
-- stored as a letter and the choice buttons are built around A–D throughout.
create or replace function public.valid_choice_images(p_images jsonb)
returns boolean
language sql
immutable
as $$
  select jsonb_typeof(p_images) = 'array'
     and jsonb_array_length(p_images) = 4
     and not exists (
       select 1
         from jsonb_array_elements(p_images) as e(v)
        where not (jsonb_typeof(e.v) = 'null'
                   or (jsonb_typeof(e.v) = 'string' and public.is_image_url(e.v #>> '{}')))
     )
$$;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'problems_image_url_check') then
    alter table public.problems add constraint problems_image_url_check
      check (image_url is null or public.is_image_url(image_url));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'problems_image_position_check') then
    alter table public.problems add constraint problems_image_position_check
      check (image_position in ('above', 'below'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'problems_choice_images_check') then
    alter table public.problems add constraint problems_choice_images_check
      check (choice_images is null or public.valid_choice_images(choice_images));
  end if;
end;
$$;

-- A figure attached to the question answers the complaint that flagged it, so
-- the rescan button leaves those rows alone. 007's body otherwise unchanged.
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
     and p.image_url is null
     and public.missing_figure_reason(p.question) is not null;
  get diagnostics hits = row_count;

  return hits;
end $$;

-- ---------------------------------------------------------------------------
-- profiles.active
-- ---------------------------------------------------------------------------

alter table public.profiles add column if not exists active boolean not null default true;

-- False for a deactivated account, and for a caller with no profile at all.
create or replace function public.am_active()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select active from public.profiles where id = auth.uid()), false);
$$;

revoke execute on function public.am_active() from public, anon;
grant execute on function public.am_active() to authenticated;

-- One RESTRICTIVE policy per table, ANDed with every permissive policy already
-- there. Deactivation also bans the account in auth (update-user does that),
-- which stops it signing in or refreshing; this is what stops the access token
-- it already holds from reading anything in the hour before that token
-- expires. Rewriting every permissive policy to add the same test would be the
-- same rule in thirty places.
--
-- (select …) so Postgres evaluates the function once per statement rather than
-- once per row.
do $$
declare
  t text;
begin
  foreach t in array array[
    'tutor_tutees', 'modules', 'problems', 'assignments', 'submissions',
    'error_log_entries', 'student_profiles', 'session_logs', 'sessions',
    'tutor_availability'
  ] loop
    execute format('drop policy if exists %I on public.%I', t || '_active_only', t);
    execute format(
      'create policy %I on public.%I as restrictive for all to authenticated '
      'using ((select public.am_active())) with check ((select public.am_active()))',
      t || '_active_only', t);
  end loop;
end;
$$;

-- profiles keeps the caller's own row readable, so the app can tell a
-- deactivated person why it is signing them out instead of claiming they have
-- no profile.
drop policy if exists profiles_active_only on public.profiles;
create policy profiles_active_only on public.profiles as restrictive for all to authenticated
using ((select public.am_active()) or id = auth.uid())
with check ((select public.am_active()));

-- ---------------------------------------------------------------------------
-- Self-service: a tutor's display name, nothing more
-- ---------------------------------------------------------------------------

-- schema.sql let anyone update every column of their own row, role aside —
-- username, email, and now active. Narrowed to tutors, and below to the one
-- column. Admins change the rest through the update-user Edge Function, which
-- writes with the service role and so needs no grant here.
drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles for update to authenticated
using (id = auth.uid() and public.get_my_role() = 'tutor')
with check (id = auth.uid() and role = public.get_my_role());

revoke update on public.profiles from authenticated;
grant update (display_name) on public.profiles to authenticated;

-- ---------------------------------------------------------------------------
-- Views: the image columns, and the active check
-- ---------------------------------------------------------------------------

-- The views read their base tables as owner, so the restrictive policies above
-- do not reach them; each WHERE clause states the check itself. Columns are
-- appended, because CREATE OR REPLACE VIEW can only add at the end.
create or replace view public.problems_public as
select p.id, p.module_id, p.question, p.type, p.choices, p.sort_order, p.tags,
       p.image_url, p.image_alt, p.image_position, p.choice_images
from public.problems p
where (select public.am_active())
  and (public.get_my_role() in ('admin', 'tutor')
       or public.is_assigned_problem(p.id, p.module_id));

revoke all on public.problems_public from public, anon;
grant select on public.problems_public to authenticated;

create or replace view public.revealed_answers as
select p.id, p.module_id, p.answer, p.explanation
from public.problems p
join public.submissions s
  on s.problem_id = p.id
 and s.tutee_id = auth.uid()
where (select public.am_active());

revoke all on public.revealed_answers from public, anon;
grant select on public.revealed_answers to authenticated;

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
  s.is_correct,
  p.image_url,
  p.image_alt,
  p.image_position,
  p.choice_images
from public.error_log_entries e
join public.problems p on p.id = e.problem_id
join public.modules  m on m.id = p.module_id
left join public.submissions s
       on s.tutee_id = e.tutee_id
      and s.problem_id = e.problem_id
where (select public.am_active())
  and (e.tutee_id = auth.uid()
       or public.get_my_role() = 'admin'
       or (public.get_my_role() = 'tutor' and public.is_my_tutee(e.tutee_id)));

revoke all on public.error_log_view from public, anon;
grant select on public.error_log_view to authenticated;

-- ---------------------------------------------------------------------------
-- RPCs: the active check
-- ---------------------------------------------------------------------------

-- SECURITY DEFINER bypasses RLS, restrictive policies included, so each
-- tutee-callable function says it again. Bodies are otherwise 003's and 002's.

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
  if not public.am_active() then
    raise exception 'account deactivated';
  end if;

  select * into prob from public.problems where id = p_problem_id;
  if not found then
    raise exception 'unknown problem';
  end if;

  if public.get_my_role() is distinct from 'tutee'
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
  if not public.am_active() then
    raise exception 'account deactivated';
  end if;
  if public.get_my_role() is distinct from 'tutee' then
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
  if not public.am_active() then
    raise exception 'account deactivated';
  end if;

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
-- session_logs.tutor_name
-- ---------------------------------------------------------------------------

-- tutor_id has been ON DELETE SET NULL since 005, so deleting a tutor keeps
-- their sheets — but until now with nobody's name on them. The name is
-- refreshed whenever the row is written with a tutor attached, and left alone
-- when the cascade nulls tutor_id, which is the moment it is needed.
-- delete-user refreshes it once more just before the delete, so a tutor
-- renamed since their last sheet leaves their current name behind.
alter table public.session_logs add column if not exists tutor_name text;

create or replace function public.session_logs_snapshot_tutor()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.tutor_id is not null then
    select coalesce(display_name, username, email) into new.tutor_name
      from public.profiles where id = new.tutor_id;
  elsif tg_op = 'UPDATE' then
    new.tutor_name := coalesce(new.tutor_name, old.tutor_name);
  end if;
  return new;
end;
$$;

drop trigger if exists session_logs_snapshot_tutor on public.session_logs;
create trigger session_logs_snapshot_tutor
  before insert or update on public.session_logs
  for each row execute function public.session_logs_snapshot_tutor();

update public.session_logs l
   set tutor_name = coalesce(p.display_name, p.username, p.email)
  from public.profiles p
 where p.id = l.tutor_id
   and l.tutor_name is distinct from coalesce(p.display_name, p.username, p.email);

-- ---------------------------------------------------------------------------
-- What deleting an account takes with it
-- ---------------------------------------------------------------------------

-- Counted server-side, like module_delete_counts(), and returns no rows to a
-- non-admin. Every foreign key to profiles cascades except three, which are
-- reported as kept: assignments.assigned_by and sessions.created_by are SET
-- NULL, and session_logs.tutor_id is SET NULL with the name kept above.
create or replace function public.user_delete_counts(p_user uuid)
returns table (
  assignments bigint, assignments_made bigint, submissions bigint,
  error_log_entries bigint, session_logs_deleted bigint, session_logs_kept bigint,
  sessions bigint, links bigint, availability bigint, student_profile bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select
    (select count(*) from public.assignments where tutee_id = p_user),
    (select count(*) from public.assignments where assigned_by = p_user and tutee_id <> p_user),
    (select count(*) from public.submissions where tutee_id = p_user),
    (select count(*) from public.error_log_entries where tutee_id = p_user),
    (select count(*) from public.session_logs where tutee_id = p_user),
    (select count(*) from public.session_logs where tutor_id = p_user and tutee_id <> p_user),
    (select count(*) from public.sessions where tutor_id = p_user or tutee_id = p_user),
    (select count(*) from public.tutor_tutees where tutor_id = p_user or tutee_id = p_user),
    (select count(*) from public.tutor_availability where tutor_id = p_user),
    (select count(*) from public.student_profiles where tutee_id = p_user)
  where public.get_my_role() = 'admin' and public.am_active();
$$;

revoke execute on function public.user_delete_counts(uuid) from public, anon;
grant execute on function public.user_delete_counts(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Storage: problem-images
-- ---------------------------------------------------------------------------

-- Public read: a tutee's browser loads these as plain <img> URLs, and a public
-- bucket serves its objects without a token. SVG is left off the list on
-- purpose — opened directly rather than through an <img>, an SVG runs its
-- scripts in the storage origin.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('problem-images', 'problem-images', true, 10485760,
        array['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
on conflict (id) do update
  set public = true,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Writes are admins only, from the browser's "Upload file". cache-image and the
-- CLI write with the service role and need no policy.
drop policy if exists problem_images_admin_insert on storage.objects;
create policy problem_images_admin_insert on storage.objects for insert to authenticated
with check (bucket_id = 'problem-images' and public.get_my_role() = 'admin' and public.am_active());

drop policy if exists problem_images_admin_update on storage.objects;
create policy problem_images_admin_update on storage.objects for update to authenticated
using (bucket_id = 'problem-images' and public.get_my_role() = 'admin' and public.am_active())
with check (bucket_id = 'problem-images' and public.get_my_role() = 'admin' and public.am_active());

drop policy if exists problem_images_admin_delete on storage.objects;
create policy problem_images_admin_delete on storage.objects for delete to authenticated
using (bucket_id = 'problem-images' and public.get_my_role() = 'admin' and public.am_active());
