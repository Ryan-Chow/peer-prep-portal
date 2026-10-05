// The caller check every admin-only function makes, in one place.
//
// create-user predates this file and carries its own copy; the functions
// written since import this one, so a fix to the check lands in all of them.

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

export const TUTOR_EMAIL_DOMAIN = Deno.env.get('TUTOR_EMAIL_DOMAIN') ?? 'tutors.peerprepacademy.com';
const ALLOWED_ORIGIN = Deno.env.get('ALLOWED_ORIGIN') ?? '*';

export const cors: Record<string, string> = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Vary': 'Origin',
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

export interface AdminCall {
  admin: SupabaseClient;
  callerId: string;
  body: Record<string, unknown>;
}

// Returns the privileged client, the caller's id and the parsed body, or the
// Response to send back when any of that fails. Role lives in profiles, not in
// the JWT, so a forged claim cannot get anyone through; a deactivated admin is
// refused as well.
export async function requireAdmin(req: Request): Promise<AdminCall | Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  let secretKey: string | undefined;
  try {
    secretKey = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS')!)['default'];
  } catch {
    secretKey = undefined;
  }
  if (!supabaseUrl || !secretKey) return json({ error: 'Function is not configured.' }, 500);

  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return json({ error: 'Missing bearer token.' }, 401);

  const admin = createClient(supabaseUrl, secretKey, { auth: { persistSession: false } });

  const { data: caller, error: callerErr } = await admin.auth.getUser(token);
  if (callerErr || !caller?.user) return json({ error: 'Invalid or expired session.' }, 401);

  const { data: profile, error: profileErr } = await admin
    .from('profiles')
    .select('role, active')
    .eq('id', caller.user.id)
    .maybeSingle();
  if (profileErr) return json({ error: 'Could not verify your account.' }, 500);
  if (!profile || profile.role !== 'admin' || profile.active === false) return json({ error: 'Admins only.' }, 403);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Expected a JSON body.' }, 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Expected a JSON object.' }, 400);

  return { admin, callerId: caller.user.id, body };
}

export interface Target {
  id: string;
  role: string;
  display_name: string | null;
  username: string | null;
  email: string | null;
  active: boolean;
}

// The account an admin is acting on. Admins themselves are out of reach: one
// admin rewriting or deleting another is a takeover of the whole project, and
// an admin changes their own password by password reset.
export async function loadTarget(admin: SupabaseClient, callerId: string, id: unknown): Promise<Target | Response> {
  const targetId = typeof id === 'string' ? id.trim() : '';
  if (!targetId) return json({ error: 'A user is required.' }, 400);
  if (targetId === callerId) return json({ error: 'You cannot do that to your own account.' }, 403);

  const { data, error } = await admin
    .from('profiles')
    .select('id, role, display_name, username, email, active')
    .eq('id', targetId)
    .maybeSingle();
  if (error) return json({ error: 'Could not look that account up.' }, 500);
  if (!data) return json({ error: 'No such account.' }, 404);
  if (data.role === 'admin') return json({ error: 'Admin accounts are managed in the Supabase dashboard, not here.' }, 403);
  return data as Target;
}

export const isUuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
