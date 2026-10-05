// delete-user — admin-only permanent deletion of an account.
//
// Deleting the auth user deletes the profile (profiles.id cascades from
// auth.users), and every foreign key to profiles takes it from there: their
// assignments, submissions, error log, intake sheet, calendar sessions,
// availability and tutor links all go. Three references are SET NULL instead
// and survive: assignments.assigned_by, sessions.created_by, and
// session_logs.tutor_id, whose tutor_name is refreshed below first so a
// deleted tutor's sheets still say who wrote them.
//
// The caller has to send the account's display name back as confirm_name.
// The dialog already asks for it to be typed; checking it here as well means a
// stray request with only an id cannot delete anybody.
//
// Deploy:  supabase functions deploy delete-user
// Secrets: ALLOWED_ORIGIN  (SUPABASE_* are injected)

import { json, loadTarget, requireAdmin } from '../_shared/admin.ts';

Deno.serve(async (req: Request): Promise<Response> => {
  const call = await requireAdmin(req);
  if (call instanceof Response) return call;
  const { admin, callerId, body } = call;

  const target = await loadTarget(admin, callerId, body.user_id);
  if (target instanceof Response) return target;

  const name = (target.display_name ?? target.username ?? target.email ?? '').trim();
  const typed = String(body.confirm_name ?? '').trim();
  if (!name || typed.toLowerCase() !== name.toLowerCase()) {
    return json({ error: 'Type the account’s name exactly to delete it.' }, 400);
  }

  if (target.role === 'tutor') {
    const snap = await admin.from('session_logs').update({ tutor_name: name }).eq('tutor_id', target.id);
    if (snap.error) return json({ error: 'Could not keep the tutor’s name on their session logs: ' + snap.error.message }, 500);
  }

  const { error } = await admin.auth.admin.deleteUser(target.id);
  if (error) return json({ error: error.message ?? 'Could not delete the account.' }, 400);

  return json({ id: target.id, deleted: true }, 200);
});
