-- Peer Prep Academy — migration 008: session logs are staff-only.
--
-- Run once in the SQL editor, after 007_missing_figures.sql. Safe to re-run.
--
-- 005 let a tutee read their own logs, and the app gave them a My Sessions
-- screen showing every submitted sheet. That is the wrong audience: the log is
-- the tutor's write-up for the tutor and the coordinator, and a tutor who
-- knows their tutee is reading it writes a different, more careful, less
-- useful sheet.
--
-- The screen is gone from the app, but that alone hides nothing — the rows
-- were still readable straight from PostgREST with the tutee's own token. The
-- read has to be taken away here, which is the only place it counts.
--
-- Only the SELECT policy changes. The tutor and admin branches are unchanged,
-- and there was never a tutee write policy of any kind to remove.

drop policy if exists session_logs_select on public.session_logs;
create policy session_logs_select on public.session_logs for select to authenticated
using (
  public.get_my_role() = 'admin'
  -- `or tutor_id = auth.uid()` is not redundant with is_my_tutee(): reassigning
  -- a tutee to another tutor would otherwise blank out every log the previous
  -- tutor wrote, including from their own Session Logs screen.
  or (public.get_my_role() = 'tutor' and (public.is_my_tutee(tutee_id) or tutor_id = auth.uid()))
);
