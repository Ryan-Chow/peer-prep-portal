// notification-prefs — a signed-in person changing where reminders go.
//
//   { action: 'request_verification', email }  emails a link to that address;
//                                              it becomes the contact email
//                                              only once the link is used
//   { action: 'cancel_pending' }               forgets an unconfirmed address
//
// The switches, the lead time and the phone are written straight to
// notification_prefs from the browser (column grants in 013); only the
// address needs this, because reminders must never go to an inbox nobody
// proved they own.
//
// Deploy:  supabase functions deploy notification-prefs
// Secrets: RESEND_API_KEY, REMINDER_SIGNING_SECRET, PORTAL_URL, ALLOWED_ORIGIN

import { cors, json } from '../_shared/admin.ts';
import { actionLink, esc, isEmail, isSyntheticEmail, PORTAL_URL, sendEmail, serviceClient, signToken } from '../_shared/reminders.ts';

const DAY = 24 * 3600;

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
  const admin = serviceClient();
  if (!admin) return json({ error: 'Function is not configured.' }, 500);

  const bearer = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!bearer) return json({ error: 'Missing bearer token.' }, 401);
  const { data: caller, error: callerErr } = await admin.auth.getUser(bearer);
  if (callerErr || !caller?.user) return json({ error: 'Invalid or expired session.' }, 401);
  const { data: me } = await admin.from('profiles').select('id, display_name, username, active').eq('id', caller.user.id).maybeSingle();
  if (!me || me.active === false) return json({ error: 'This account is deactivated.' }, 403);

  let body: { action?: unknown; email?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Expected a JSON body.' }, 400);
  }

  const { data: prefs } = await admin.from('notification_prefs').select('*').eq('profile_id', me.id).maybeSingle();
  if (!prefs) return json({ error: 'Your notification settings are missing. Ask an admin to run migration 013.' }, 500);

  if (body.action === 'cancel_pending') {
    const { error } = await admin.from('notification_prefs').update({ pending_email: null, pending_email_sent_at: null }).eq('profile_id', me.id);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  if (body.action !== 'request_verification') return json({ error: 'Unknown action.' }, 400);
  const email = String(body.email ?? '').trim().toLowerCase();
  if (!isEmail(email)) return json({ error: 'Enter a valid email address.' }, 400);
  if (isSyntheticEmail(email)) return json({ error: 'That is your sign-in username, not an inbox. Use an address you read.' }, 400);
  if (email === prefs.contact_email && prefs.contact_email_verified_at) return json({ error: 'That address is already confirmed.' }, 409);
  if (prefs.pending_email_sent_at && Date.now() - Date.parse(prefs.pending_email_sent_at) < 60000) {
    return json({ error: 'A link was sent less than a minute ago. Check your inbox, or try again shortly.' }, 429);
  }

  const token = await signToken({ a: 'verify', p: me.id, m: email, e: Math.floor(Date.now() / 1000) + DAY });
  if (!token) return json({ error: 'Verification is not configured: REMINDER_SIGNING_SECRET is not set.' }, 500);
  const link = actionLink(token);
  const name = me.display_name || me.username || 'there';
  const res = await sendEmail(
    email,
    'Confirm your email for Peer Prep reminders',
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#1a1a1a;max-width:520px">' +
      '<p>Hi ' + esc(name) + ',</p><p>Confirm that session reminders from Peer Prep Academy should come to this address.</p>' +
      '<p><a href="' + esc(link) + '" style="display:inline-block;padding:10px 16px;background:#1b4a80;color:#fff;text-decoration:none;border-radius:4px">Confirm this address</a></p>' +
      '<p style="font-size:12px;color:#666">The link works for 24 hours. If you did not ask for this, ignore it and nothing changes.</p>' +
      '<p style="font-size:12px;color:#666">' + esc(PORTAL_URL) + '</p></div>',
    'Hi ' + name + ',\n\nConfirm that session reminders from Peer Prep Academy should come to this address:\n' + link +
      '\n\nThe link works for 24 hours. If you did not ask for this, ignore it and nothing changes.',
  );
  if (!res.ok) return json({ error: res.error ?? 'Could not send the email.' }, 502);

  const { error } = await admin.from('notification_prefs')
    .update({ pending_email: email, pending_email_sent_at: new Date().toISOString() })
    .eq('profile_id', me.id);
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true, pending_email: email });
});
