-- Peer Prep Academy — migration 001: bulk import support.
--
-- Run once in the SQL editor, after schema.sql. Safe to re-run.
--
-- Adds the three columns the JSON importer needs to be idempotent:
--   modules.slug      stable handle derived from the title, so a re-import
--                     finds the module it created last time instead of making
--                     a second one with the same name.
--   problems.source_id  external identity (a College Board number, your own
--                     key) used to match an incoming problem to a stored row.
--   problems.tags     free-form labels, carried through for later filtering.

-- ---------------------------------------------------------------------------
-- modules.slug
-- ---------------------------------------------------------------------------

alter table public.modules add column if not exists slug text;

-- Backfilled so the importer adopts modules that predate it instead of making
-- a second copy the first time their title is imported. Mirrors slugify() in
-- importer.js: lowercase, non-alphanumerics to hyphens, collapsed, trimmed.
update public.modules
   set slug = trim(both '-' from regexp_replace(lower(title), '[^a-z0-9]+', '-', 'g'))
 where slug is null;

-- Two pre-existing modules can share a title. Keep the oldest on the clean
-- slug and suffix the rest so the unique index below can be created.
with dupes as (
  select id,
         slug,
         row_number() over (partition by slug order by created_at, id) as n
    from public.modules
   where slug is not null
)
update public.modules m
   set slug = m.slug || '-' || d.n
  from dupes d
 where d.id = m.id
   and d.n > 1;

create unique index if not exists modules_slug_key
  on public.modules (slug)
  where slug is not null;

-- Modules made through the admin form carry no slug of their own, and one
-- that stayed NULL would be invisible to the importer's lookup — it would
-- create a second module with the same title. Filling it here covers every
-- insert path at once.
--
-- Only on INSERT, and on an UPDATE that explicitly blanks it: renaming a
-- module keeps its original slug, so a file that has been imported before
-- goes on matching the same row.
create or replace function public.modules_set_slug()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.slug is null or btrim(new.slug) = '' then
    new.slug := trim(both '-' from regexp_replace(lower(new.title), '[^a-z0-9]+', '-', 'g'));
  end if;
  if new.slug = '' then
    new.slug := null;
  end if;
  return new;
end;
$$;

drop trigger if exists modules_set_slug on public.modules;
create trigger modules_set_slug
before insert or update of title, slug on public.modules
for each row execute function public.modules_set_slug();

-- ---------------------------------------------------------------------------
-- problems.source_id and problems.tags
-- ---------------------------------------------------------------------------

alter table public.problems add column if not exists source_id text;
alter table public.problems add column if not exists tags      text[];

-- Partial: most problems are typed into the editor and have no external id,
-- and NULLs would otherwise be the only thing this index stored.
--
-- Note this is global, not per-module: a source_id names one problem across
-- the whole library. The importer therefore refuses to copy a problem into a
-- second module under an id another module already claims, rather than
-- letting the insert fail mid-batch.
create unique index if not exists problems_source_id_key
  on public.problems (source_id)
  where source_id is not null;

create index if not exists problems_tags_idx on public.problems using gin (tags);

-- ---------------------------------------------------------------------------
-- Tutee-facing view
-- ---------------------------------------------------------------------------

-- problems_public is a fixed column list, so it does not pick the new columns
-- up on its own. tags are safe to expose (they describe the problem, not the
-- key); source_id is not exposed — it is an internal handle and publishing it
-- invites guessing at a public question bank.
--
-- tags is appended rather than slotted in beside choices: CREATE OR REPLACE
-- VIEW may only add columns at the end, and renaming sort_order to tags is
-- how Postgres would read anything else.
create or replace view public.problems_public as
select p.id, p.module_id, p.question, p.type, p.choices, p.sort_order, p.tags
from public.problems p
where public.get_my_role() in ('admin', 'tutor')
   or public.is_assigned_module(p.module_id);

revoke all on public.problems_public from public, anon;
grant select on public.problems_public to authenticated;
