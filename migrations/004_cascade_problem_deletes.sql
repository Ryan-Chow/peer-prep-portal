-- Peer Prep Academy — migration 004: make deletes cascade down from a module.
--
-- Run once in the SQL editor, after 003_filtered_assignments.sql. Safe to
-- re-run.
--
-- Deleting a module was leaving its problems behind with a module_id pointing
-- at nothing. Orphans are invisible in the app — every screen reaches problems
-- through a module — but they are not invisible to the importer, which matches
-- source_id library-wide and reports a re-import of the deleted module as
-- "already belongs to another module", refusing to write rows it cannot see.
--
-- schema.sql has declared `on delete cascade` on problems.module_id since the
-- beginning, so a project built from it is already correct and this migration
-- changes nothing. A project whose tables drifted — built by hand, or restored,
-- or edited through the dashboard — is what this is for. It states the intended
-- shape rather than assuming the current one.

-- ---------------------------------------------------------------------------
-- Rows already orphaned
-- ---------------------------------------------------------------------------

-- The foreign keys below are validated against existing rows when they are
-- added, so anything already dangling has to go first or the ALTER fails.
--
-- Deleting these loses nothing that was reachable: a problem with no module
-- cannot be rendered, assigned or answered, and a submission or error log
-- entry pointing at a problem that is gone has nothing left to show. Parents
-- first, then children, so the children list includes what this block just
-- removed.
do $$
declare
  gone_problems integer;
  gone_subs     integer;
  gone_entries  integer;
begin
  delete from public.problems p
   where not exists (select 1 from public.modules m where m.id = p.module_id);
  get diagnostics gone_problems = row_count;

  delete from public.submissions s
   where not exists (select 1 from public.problems p where p.id = s.problem_id);
  get diagnostics gone_subs = row_count;

  delete from public.error_log_entries e
   where not exists (select 1 from public.problems p where p.id = e.problem_id);
  get diagnostics gone_entries = row_count;

  raise notice 'cleared % orphaned problem(s), % submission(s), % error log entry(ies)',
    gone_problems, gone_subs, gone_entries;
end $$;

-- ---------------------------------------------------------------------------
-- Foreign keys
-- ---------------------------------------------------------------------------

-- Restate each key with the delete action it should have had. The existing
-- constraint is found by the column it covers rather than by name: a key added
-- by hand or through the dashboard will not be called what schema.sql would
-- have called it, and dropping the wrong name — or none — would leave a
-- duplicate behind.
--
-- error_log_entries.submission_id is deliberately absent from this list. It is
-- `on delete set null`, and must stay that way: clearing a submission must not
-- take the tutee's note with it, and the answer it describes is looked up by
-- (tutee, problem) regardless.
do $$
declare
  spec record;
  con  text;
begin
  for spec in
    select * from (values
      ('problems',          'module_id',  'modules',  'problems_module_id_fkey'),
      ('submissions',       'problem_id', 'problems', 'submissions_problem_id_fkey'),
      ('error_log_entries', 'problem_id', 'problems', 'error_log_entries_problem_id_fkey')
    ) as t(child, col, parent, want)
  loop
    for con in
      select c.conname
        from pg_constraint c
       where c.conrelid = ('public.' || spec.child)::regclass
         and c.contype = 'f'
         and c.conkey = array[
               (select attnum from pg_attribute
                 where attrelid = ('public.' || spec.child)::regclass
                   and attname = spec.col)
             ]::smallint[]
    loop
      execute format('alter table public.%I drop constraint %I', spec.child, con);
    end loop;

    execute format(
      'alter table public.%I add constraint %I foreign key (%I) references public.%I (id) on delete cascade',
      spec.child, spec.want, spec.col, spec.parent);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- What a delete now reaches
-- ---------------------------------------------------------------------------

-- Deleting a module removes its problems, and through them every submission
-- and error log entry against those problems, plus the assignments of that
-- module (assignments.module_id has cascaded since schema.sql).
--
-- assignments.problem_ids is the one reference that cannot cascade: it is a
-- uuid[], and an array element cannot carry a foreign key. It does not need to.
-- The client reads it as a filter over the module's problems, so an id whose
-- problem is gone simply selects nothing and the assignment shrinks by one.
-- Nothing dangles, and progress stays a fraction of what is actually there.

-- Confirmation, printed by the SQL editor. Every row should read `cascade`
-- except error_log_entries.submission_id, which should read `set null`.
select c.conrelid::regclass  as child_table,
       a.attname             as column_name,
       c.confrelid::regclass  as parent_table,
       case c.confdeltype
         when 'c' then 'cascade'
         when 'n' then 'set null'
         when 'a' then 'no action'
         when 'r' then 'restrict'
         when 'd' then 'set default'
       end                   as on_delete
  from pg_constraint c
  join pg_attribute  a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
 where c.contype = 'f'
   and c.conrelid in ('public.problems'::regclass,
                      'public.submissions'::regclass,
                      'public.error_log_entries'::regclass)
 order by 1, 2;
