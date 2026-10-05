// update-user — admin-only edits to an existing account.
//
// Everything on the Users tab's Edit dialog, plus Deactivate / Reactivate:
//   display_name   profiles, and the auth metadata the trigger copied it from
//   email          tutees: the address they sign in with
//   username       tutors: the username, and the synthetic address it expands to
//   pin            a new PIN (the account's password)
//   tutor_id       tutees: '' unlinks, a tutor's id links (one tutor per tutee)
//   tutee_ids      tutors: the complete list of their tutees
//   active         false bans the account in auth and marks the profile; true
//                  undoes both
// Fields left out are left alone.
//
// Deploy:  supabase functions deploy update-user
// Secrets: TUTOR_EMAIL_DOMAIN, ALLOWED_ORIGIN  (SUPABASE_* are injected)

import { isUuid, json, loadTarget, requireAdmin, TUTOR_EMAIL_DOMAIN } from '../_shared/admin.ts';

// Long enough to mean "until someone lifts it". Supabase has no permanent ban,
// only a duration, and 'none' is how a ban is lifted.
const BAN_FOREVER = '876000h';

Deno.serve(async (req: Request): Promise<Response> => {
  const call = await requireAdmin(req);
  if (call instanceof Response) return call;
  const { admin, callerId, body } = call;

  const target = await loadTarget(admin, callerId, body.user_id);
  if (target instanceof Response) return target;

  const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k) && body[k] !== undefined;
  const authPatch: Record<string, unknown> = {};
  const meta: Record<string, unknown> = {};
  const profilePatch: Record<string, unknown> = {};

  // ---- validate everything before writing anything ----

  if (has('display_name')) {
    const name = String(body.display_name ?? '').trim();
    if (!name) return json({ error: 'A display name is required.' }, 400);
    if (name.length > 80) return json({ error: 'Keep the name under 80 characters.' }, 400);
    profilePatch.display_name = name;
    meta.display_name = name;
  }

  if (has('email')) {
    if (target.role !== 'tutee') return json({ error: 'Only a tutee signs in with an email address.' }, 400);
    const email = String(body.email ?? '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: 'A valid email is required.' }, 400);
    if (email !== (target.email ?? '').toLowerCase()) {
      authPatch.email = email;
      authPatch.email_confirm = true;
      profilePatch.email = email;
    }
  }

  if (has('username')) {
    if (target.role !== 'tutor') return json({ error: 'Only a tutor signs in with a username.' }, 400);
    const username = String(body.username ?? '').trim().toLowerCase();
    if (!/^[a-z0-9._-]{2,32}$/.test(username)) {
      return json({ error: 'Username must be 2–32 characters: letters, digits, dot, dash or underscore.' }, 400);
    }
    if (username !== (target.username ?? '')) {
      const { data: clash } = await admin.from('profiles').select('id').eq('username', username).maybeSingle();
      if (clash && clash.id !== target.id) return json({ error: 'That username is already taken.' }, 409);
      // The login screen expands a bare username to this address, so the two
      // have to move together or the tutor cannot sign in.
      const email = `${username}@${TUTOR_EMAIL_DOMAIN}`;
      authPatch.email = email;
      authPatch.email_confirm = true;
      meta.username = username;
      profilePatch.username = username;
      profilePatch.email = email;
    }
  }

  if (has('pin') && String(body.pin ?? '') !== '') {
    const pin = String(body.pin);
    if (pin.length < 4) return json({ error: 'PIN must be at least 4 characters.' }, 400);
    authPatch.password = pin;
  }

  if (has('active')) {
    if (typeof body.active !== 'boolean') return json({ error: 'active must be true or false.' }, 400);
    if (body.active !== target.active) {
      authPatch.ban_duration = body.active ? 'none' : BAN_FOREVER;
      profilePatch.active = body.active;
    }
  }

  let tutorLink: string | null | undefined;
  if (has('tutor_id')) {
    if (target.role !== 'tutee') return json({ error: 'Only a tutee has a tutor.' }, 400);
    const tid = String(body.tutor_id ?? '').trim();
    if (tid && !isUuid(tid)) return json({ error: 'That tutor id is not valid.' }, 400);
    if (tid) {
      const { data: tutor } = await admin.from('profiles').select('role, active').eq('id', tid).maybeSingle();
      if (!tutor || tutor.role !== 'tutor') return json({ error: 'No such tutor.' }, 404);
      if (tutor.active === false) return json({ error: 'That tutor is deactivated.' }, 400);
    }
    tutorLink = tid || null;
  }

  let tuteeList: string[] | undefined;
  if (has('tutee_ids')) {
    if (target.role !== 'tutor') return json({ error: 'Only a tutor has tutees.' }, 400);
    if (!Array.isArray(body.tutee_ids) || !body.tutee_ids.every(isUuid)) {
      return json({ error: 'tutee_ids must be a list of ids.' }, 400);
    }
    tuteeList = Array.from(new Set(body.tutee_ids as string[]));
    if (tuteeList.length) {
      const { data: rows, error } = await admin.from('profiles').select('id, role').in('id', tuteeList);
      if (error) return json({ error: 'Could not check those tutees.' }, 500);
      if ((rows ?? []).length !== tuteeList.length || (rows ?? []).some((r) => r.role !== 'tutee')) {
        return json({ error: 'Every id in tutee_ids must be a tutee.' }, 400);
      }
    }
  }

  // ---- write: auth first, so a refused address leaves the profile as it was ----

  if (Object.keys(meta).length) authPatch.user_metadata = meta;
  if (Object.keys(authPatch).length) {
    const { error } = await admin.auth.admin.updateUserById(target.id, authPatch);
    if (error) {
      const message = error.message ?? 'Could not update the account.';
      const duplicate = /already|registered|exists|duplicate/i.test(message);
      return json({ error: duplicate ? 'That address is already used by another account.' : message }, duplicate ? 409 : 400);
    }
  }

  if (Object.keys(profilePatch).length) {
    const { error } = await admin.from('profiles').update(profilePatch).eq('id', target.id);
    if (error) return json({ error: 'The sign-in details changed but the profile did not: ' + error.message }, 500);
  }

  // tutor_tutees has a unique index on tutee_id, so a tutee is moved by
  // deleting their one link before writing the new one.
  if (tutorLink !== undefined) {
    const del = await admin.from('tutor_tutees').delete().eq('tutee_id', target.id);
    if (del.error) return json({ error: 'Saved, but unlinking the old tutor failed: ' + del.error.message }, 500);
    if (tutorLink) {
      const ins = await admin.from('tutor_tutees').insert({ tutor_id: tutorLink, tutee_id: target.id });
      if (ins.error) return json({ error: 'Saved, but linking the tutor failed: ' + ins.error.message }, 500);
    }
  }

  if (tuteeList !== undefined) {
    const { data: current, error } = await admin.from('tutor_tutees').select('tutee_id').eq('tutor_id', target.id);
    if (error) return json({ error: 'Saved, but reading their tutees failed: ' + error.message }, 500);
    const had = new Set((current ?? []).map((r) => r.tutee_id as string));
    const want = new Set(tuteeList);
    const drop = [...had].filter((id) => !want.has(id));
    const add = [...want].filter((id) => !had.has(id));
    if (drop.length) {
      const res = await admin.from('tutor_tutees').delete().eq('tutor_id', target.id).in('tutee_id', drop);
      if (res.error) return json({ error: 'Saved, but unlinking tutees failed: ' + res.error.message }, 500);
    }
    if (add.length) {
      // Taking a tutee means taking them from whoever had them.
      const res = await admin.from('tutor_tutees').delete().in('tutee_id', add);
      if (res.error) return json({ error: 'Saved, but moving tutees failed: ' + res.error.message }, 500);
      const ins = await admin.from('tutor_tutees').insert(add.map((tutee_id) => ({ tutor_id: target.id, tutee_id })));
      if (ins.error) return json({ error: 'Saved, but linking tutees failed: ' + ins.error.message }, 500);
    }
  }

  return json({ id: target.id }, 200);
});
