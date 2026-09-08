// create-user — admin-only account creation.
//
// Creating an auth user needs the service_role key, which can never ship to a
// static site. The browser calls this with the admin's own access token; we
// verify that token, confirm the caller really is an admin, and only then use
// the privileged client.
//
// Deploy:  supabase functions deploy create-user
// Secrets: TUTOR_EMAIL_DOMAIN, ALLOWED_ORIGIN  (SUPABASE_* are injected)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const TUTOR_EMAIL_DOMAIN = Deno.env.get('TUTOR_EMAIL_DOMAIN') ?? 'tutors.peerprepacademy.com';
const ALLOWED_ORIGIN = Deno.env.get('ALLOWED_ORIGIN') ?? '*';

const cors: Record<string, string> = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Vary': 'Origin',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

interface Payload {
  kind?: 'tutor' | 'tutee';
  username?: string;
  pin?: string;
  email?: string;
  display_name?: string;
  tutor_id?: string;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');

  // Secret keys arrive as a JSON map so a project can rotate them without a
  // redeploy; 'default' is the one currently in force.
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

  // 1. Is the token real and unexpired?
  const { data: caller, error: callerErr } = await admin.auth.getUser(token);
  if (callerErr || !caller?.user) return json({ error: 'Invalid or expired session.' }, 401);

  // 2. Is the caller an admin? Role lives in profiles, not in the JWT, so a
  //    forged claim cannot get anyone in here.
  const { data: profile, error: profileErr } = await admin
    .from('profiles')
    .select('role')
    .eq('id', caller.user.id)
    .maybeSingle();
  if (profileErr) return json({ error: 'Could not verify your account.' }, 500);
  if (!profile || profile.role !== 'admin') return json({ error: 'Admins only.' }, 403);

  let body: Payload;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Expected a JSON body.' }, 400);
  }

  const kind = body.kind;
  const displayName = (body.display_name ?? '').trim();
  if (kind !== 'tutor' && kind !== 'tutee') return json({ error: 'kind must be "tutor" or "tutee".' }, 400);
  if (!displayName) return json({ error: 'A display name is required.' }, 400);

  let email: string;
  let password: string;
  let username: string | null = null;

  if (kind === 'tutor') {
    username = (body.username ?? '').trim().toLowerCase();
    password = String(body.pin ?? '');
    if (!/^[a-z0-9._-]{2,32}$/.test(username)) {
      return json({ error: 'Username must be 2\u201332 characters: letters, digits, dot, dash or underscore.' }, 400);
    }
    if (password.length < 4) return json({ error: 'PIN must be at least 4 characters.' }, 400);
    email = `${username}@${TUTOR_EMAIL_DOMAIN}`;
  } else {
    email = (body.email ?? '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: 'A valid email is required.' }, 400);
    // Tutees only ever sign in with a magic link, so the password is a
    // throwaway that nobody — including the admin — is told.
    password = crypto.randomUUID() + crypto.randomUUID();
  }

  // email_confirm skips the verification mail: the admin vouched for them.
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { username, display_name: displayName, role: kind },
  });

  if (createErr || !created?.user) {
    const message = createErr?.message ?? 'Could not create the account.';
    const duplicate = /already|registered|exists|duplicate/i.test(message);
    return json(
      { error: duplicate ? `That ${kind === 'tutor' ? 'username' : 'email'} is already taken.` : message },
      duplicate ? 409 : 400,
    );
  }

  const id = created.user.id;

  // The profiles row itself is written by the on_auth_user_created trigger.
  if (kind === 'tutee' && body.tutor_id) {
    const { error: linkErr } = await admin
      .from('tutor_tutees')
      .insert({ tutor_id: body.tutor_id, tutee_id: id });
    if (linkErr) {
      return json({ id, warning: `Account created, but linking the tutor failed: ${linkErr.message}` }, 207);
    }
  }

  return json({ id }, 201);
});
