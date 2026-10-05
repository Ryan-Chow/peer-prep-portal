// cache-image — admin-only: copy a hot-linked image into our own storage.
//
// A problem whose figure is a link to somebody else's site loses the figure
// the day that site moves it. This downloads the image server-side, stores it
// in the public problem-images bucket under a name derived from its content,
// and returns the bucket URL for the editor to put in place of the original.
//
// It fetches a URL an admin typed, from inside Supabase's network, so it is
// careful about where it will go: https on the default port only, no
// credentials in the URL, no private or loopback addresses (checked on every
// redirect hop, and on the resolved address where the runtime can resolve),
// a size cap, a timeout, and the bytes themselves must be a PNG, JPEG, GIF or
// WebP whatever the server's Content-Type claims. SVG is refused: opened
// directly from the bucket it would run its scripts in the storage origin.
//
// scripts/import.js --cache-images does the same job from the admin's own
// machine with the secret key, and "Upload file" in the editor from the
// browser; all three store under img/<sha256>.<ext>, so a figure
// copied by one is found again by the others rather than stored twice.
//
// Deploy:  supabase functions deploy cache-image
// Secrets: ALLOWED_ORIGIN  (SUPABASE_* are injected)

import { json, requireAdmin } from '../_shared/admin.ts';

const BUCKET = 'problem-images';
const MAX_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 3;

const URL_RE = /^https:\/\/[^\s"'<>\\]+$/i;

function sniff(b: Uint8Array): { type: string; ext: string } | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { type: 'image/png', ext: 'png' };
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { type: 'image/jpeg', ext: 'jpg' };
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return { type: 'image/gif', ext: 'gif' };
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return { type: 'image/webp', ext: 'webp' };
  return null;
}

function privateV4(ip: string): boolean {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !(n >= 0 && n <= 255))) return false;
  return p[0] === 0 || p[0] === 10 || p[0] === 127 ||
    (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
    (p[0] === 169 && p[1] === 254) ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) ||
    (p[0] === 198 && (p[1] === 18 || p[1] === 19)) ||
    p[0] >= 224;
}

function privateV6(ip: string): boolean {
  const a = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (a === '::' || a === '::1') return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped) return privateV4(mapped[1]);
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(a);
}

async function refuseHost(host: string): Promise<string | null> {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) {
    return 'That address is not on the public internet.';
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return privateV4(h) ? 'That address is not on the public internet.' : null;
  if (h.includes(':')) return privateV6(h) ? 'That address is not on the public internet.' : null;
  // Where the runtime can resolve, check what the name actually points at.
  for (const kind of ['A', 'AAAA'] as const) {
    try {
      const addrs = await Deno.resolveDns(h, kind);
      if (addrs.some((ip) => (kind === 'A' ? privateV4(ip) : privateV6(ip)))) {
        return 'That address is not on the public internet.';
      }
    } catch {
      // No record of this kind, or no resolver here: the fetch decides.
    }
  }
  return null;
}

async function checkUrl(raw: string): Promise<URL | string> {
  if (!URL_RE.test(raw) || raw.length > 2048) return 'Use a plain https:// link.';
  let u: URL;
  try { u = new URL(raw); } catch { return 'That is not a valid link.'; }
  if (u.protocol !== 'https:') return 'Use a plain https:// link.';
  if (u.username || u.password) return 'Links with a username or password in them are not accepted.';
  if (u.port && u.port !== '443') return 'Only links on the standard https port are accepted.';
  const why = await refuseHost(u.hostname);
  return why ?? u;
}

async function readCapped(res: Response): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > MAX_BYTES) return null;
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_BYTES) { await reader.cancel(); return null; }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

Deno.serve(async (req: Request): Promise<Response> => {
  const call = await requireAdmin(req);
  if (call instanceof Response) return call;
  const { admin, body } = call;

  const raw = String(body.url ?? '').trim();
  const publicPrefix = admin.storage.from(BUCKET).getPublicUrl('').data.publicUrl;
  if (raw.startsWith(publicPrefix)) return json({ url: raw, already: true }, 200);

  let target = await checkUrl(raw);
  if (typeof target === 'string') return json({ error: target }, 400);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res: Response | null = null;
  try {
    for (let hop = 0; ; hop++) {
      res = await fetch(target.href, {
        redirect: 'manual',
        signal: ctrl.signal,
        headers: { 'Accept': 'image/png,image/jpeg,image/gif,image/webp;q=0.9,*/*;q=0.1' },
      });
      if (res.status < 300 || res.status >= 400) break;
      if (hop >= MAX_REDIRECTS) return json({ error: 'That link redirects too many times.' }, 400);
      const next = res.headers.get('location');
      if (!next) return json({ error: 'That link redirects nowhere.' }, 400);
      const checked = await checkUrl(new URL(next, target).href);
      if (typeof checked === 'string') return json({ error: 'That link redirects somewhere refused: ' + checked }, 400);
      target = checked;
    }
    if (!res.ok) return json({ error: `The image could not be downloaded (HTTP ${res.status}).` }, 400);

    const bytes = await readCapped(res);
    if (!bytes) return json({ error: 'That image is larger than 10 MB.' }, 400);
    const kind = sniff(bytes);
    if (!kind) return json({ error: 'That link is not a PNG, JPEG, GIF or WebP image.' }, 400);

    // readCapped builds a fresh, exactly-sized buffer, so .buffer is the bytes.
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.buffer as ArrayBuffer));
    const hash = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
    const path = `img/${hash}.${kind.ext}`;

    // Content-addressed, so a second copy of the same picture is the same
    // object; upsert makes that a no-op rather than a conflict.
    const up = await admin.storage.from(BUCKET).upload(path, bytes, {
      contentType: kind.type, upsert: true, cacheControl: '31536000',
    });
    if (up.error) return json({ error: 'Storing the copy failed: ' + up.error.message }, 500);

    const url = admin.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
    return json({ url, path, bytes: bytes.length, content_type: kind.type }, 200);
  } catch (e) {
    const aborted = e instanceof DOMException && e.name === 'AbortError';
    return json({ error: aborted ? 'The image took too long to download.' : 'The image could not be downloaded.' }, 400);
  } finally {
    clearTimeout(timer);
  }
});
