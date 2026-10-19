// send-reminders — queues and sends session reminders.
//
// Called three ways:
//   * by the scheduler every five minutes (pg_cron with the secret key as the
//     bearer, or the GitHub Actions fallback with x-cron-secret): queue the
//     next 48 hours, send whatever is due, record the run;
//   * by an admin: { action: 'run' } does the same now, { action: 'resend',
//     reminder_id } sends one row again;
//   * by anyone signed in: { action: 'test' } sends the caller a sample on
//     the channels they have turned on, and writes no reminder row.
//
// Deploy:  supabase functions deploy send-reminders --no-verify-jwt
//          (a secret key is not a JWT, so the gateway check has to be off;
//          this function checks every caller itself)
// Secrets: RESEND_API_KEY, REMINDER_SIGNING_SECRET, CRON_SECRET (fallback
//          only), TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM
//          (optional), PORTAL_URL, REMINDER_TIMEZONE, ALLOWED_ORIGIN

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { cors, json } from '../_shared/admin.ts';
import {
  actionLink, isE164, isSyntheticEmail, PORTAL_URL, renderReminder, sameSecret, secretKeys, sendEmail,
  serviceClient, signToken, smsProvider,
} from '../_shared/reminders.ts';

interface Reminder {
  id: string;
  session_id: string;
  recipient_id: string;
  channel: 'email' | 'sms' | 'push';
  scheduled_for: string;
  session_starts_at: string;
  attempts: number;
}
interface Session {
  id: string; tutor_id: string; tutee_id: string; starts_at: string; ends_at: string;
  location: string | null; status: string; group_id: string | null;
}
interface Person { id: string; display_name: string | null; username: string | null; role: string; active: boolean }
interface Prefs {
  profile_id: string; contact_email: string | null; contact_email_verified_at: string | null; phone: string | null;
  reminder_email: boolean; reminder_sms: boolean; reminder_lead_min: number; last_test_at: string | null;
}
interface Outcome { status: 'sent' | 'failed' | 'skipped'; error: string | null; provider_id?: string | null }

const DEFAULT_PREFS = { reminder_email: true, reminder_sms: false, reminder_lead_min: 60 };
const nameOf = (p?: Person) => (p && (p.display_name || p.username)) || 'there';
const SIX_HOURS = 6 * 3600;

// ---- one row ---------------------------------------------------------------

async function deliverOne(r: Reminder, s: Session | undefined, members: Session[], people: Map<string, Person>, prefsOf: Map<string, Prefs>, now: Date): Promise<Outcome> {
  const skip = (error: string): Outcome => ({ status: 'skipped', error });
  if (!s) return skip('Session deleted');
  if (s.status !== 'scheduled') return skip(s.status === 'cancelled' ? 'Session cancelled' : 'Session no longer scheduled');
  if (Date.parse(s.starts_at) <= now.getTime()) return skip('Session started before the reminder went out');

  const who = people.get(r.recipient_id);
  if (!who || !who.active) return skip('Recipient deactivated');
  const p = prefsOf.get(r.recipient_id);
  const prefs = { ...DEFAULT_PREFS, ...(p ?? {}) };
  const forTutor = r.recipient_id === s.tutor_id;

  const coming = members.filter((m) => m.status === 'scheduled');
  const facts = {
    forTutor,
    recipientName: nameOf(who),
    tutorName: nameOf(people.get(s.tutor_id)),
    tuteeNames: forTutor ? (coming.length ? coming : [s]).map((m) => nameOf(people.get(m.tutee_id))) : [nameOf(who)],
    startsAt: s.starts_at, endsAt: s.ends_at, location: s.location ?? '',
    leadMin: Math.round((Date.parse(r.session_starts_at) - Date.parse(r.scheduled_for)) / 60000),
  } as Parameters<typeof renderReminder>[0];

  if (r.channel === 'email') {
    if (!prefs.reminder_email) return skip('Email reminders turned off');
    const to = (p?.contact_email ?? '').trim();
    if (!to) return skip('No contact email');
    if (!p?.contact_email_verified_at) return skip('Contact email not verified');
    if (isSyntheticEmail(to)) return skip('No contact email');
    if (forTutor) {
      facts.logLink = PORTAL_URL + '/#log=' + s.id;
      const token = await signToken({ a: 'complete', s: s.id, r: r.recipient_id, e: Math.floor(now.getTime() / 1000) + SIX_HOURS });
      if (token) facts.completeLink = actionLink(token);
    }
    const m = renderReminder(facts);
    const res = await sendEmail(to, m.subject, m.html, m.text);
    if (res.skipped) return skip(res.error ?? 'Not sent');
    return res.ok ? { status: 'sent', error: null, provider_id: res.id ?? null } : { status: 'failed', error: res.error ?? 'Send failed' };
  }

  if (r.channel === 'sms') {
    if (!prefs.reminder_sms) return skip('SMS reminders turned off');
    const phone = (p?.phone ?? '').trim();
    if (!phone || !isE164(phone)) return skip('No phone number');
    const { provider, reason } = smsProvider();
    if (!provider) return skip(reason);
    const res = await provider.send(phone, renderReminder(facts).sms);
    return res.ok ? { status: 'sent', error: null, provider_id: res.id ?? null } : { status: 'failed', error: res.error ?? 'Send failed' };
  }

  return skip('Push reminders are not available yet');
}

// Every row on its own: one bad address or a provider outage marks that row
// failed and the rest still go.
async function deliver(admin: SupabaseClient, list: Reminder[], now: Date) {
  const tally = { sent: 0, failed: 0, skipped: 0 };
  if (!list.length) return { tally, outcomes: new Map<string, Outcome>() };

  const sessionIds = [...new Set(list.map((r) => r.session_id))];
  const { data: sRows, error: sErr } = await admin.from('sessions').select('id, tutor_id, tutee_id, starts_at, ends_at, location, status, group_id').in('id', sessionIds);
  if (sErr) throw new Error('reading sessions: ' + sErr.message);
  const sessions = new Map((sRows ?? []).map((s: Session) => [s.id, s]));

  const groupIds = [...new Set([...sessions.values()].map((s) => s.group_id).filter(Boolean))] as string[];
  const groups = new Map<string, Session[]>();
  if (groupIds.length) {
    const { data, error } = await admin.from('sessions').select('id, tutor_id, tutee_id, starts_at, ends_at, location, status, group_id').in('group_id', groupIds);
    if (error) throw new Error('reading groups: ' + error.message);
    for (const g of (data ?? []) as Session[]) groups.set(g.group_id!, [...(groups.get(g.group_id!) ?? []), g]);
  }

  const personIds = new Set<string>(list.map((r) => r.recipient_id));
  for (const s of sessions.values()) { personIds.add(s.tutor_id); personIds.add(s.tutee_id); }
  for (const g of groups.values()) for (const m of g) personIds.add(m.tutee_id);
  const [{ data: pRows, error: pErr }, { data: nRows, error: nErr }] = await Promise.all([
    admin.from('profiles').select('id, display_name, username, role, active').in('id', [...personIds]),
    admin.from('notification_prefs').select('*').in('profile_id', [...new Set(list.map((r) => r.recipient_id))]),
  ]);
  if (pErr) throw new Error('reading profiles: ' + pErr.message);
  if (nErr) throw new Error('reading preferences: ' + nErr.message);
  const people = new Map((pRows ?? []).map((p: Person) => [p.id, p]));
  const prefsOf = new Map((nRows ?? []).map((p: Prefs) => [p.profile_id, p]));

  const outcomes = new Map<string, Outcome>();
  for (const r of list) {
    const s = sessions.get(r.session_id);
    let out: Outcome;
    try {
      out = await deliverOne(r, s, s?.group_id ? groups.get(s.group_id) ?? [s] : s ? [s] : [], people, prefsOf, now);
    } catch (e) {
      out = { status: 'failed', error: e instanceof Error ? e.message : String(e) };
    }
    outcomes.set(r.id, out);
    tally[out.status]++;
    const patch: Record<string, unknown> = { status: out.status, error: out.error };
    if (out.status === 'sent') { patch.sent_at = new Date().toISOString(); patch.provider_id = out.provider_id ?? null; }
    const { error } = await admin.from('session_reminders').update(patch).eq('id', r.id);
    if (error) console.error('[send-reminders] could not record', r.id, error.message);
  }
  return { tally, outcomes };
}

// ---- the scheduled run ----------------------------------------------------

async function run(admin: SupabaseClient, source: string) {
  const now = new Date();
  const started = now.toISOString();
  const sync = await admin.rpc('reminders_sync', { p_now: started });
  if (sync.error) throw new Error('reminders_sync: ' + sync.error.message);
  const claim = await admin.rpc('reminders_claim', { p_now: started, p_limit: 100 });
  if (claim.error) throw new Error('reminders_claim: ' + claim.error.message);
  const claimed = (claim.data ?? []) as Reminder[];
  const { tally } = await deliver(admin, claimed, now);
  const summary = { at: started, finished_at: new Date().toISOString(), source, queued: Number(sync.data) || 0, claimed: claimed.length, ...tally };
  const { error } = await admin.from('reminder_settings').upsert({ key: 'last_run', value: summary, updated_at: summary.finished_at });
  if (error) console.error('[send-reminders] could not record the run', error.message);
  return summary;
}

// ---- callers ---------------------------------------------------------------

function isScheduler(req: Request): boolean {
  const cronSecret = Deno.env.get('CRON_SECRET');
  const header = req.headers.get('x-cron-secret') ?? '';
  if (cronSecret && header && sameSecret(header, cronSecret)) return true;
  const bearer = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  return !!bearer && secretKeys().some((k) => sameSecret(bearer, k));
}

async function testSend(admin: SupabaseClient, me: Person) {
  const { data: p } = await admin.from('notification_prefs').select('*').eq('profile_id', me.id).maybeSingle();
  const prefs = p as Prefs | null;
  if (prefs?.last_test_at && Date.now() - Date.parse(prefs.last_test_at) < 60000) {
    return json({ error: 'One test a minute — try again shortly.' }, 429);
  }
  await admin.from('notification_prefs').update({ last_test_at: new Date().toISOString() }).eq('profile_id', me.id);

  const forTutor = me.role !== 'tutee';
  const lead = prefs?.reminder_lead_min ?? 60;
  const start = new Date(Date.now() + lead * 60000);
  start.setMinutes(Math.ceil(start.getMinutes() / 15) * 15, 0, 0);
  const m = renderReminder({
    forTutor, test: true, recipientName: nameOf(me),
    tutorName: forTutor ? nameOf(me) : 'your tutor', tuteeNames: forTutor ? ['Example tutee'] : [nameOf(me)],
    startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 3600000).toISOString(),
    location: 'Zoom', leadMin: lead,
  });

  const result: Record<string, { status: string; detail: string }> = {};
  const email = (prefs?.contact_email ?? '').trim();
  if (!(prefs?.reminder_email ?? true)) result.email = { status: 'skipped', detail: 'Email reminders are turned off.' };
  else if (!email || isSyntheticEmail(email)) result.email = { status: 'skipped', detail: 'No contact email yet.' };
  else if (!prefs?.contact_email_verified_at) result.email = { status: 'skipped', detail: 'Your contact email is not verified yet.' };
  else {
    const r = await sendEmail(email, m.subject, m.html, m.text);
    result.email = r.ok ? { status: 'sent', detail: 'Sent to ' + email + '.' } : { status: 'failed', detail: r.error ?? 'Send failed.' };
  }

  if (!prefs?.reminder_sms) result.sms = { status: 'skipped', detail: 'Text reminders are turned off.' };
  else if (!prefs.phone || !isE164(prefs.phone)) result.sms = { status: 'skipped', detail: 'No phone number.' };
  else {
    const { provider, reason } = smsProvider();
    if (!provider) result.sms = { status: 'skipped', detail: reason };
    else {
      const r = await provider.send(prefs.phone, m.sms);
      result.sms = r.ok ? { status: 'sent', detail: 'Sent to ' + prefs.phone + '.' } : { status: 'failed', detail: r.error ?? 'Send failed.' };
    }
  }
  return json(result);
}

async function resend(admin: SupabaseClient, id: unknown) {
  if (typeof id !== 'string' || !id) return json({ error: 'A reminder is required.' }, 400);
  const { data: row, error } = await admin.from('session_reminders').select('*').eq('id', id).maybeSingle();
  if (error) return json({ error: 'Could not read that reminder.' }, 500);
  if (!row) return json({ error: 'No such reminder.' }, 404);
  const now = new Date();
  const { data: s } = await admin.from('sessions').select('status, starts_at').eq('id', row.session_id).maybeSingle();
  if (!s || s.status !== 'scheduled') return json({ error: 'That session is no longer scheduled.' }, 409);
  if (Date.parse(s.starts_at) <= now.getTime()) return json({ error: 'That session has already started.' }, 409);

  const { data: claimed, error: claimErr } = await admin.from('session_reminders')
    .update({ status: 'pending', error: null, claimed_at: now.toISOString(), attempts: (row.attempts ?? 0) + 1 })
    .eq('id', id).select('*').single();
  if (claimErr || !claimed) return json({ error: 'Could not claim that reminder.' }, 500);
  const { outcomes } = await deliver(admin, [claimed as Reminder], now);
  const out = outcomes.get(id)!;
  return json({ id, status: out.status, error: out.error });
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
  const admin = serviceClient();
  if (!admin) return json({ error: 'Function is not configured.' }, 500);

  let body: Record<string, unknown> = {};
  try {
    const raw = await req.text();
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return json({ error: 'Expected a JSON body.' }, 400);
  }

  if (isScheduler(req)) {
    try {
      return json(await run(admin, typeof body.source === 'string' ? body.source.slice(0, 40) : 'scheduler'));
    } catch (e) {
      console.error('[send-reminders]', e);
      return json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  }

  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return json({ error: 'Missing bearer token.' }, 401);
  const { data: caller, error: callerErr } = await admin.auth.getUser(token);
  if (callerErr || !caller?.user) return json({ error: 'Invalid or expired session.' }, 401);
  const { data: me } = await admin.from('profiles').select('id, display_name, username, role, active').eq('id', caller.user.id).maybeSingle();
  if (!me || me.active === false) return json({ error: 'This account cannot send reminders.' }, 403);

  if (body.action === 'test') return testSend(admin, me as Person);
  if (me.role !== 'admin') return json({ error: 'Admins only.' }, 403);
  if (body.action === 'resend') return resend(admin, body.reminder_id);
  if (body.action === 'run') {
    try {
      return json(await run(admin, 'admin'));
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  }
  return json({ error: 'Unknown action.' }, 400);
});
