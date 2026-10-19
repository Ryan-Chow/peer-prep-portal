// session-action — what a signed link in an email does.
//
// The link opens the portal (#action=<token>), which posts the token here
// twice: once without `confirm` to say what the link is for, and again with
// confirm: true when the person presses the button. Nothing happens on the
// first call, so a mail scanner that follows every link changes nothing.
//
//   complete  a tutor's "Mark completed": the session (every tutee of a
//             group still scheduled), once it has started
//   verify    "Confirm this address": the pending contact email becomes the
//             one reminders use
//
// No sign-in: the token is the authority, and it is narrow and short-lived.
//
// Deploy:  supabase functions deploy session-action --no-verify-jwt
// Secrets: REMINDER_SIGNING_SECRET (same value as send-reminders), ALLOWED_ORIGIN

import { cors, json } from '../_shared/admin.ts';
import { fmtDay, fmtTime, serviceClient, verifyToken } from '../_shared/reminders.ts';

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
  const admin = serviceClient();
  if (!admin) return json({ error: 'Function is not configured.' }, 500);

  let body: { token?: unknown; confirm?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Expected a JSON body.' }, 400);
  }
  const token = typeof body.token === 'string' ? body.token.trim() : '';
  const confirm = body.confirm === true;
  const p = token ? await verifyToken(token) : null;
  if (p === 'expired') return json({ error: 'This link has expired.' }, 410);
  if (!p) return json({ error: 'This link is not valid.' }, 400);

  if (p.a === 'complete') {
    const { data: s } = await admin.from('sessions').select('id, tutor_id, tutee_id, starts_at, status, group_id').eq('id', p.s).maybeSingle();
    if (!s || s.tutor_id !== p.r) return json({ error: 'That session is no longer on the calendar.' }, 404);
    const { data: tutor } = await admin.from('profiles').select('active').eq('id', p.r).maybeSingle();
    if (!tutor || tutor.active === false) return json({ error: 'This account is deactivated.' }, 403);

    const { data: rows } = s.group_id
      ? await admin.from('sessions').select('id, tutee_id, status').eq('group_id', s.group_id)
      : { data: [{ id: s.id, tutee_id: s.tutee_id, status: s.status }] };
    const members = (rows ?? []) as { id: string; tutee_id: string; status: string }[];
    const { data: names } = await admin.from('profiles').select('id, display_name, username').in('id', members.map((m) => m.tutee_id));
    const nameOf = (id: string) => { const n = (names ?? []).find((x) => x.id === id); return (n && (n.display_name || n.username)) || 'a tutee'; };
    const open = members.filter((m) => m.status === 'scheduled');
    const what = (members.length > 1 ? 'Group session with ' + members.map((m) => nameOf(m.tutee_id)).join(', ') : 'Session with ' + nameOf(s.tutee_id)) +
      ', ' + fmtDay(s.starts_at) + ' at ' + fmtTime(s.starts_at);
    const started = Date.parse(s.starts_at) <= Date.now();
    const state = !open.length ? 'done' : started ? 'ready' : 'early';

    if (!confirm) {
      const message = state === 'done' ? 'Already marked \u2014 nothing left to do.'
        : state === 'early' ? 'This works once the session has started, at ' + fmtTime(s.starts_at) + '. Open the link again then.' : undefined;
      return json({ kind: 'complete', what, state, label: 'Mark completed', message });
    }
    if (state === 'done') return json({ kind: 'complete', what, state, message: 'Already marked — nothing left to do.' });
    if (state === 'early') return json({ error: 'This session has not started yet. The link works from ' + fmtTime(s.starts_at) + '.' }, 409);
    const { error } = await admin.from('sessions').update({ status: 'completed' }).in('id', open.map((m) => m.id)).eq('status', 'scheduled');
    if (error) return json({ error: 'Could not mark it completed: ' + error.message }, 500);
    return json({ kind: 'complete', what, state: 'done', message: open.length > 1 ? 'Marked completed for all ' + open.length + ' tutees.' : 'Marked completed.' });
  }

  if (p.a === 'verify') {
    const { data: prefs } = await admin.from('notification_prefs').select('contact_email, contact_email_verified_at, pending_email').eq('profile_id', p.p).maybeSingle();
    const { data: who } = await admin.from('profiles').select('active').eq('id', p.p).maybeSingle();
    if (!prefs || !who || who.active === false) return json({ error: 'That account is not available.' }, 404);
    const what = 'Use ' + p.m + ' for session reminders';
    const already = prefs.contact_email === p.m && !!prefs.contact_email_verified_at;
    if (already) return json({ kind: 'verify', what, state: 'done', message: 'That address is already confirmed.' });
    if (prefs.pending_email !== p.m) return json({ error: 'This link is out of date: a different address was asked for since. Use the newest email.' }, 409);
    if (!confirm) return json({ kind: 'verify', what, state: 'ready', label: 'Confirm this address' });
    const { error } = await admin.from('notification_prefs').update({
      contact_email: p.m, contact_email_verified_at: new Date().toISOString(), pending_email: null, pending_email_sent_at: null,
    }).eq('profile_id', p.p).eq('pending_email', p.m);
    if (error) return json({ error: 'Could not confirm it: ' + error.message }, 500);
    return json({ kind: 'verify', what, state: 'done', message: 'Confirmed. Reminders will go to ' + p.m + '.' });
  }

  return json({ error: 'This link is not valid.' }, 400);
});
