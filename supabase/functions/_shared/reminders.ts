// What send-reminders, session-action and notification-prefs share: the
// privileged client, signed links, the email and SMS providers, and the
// message text.

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

export const TUTOR_EMAIL_DOMAIN = (Deno.env.get('TUTOR_EMAIL_DOMAIN') ?? 'tutors.peerprepacademy.com').toLowerCase();
export const PORTAL_URL = (Deno.env.get('PORTAL_URL') ?? 'https://portal.peerprepacademy.com').replace(/\/+$/, '');
export const REMINDER_TZ = Deno.env.get('REMINDER_TIMEZONE') ?? 'America/Los_Angeles';
const FROM = Deno.env.get('REMINDER_FROM') ?? 'Peer Prep Academy <noreply@peerprepacademy.com>';

export function secretKeys(): string[] {
  const out: string[] = [];
  try {
    const all = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}');
    for (const v of Object.values(all)) if (typeof v === 'string' && v) out.push(v);
  } catch {
    // Not set on older projects; the legacy key below covers those.
  }
  const legacy = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (legacy) out.push(legacy);
  return out;
}

export function serviceClient(): SupabaseClient | null {
  const url = Deno.env.get('SUPABASE_URL');
  const key = secretKeys()[0];
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

// Comparing secrets byte by byte at a fixed cost, so the time a wrong guess
// takes says nothing about how much of it was right.
export function sameSecret(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export const isEmail = (v: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) && v.length <= 254;
// The sign-in address of a tutor. It reaches nobody, so nothing is ever sent
// to it, whatever ends up in contact_email.
export const isSyntheticEmail = (v: string) => v.toLowerCase().endsWith('@' + TUTOR_EMAIL_DOMAIN);
export const isE164 = (v: string) => /^\+[1-9][0-9]{6,14}$/.test(v);

// ---- signed links ----------------------------------------------------------
//
// base64url(JSON payload) + "." + base64url(HMAC-SHA256). The payload carries
// its own expiry; nothing is stored, so a link cannot be revoked early, which
// is why each one is narrow (one session, one tutor, six hours).

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

async function hmacKey(): Promise<CryptoKey | null> {
  const secret = Deno.env.get('REMINDER_SIGNING_SECRET');
  if (!secret || secret.length < 32) return null;
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export type TokenPayload =
  | { a: 'complete'; s: string; r: string; e: number }
  | { a: 'verify'; p: string; m: string; e: number };

export async function signToken(payload: TokenPayload): Promise<string | null> {
  const key = await hmacKey();
  if (!key) return null;
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
  return body + '.' + b64url(sig);
}

export async function verifyToken(token: string): Promise<TokenPayload | 'expired' | null> {
  const key = await hmacKey();
  const m = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(token);
  if (!key || !m) return null;
  let ok = false;
  try {
    ok = await crypto.subtle.verify('HMAC', key, unb64url(m[2]), new TextEncoder().encode(m[1]));
  } catch {
    return null;
  }
  if (!ok) return null;
  let p: TokenPayload;
  try {
    p = JSON.parse(new TextDecoder().decode(unb64url(m[1])));
  } catch {
    return null;
  }
  if (!p || typeof p.e !== 'number') return null;
  if (Date.now() / 1000 > p.e) return 'expired';
  return p;
}

export const actionLink = (token: string) => PORTAL_URL + '/#action=' + token;

// ---- email (Resend) --------------------------------------------------------

export interface SendResult { ok: boolean; id?: string; error?: string; skipped?: boolean }

export async function sendEmail(to: string, subject: string, html: string, text: string): Promise<SendResult> {
  const key = Deno.env.get('RESEND_API_KEY');
  if (!key) return { ok: false, error: 'Email is not configured: RESEND_API_KEY is not set.' };
  if (isSyntheticEmail(to)) return { ok: false, skipped: true, error: 'That is a sign-in address, not an inbox.' };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, to: [to], subject, html, text }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: 'Resend ' + res.status + ': ' + (out.message ?? out.error ?? res.statusText) };
    return { ok: true, id: out.id };
  } catch (e) {
    return { ok: false, error: 'Resend unreachable: ' + (e instanceof Error ? e.message : String(e)) };
  }
}

// ---- SMS -------------------------------------------------------------------

export interface SmsProvider {
  name: string;
  send(to: string, body: string): Promise<SendResult>;
}

class TwilioSms implements SmsProvider {
  name = 'twilio';
  constructor(private sid: string, private token: string, private from: string) {}
  async send(to: string, body: string): Promise<SendResult> {
    try {
      const res = await fetch('https://api.twilio.com/2010-04-01/Accounts/' + encodeURIComponent(this.sid) + '/Messages.json', {
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + btoa(this.sid + ':' + this.token),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ To: to, From: this.from, Body: body }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: 'Twilio ' + res.status + ': ' + (out.message ?? res.statusText) };
      return { ok: true, id: out.sid };
    } catch (e) {
      return { ok: false, error: 'Twilio unreachable: ' + (e instanceof Error ? e.message : String(e)) };
    }
  }
}

// Null with the reason when SMS is not set up, so the caller records a skip
// instead of failing.
export function smsProvider(): { provider: SmsProvider | null; reason: string } {
  const need = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM'];
  const missing = need.filter((k) => !Deno.env.get(k));
  if (missing.length) return { provider: null, reason: 'SMS is not configured: ' + missing.join(', ') + ' not set.' };
  return { provider: new TwilioSms(Deno.env.get('TWILIO_ACCOUNT_SID')!, Deno.env.get('TWILIO_AUTH_TOKEN')!, Deno.env.get('TWILIO_FROM')!), reason: '' };
}

// ---- message text ----------------------------------------------------------

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export const fmtTime = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-US', { timeZone: REMINDER_TZ, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
export const fmtDay = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { timeZone: REMINDER_TZ, weekday: 'long', month: 'long', day: 'numeric' });

export function fmtLead(min: number): string {
  if (min % 60 === 0) return min === 60 ? '1 hour' : (min / 60) + ' hours';
  return min + ' minutes';
}

export interface ReminderFacts {
  forTutor: boolean;
  recipientName: string;
  tutorName: string;
  tuteeNames: string[];
  startsAt: string;
  endsAt: string;
  location: string;
  leadMin: number;
  logLink?: string;
  completeLink?: string;
  test?: boolean;
}

export function renderReminder(f: ReminderFacts): { subject: string; html: string; text: string; sms: string } {
  const who = f.tuteeNames.length > 1 ? 'Group (' + f.tuteeNames.join(', ') + ')' : (f.tuteeNames[0] ?? 'your tutee');
  const time = fmtTime(f.startsAt), day = fmtDay(f.startsAt);
  const minutes = Math.round((Date.parse(f.endsAt) - Date.parse(f.startsAt)) / 60000);
  const lead = fmtLead(f.leadMin);
  const prefix = f.test ? '[Test] ' : '';
  const subject = prefix + (f.forTutor
    ? 'Session in ' + lead + ': ' + who + ' at ' + time
    : 'Tutoring in ' + lead + ' with ' + f.tutorName + ' at ' + time);
  const isLink = /^https:\/\/[^\s"'<>]+$/i.test(f.location);

  const rows: [string, string][] = [
    [f.forTutor ? 'Tutee' : 'Tutor', f.forTutor ? who : f.tutorName],
    ['When', day + ', ' + time],
    ['Length', minutes + ' minutes'],
  ];
  if (f.location) rows.push(['Where', f.location]);

  const cell = (k: string, v: string) =>
    '<tr><td style="padding:4px 12px 4px 0;color:#666">' + esc(k) + '</td><td style="padding:4px 0">' +
    (k === 'Where' && isLink ? '<a href="' + esc(v) + '">' + esc(v) + '</a>' : esc(v)) + '</td></tr>';
  const button = (href: string, label: string, primary: boolean) =>
    '<a href="' + esc(href) + '" style="display:inline-block;margin:4px 8px 4px 0;padding:10px 16px;text-decoration:none;border-radius:4px;' +
    (primary ? 'background:#1b4a80;color:#fff' : 'border:1px solid #1b4a80;color:#1b4a80') + '">' + esc(label) + '</a>';

  const intro = f.test
    ? 'This is a test reminder. Real ones look like this and arrive ' + lead + ' before each session.'
    : f.forTutor ? 'You have a tutoring session coming up.' : 'You have a tutoring session coming up with ' + f.tutorName + '.';
  const buttons = f.forTutor
    ? [f.logLink ? button(f.logLink, 'Log session', true) : '', f.completeLink ? button(f.completeLink, 'Mark completed', false) : ''].join('')
    : '';
  const footer = 'Change or turn off these reminders under Notifications in the portal: ' + PORTAL_URL;

  const html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#1a1a1a;max-width:520px">' +
    '<p>Hi ' + esc(f.recipientName) + ',</p><p>' + esc(intro) + '</p>' +
    '<table style="border-collapse:collapse;margin:8px 0 16px">' + rows.map(([k, v]) => cell(k, v)).join('') + '</table>' +
    (buttons ? '<p>' + buttons + '</p>' : '') +
    (f.completeLink ? '<p style="font-size:12px;color:#666">The Mark completed link works once the session has started, for six hours.</p>' : '') +
    '<p style="font-size:12px;color:#666">' + esc(footer) + '</p></div>';

  const text = ['Hi ' + f.recipientName + ',', '', intro, '']
    .concat(rows.map(([k, v]) => k + ': ' + v))
    .concat(f.forTutor && f.logLink ? ['', 'Log session: ' + f.logLink] : [])
    .concat(f.forTutor && f.completeLink ? ['Mark completed (from the start time, for six hours): ' + f.completeLink] : [])
    .concat(['', footer]).join('\n');

  const sms = prefix + (f.forTutor
    ? 'Peer Prep: session with ' + who + ' at ' + time + ' (' + minutes + ' min)' + (f.location ? ', ' + f.location : '') + '.'
    : 'Peer Prep: tutoring with ' + f.tutorName + ' at ' + time + ' (' + minutes + ' min)' + (f.location ? ', ' + f.location : '') + '.');

  return { subject, html, text, sms };
}
