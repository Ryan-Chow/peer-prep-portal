// Peer Prep Academy — Supabase data layer.
//
// The UI was written against a synchronous mock, so every getter here answers
// from an in-memory cache and never returns a promise. Mutations update that
// cache optimistically, flush to Supabase, and roll back on failure. Anything
// that lands out of band (a background load, a write confirmation) fires the
// db.onChange() subscribers so the component can re-render.
(function () {
  // dc-runtime re-injects <helmet> scripts into <head>, so this file can be
  // evaluated twice. A second data layer would rebind window.db to an empty
  // cache that nobody is subscribed to, stranding the UI on the login screen.
  if (window.db) return;

  const cfg = window.PPA_CONFIG || {};
  const TUTOR_DOMAIN = cfg.TUTOR_EMAIL_DOMAIN || 'tutors.peerprepacademy.com';

  const sb = window.ppaSupabase;
  if (!sb) { console.error('[ppa] supabaseClient.js must load before db.js.'); return; }

  // ---- change notification ------------------------------------------------

  const listeners = new Set();
  const notify = () => { listeners.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } }); };

  let toastEl = null, toastTimer = null;
  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.style.cssText = 'position:fixed;left:50%;bottom:20px;transform:translateX(-50%);' +
        'max-width:min(520px,92vw);padding:10px 16px;font:13px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;' +
        'background:#2a1215;color:#ffb4a8;border:1px solid #5c2b2e;border-radius:8px;z-index:99999';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.style.display = 'none'; }, 6000);
  }

  function fail(where, err) {
    console.error('[ppa] ' + where, err);
    toast((err && (err.message || err.error_description)) || ('Something went wrong (' + where + ').'));
    return err;
  }

  // ---- cache --------------------------------------------------------------

  const S = {
    meId: null,
    users: new Map(),       // id -> UI user
    modules: new Map(),     // id -> UI module (with .problems)
    assignments: new Map(), // id -> UI assignment
    links: [],              // { tutor_id, tutee_id }
    subs: new Map(),        // "tuteeId:problemId" -> { answer, correct }
    errors: new Map(),      // id -> UI error log entry
    loaded: false,
    // True until the first getSession() (and any profile load it triggers)
    // settles. The UI shows a neutral splash rather than flashing the login
    // card at someone who is already signed in.
    booting: true
  };

  const uiRole = (r) => (r === 'tutee' ? 'student' : r);
  const dbRole = (r) => (r === 'student' ? 'tutee' : r);
  const subKey = (tuteeId, problemId) => tuteeId + ':' + problemId;
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    }));

  function clear() {
    S.meId = null;
    S.users.clear(); S.modules.clear(); S.assignments.clear(); S.subs.clear();
    S.errors.clear();
    S.links = [];
    S.loaded = false;
  }

  function putUser(row) {
    S.users.set(row.id, {
      id: row.id,
      role: uiRole(row.role),
      name: row.display_name || row.username || row.email || '\u2014',
      email: row.email || '',
      username: row.username || ''
    });
  }

  function putModule(row) {
    const prev = S.modules.get(row.id);
    S.modules.set(row.id, {
      id: row.id,
      title: row.title,
      subject: row.subject || 'General',
      description: row.description || '',
      // Filled by a trigger, so it is present on every row. The import preview
      // uses it to tell "this file updates a module you have" from "this file
      // creates one".
      slug: row.slug || '',
      problems: prev ? prev.problems : []
    });
  }

  // Accepts rows from `problems` (tutor/admin) or `problems_public` (tutee,
  // no answer key). Replaces the problem list of every module it touches.
  function putProblems(rows) {
    const byModule = new Map();
    (rows || []).forEach((row) => {
      if (!byModule.has(row.module_id)) byModule.set(row.module_id, []);
      byModule.get(row.module_id).push(row);
    });
    byModule.forEach((list, moduleId) => {
      const m = S.modules.get(moduleId);
      if (!m) return;
      list.sort((a, b) => (a.sort_order - b.sort_order) || String(a.id).localeCompare(String(b.id)));
      m.problems = list.map((row) => ({
        id: row.id,
        type: row.type,
        text: row.question,
        choices: Array.isArray(row.choices) ? row.choices : [],
        answer: row.answer == null ? '' : row.answer,
        explanation: row.explanation == null ? '' : row.explanation,
        sortOrder: row.sort_order
      }));
    });
  }

  // Fill in the answer key for problems the tutee has already submitted.
  function applyRevealed(rows) {
    (rows || []).forEach((row) => {
      const m = S.modules.get(row.module_id);
      const p = m && m.problems.find((x) => x.id === row.id);
      if (!p) return;
      p.answer = row.answer == null ? '' : row.answer;
      p.explanation = row.explanation == null ? '' : row.explanation;
    });
  }

  function putAssignment(row) {
    S.assignments.set(row.id, {
      id: row.id,
      moduleId: row.module_id,
      studentId: row.tutee_id,
      tutorId: row.assigned_by,
      due: row.due_date || ''
    });
  }

  function putSubmission(row) {
    S.subs.set(subKey(row.tutee_id, row.problem_id), {
      answer: row.answer == null ? '' : row.answer,
      correct: !!row.is_correct
    });
  }

  // Rows come from error_log_view, which carries the problem and module the
  // entry points at. The view decides who may see what, so whatever arrives
  // here is already scoped to the caller.
  function putErrorEntry(row) {
    S.errors.set(row.id, {
      id: row.id,
      tuteeId: row.tutee_id,
      problemId: row.problem_id,
      moduleId: row.module_id,
      moduleTitle: row.module_title || '\u2014',
      moduleSubject: row.module_subject || '',
      question: row.question || '',
      type: row.type,
      choices: Array.isArray(row.choices) ? row.choices : [],
      correctAnswer: row.correct_answer == null ? '' : row.correct_answer,
      explanation: row.explanation == null ? '' : row.explanation,
      givenAnswer: row.given_answer == null ? '' : row.given_answer,
      comment: row.comment == null ? '' : row.comment,
      resolved: !!row.resolved,
      createdAt: row.created_at
    });
  }

  // ---- loading ------------------------------------------------------------

  const rows = (res, where) => {
    if (res && res.error) throw fail(where, res.error);
    return (res && res.data) || [];
  };
  const NONE = Promise.resolve({ data: [], error: null });

  async function loadTutee(id) {
    const [linkRes, asgRes] = await Promise.all([
      sb.from('tutor_tutees').select('*').eq('tutee_id', id),
      sb.from('assignments').select('*').eq('tutee_id', id)
    ]);
    S.links = rows(linkRes, 'tutor_tutees');
    const asg = rows(asgRes, 'assignments');
    asg.forEach(putAssignment);

    const tutorIds = S.links.map((l) => l.tutor_id);
    const moduleIds = Array.from(new Set(asg.map((a) => a.module_id)));

    const [profRes, modRes, probRes, keyRes, subRes, errRes] = await Promise.all([
      tutorIds.length ? sb.from('profiles').select('*').in('id', tutorIds) : NONE,
      moduleIds.length ? sb.from('modules').select('*').in('id', moduleIds) : NONE,
      moduleIds.length ? sb.from('problems_public').select('*').in('module_id', moduleIds) : NONE,
      sb.from('revealed_answers').select('*'),
      sb.from('submissions').select('*').eq('tutee_id', id),
      // Unfiltered on purpose: the view returns only this tutee's own rows,
      // and it keeps entries whose module has since been unassigned.
      sb.from('error_log_view').select('*')
    ]);

    rows(profRes, 'profiles').forEach(putUser);
    rows(modRes, 'modules').forEach(putModule);
    putProblems(rows(probRes, 'problems_public'));
    applyRevealed(rows(keyRes, 'revealed_answers'));
    rows(subRes, 'submissions').forEach(putSubmission);
    rows(errRes, 'error_log_view').forEach(putErrorEntry);
  }

  async function loadTutor(id) {
    const linkRes = await sb.from('tutor_tutees').select('*').eq('tutor_id', id);
    S.links = rows(linkRes, 'tutor_tutees');
    const tuteeIds = S.links.map((l) => l.tutee_id);

    const [profRes, modRes, probRes, asgRes, subRes, errRes] = await Promise.all([
      tuteeIds.length ? sb.from('profiles').select('*').in('id', tuteeIds) : NONE,
      sb.from('modules').select('*').order('created_at'),
      sb.from('problems').select('*'),
      tuteeIds.length ? sb.from('assignments').select('*').in('tutee_id', tuteeIds) : NONE,
      tuteeIds.length ? sb.from('submissions').select('*').in('tutee_id', tuteeIds) : NONE,
      // The view already restricts a tutor to their own tutees.
      sb.from('error_log_view').select('*')
    ]);

    rows(profRes, 'profiles').forEach(putUser);
    rows(modRes, 'modules').forEach(putModule);
    putProblems(rows(probRes, 'problems'));
    rows(asgRes, 'assignments').forEach(putAssignment);
    rows(subRes, 'submissions').forEach(putSubmission);
    rows(errRes, 'error_log_view').forEach(putErrorEntry);
  }

  async function loadAdmin() {
    const [profRes, linkRes, modRes, probRes, asgRes, subRes, errRes] = await Promise.all([
      sb.from('profiles').select('*').order('created_at'),
      sb.from('tutor_tutees').select('*'),
      sb.from('modules').select('*').order('created_at'),
      sb.from('problems').select('*'),
      sb.from('assignments').select('*'),
      sb.from('submissions').select('*'),
      sb.from('error_log_view').select('*')
    ]);

    rows(profRes, 'profiles').forEach(putUser);
    S.links = rows(linkRes, 'tutor_tutees');
    rows(modRes, 'modules').forEach(putModule);
    putProblems(rows(probRes, 'problems'));
    rows(asgRes, 'assignments').forEach(putAssignment);
    rows(subRes, 'submissions').forEach(putSubmission);
    rows(errRes, 'error_log_view').forEach(putErrorEntry);
  }

  let loading = null;
  function load() {
    if (loading) return loading;
    loading = (async () => {
      const { data: userData } = await sb.auth.getUser();
      const user = userData && userData.user;
      if (!user) { clear(); return null; }

      const profRes = await sb.from('profiles').select('*').eq('id', user.id).maybeSingle();
      if (profRes.error) throw fail('profiles', profRes.error);
      if (!profRes.data) {
        clear();
        await sb.auth.signOut();
        toast('That account has no profile yet. Ask an admin to create it.');
        return null;
      }

      clear();
      putUser(profRes.data);
      S.meId = profRes.data.id;

      if (profRes.data.role === 'tutee') await loadTutee(user.id);
      else if (profRes.data.role === 'tutor') await loadTutor(user.id);
      else await loadAdmin();

      S.loaded = true;
      return S.users.get(S.meId);
    })().catch((err) => {
      fail('load', err);
      return null;
    }).finally(() => { loading = null; });
    return loading;
  }

  // ---- auth ---------------------------------------------------------------

  const auth = {
    // Tutees never get a password: they receive a one-time link, and only if
    // an admin already created the account.
    async signInStudent(email) {
      const { error } = await sb.auth.signInWithOtp({
        email: String(email || '').trim(),
        options: { shouldCreateUser: false }
      });
      if (error) throw error;
    },

    // Admins type a full email; tutors type a bare username that expands to
    // the synthetic address the Edge Function created them under.
    async signInTutor(identifier, secret) {
      const id = String(identifier || '').trim();
      const email = id.indexOf('@') >= 0 ? id : id.toLowerCase() + '@' + TUTOR_DOMAIN;
      const { error } = await sb.auth.signInWithPassword({ email, password: String(secret || '') });
      if (error) throw error;
    },

    async signOut() {
      await sb.auth.signOut();
      clear();
      notify();
    }
  };

  // Already holding this user's data? Then a repeat event (INITIAL_SESSION
  // arriving after boot, or a token refresh) needs no refetch.
  const settled = (session) =>
    !!(session && session.user && S.meId === session.user.id && S.loaded);

  const done = () => { S.booting = false; notify(); };

  let started = false;
  let booted = null;
  function init() {
    if (started) return booted;
    started = true;

    // Exactly one auth listener for the whole app. SIGNED_IN routes into the
    // dashboard, SIGNED_OUT drops back to the login card; both go through the
    // same load()/notify() path the initial boot uses.
    sb.auth.onAuthStateChange((event, session) => {
      if (!session) { clear(); done(); return; }
      if (settled(session)) { done(); return; }
      load().then(done);
    });

    // Resolve the stored session before the UI commits to a screen. Everything
    // renders the splash until this settles.
    booted = sb.auth.getSession()
      .then(({ data, error }) => {
        if (error) fail('getSession', error);
        const session = data && data.session;
        if (!session) { clear(); return null; }
        return load();
      })
      .catch((err) => { fail('init', err); return null; })
      .then((me) => { done(); return me; });

    return booted;
  }

  // ---- mutations ----------------------------------------------------------

  async function createModule(patch) {
    const m = {
      id: uuid(),
      title: patch.title,
      subject: patch.subject || 'General',
      description: '',
      slug: '',
      problems: []
    };
    S.modules.set(m.id, m);
    notify();
    // slug is left to the trigger, which derives it from the title.
    const { error } = await sb.from('modules').insert({
      id: m.id, title: m.title, subject: m.subject
    });
    if (error) {
      S.modules.delete(m.id);
      notify();
      // The slug is unique, so two modules cannot share a title. Say that
      // rather than passing the constraint name through to a toast.
      if (error.code === '23505') {
        throw fail('createModule', { message: 'A module called \u201c' + m.title + '\u201d already exists.' });
      }
      throw fail('createModule', error);
    }
    return m;
  }

  async function updateModule(id, patch) {
    const m = S.modules.get(id);
    if (!m) return null;
    const before = { title: m.title, subject: m.subject };
    Object.assign(m, patch);
    notify();
    const { error } = await sb.from('modules')
      .update({ title: m.title, subject: m.subject }).eq('id', id);
    if (error) { Object.assign(m, before); notify(); throw fail('updateModule', error); }
    return m;
  }

  async function saveProblem(moduleId, problem) {
    const m = S.modules.get(moduleId);
    if (!m) return null;
    const before = m.problems.slice();
    const isNew = !problem.id;
    const id = problem.id || uuid();
    const idx = isNew ? -1 : m.problems.findIndex((p) => p.id === id);
    const sortOrder = idx >= 0 ? m.problems[idx].sortOrder : m.problems.length;

    const next = {
      id: id,
      type: problem.type,
      text: problem.text,
      choices: problem.type === 'mc' ? (problem.choices || []) : [],
      answer: problem.answer == null ? '' : problem.answer,
      explanation: problem.explanation || '',
      sortOrder: sortOrder
    };
    if (idx >= 0) m.problems[idx] = next; else m.problems.push(next);
    notify();

    const { error } = await sb.from('problems').upsert({
      id: next.id,
      module_id: moduleId,
      question: next.text,
      type: next.type,
      choices: next.type === 'mc' ? next.choices : null,
      answer: next.answer,
      explanation: next.explanation,
      sort_order: next.sortOrder
    });
    if (error) { m.problems = before; notify(); throw fail('saveProblem', error); }
    return next;
  }

  async function deleteProblem(moduleId, problemId) {
    const m = S.modules.get(moduleId);
    if (!m) return;
    const before = m.problems.slice();
    m.problems = m.problems.filter((p) => p.id !== problemId);
    notify();
    const { error } = await sb.from('problems').delete().eq('id', problemId);
    if (error) { m.problems = before; notify(); throw fail('deleteProblem', error); }
  }

  // Admin only, and the cascade is wide: problems, assignments, submissions and
  // error log entries all go with it. The counts shown in the confirmation come
  // from moduleDeleteCounts() rather than from this cache.
  async function deleteModule(id) {
    const m = S.modules.get(id);
    if (!m) return;
    const problemIds = new Set(m.problems.map((p) => p.id));
    const asg = Array.from(S.assignments.values()).filter((a) => a.moduleId === id);
    const errs = Array.from(S.errors.values()).filter((e) => e.moduleId === id);
    const subs = [];
    S.subs.forEach((v, k) => { if (problemIds.has(k.slice(k.indexOf(':') + 1))) subs.push([k, v]); });

    S.modules.delete(id);
    asg.forEach((a) => S.assignments.delete(a.id));
    errs.forEach((e) => S.errors.delete(e.id));
    subs.forEach(([k]) => S.subs.delete(k));
    notify();

    const { error } = await sb.from('modules').delete().eq('id', id);
    if (error) {
      S.modules.set(id, m);
      asg.forEach((a) => S.assignments.set(a.id, a));
      errs.forEach((e) => S.errors.set(e.id, e));
      subs.forEach(([k, v]) => S.subs.set(k, v));
      notify();
      throw fail('deleteModule', error);
    }
  }

  async function moduleDeleteCounts(id) {
    const { data, error } = await sb.rpc('module_delete_counts', { p_module: id });
    if (error) throw fail('moduleDeleteCounts', error);
    const row = Array.isArray(data) ? data[0] : data;
    return {
      problems: (row && Number(row.problems)) || 0,
      assignments: (row && Number(row.assignments)) || 0,
      submissions: (row && Number(row.submissions)) || 0,
      errors: (row && Number(row.error_log_entries)) || 0
    };
  }

  async function assignModule(spec) {
    const made = [];
    const payload = [];
    (spec.studentIds || []).forEach((sid) => {
      const dup = Array.from(S.assignments.values())
        .some((a) => a.moduleId === spec.moduleId && a.studentId === sid);
      if (dup) return;
      const id = uuid();
      made.push({ id: id, moduleId: spec.moduleId, studentId: sid, tutorId: spec.tutorId, due: spec.due || '' });
      payload.push({
        id: id,
        tutee_id: sid,
        module_id: spec.moduleId,
        assigned_by: spec.tutorId,
        due_date: spec.due || null
      });
    });
    if (!made.length) return made;

    made.forEach((a) => S.assignments.set(a.id, a));
    notify();
    const { error } = await sb.from('assignments').insert(payload);
    if (error) {
      made.forEach((a) => S.assignments.delete(a.id));
      notify();
      throw fail('assignModule', error);
    }
    return made;
  }

  // Takes the module off a tutee's list. Submissions are deliberately left
  // alone: the work they did still happened, and their error log entries point
  // at problems, not at the assignment.
  async function unassign(assignmentId) {
    const a = S.assignments.get(assignmentId);
    if (!a) return;
    S.assignments.delete(assignmentId);
    notify();
    const { error } = await sb.from('assignments').delete().eq('id', assignmentId);
    if (error) { S.assignments.set(assignmentId, a); notify(); throw fail('unassign', error); }
  }

  // Grading happens in Postgres: the tutee's client never sees the answer key
  // until the RPC hands it back.
  async function submitAnswer(assignmentId, problemId, answer) {
    const a = S.assignments.get(assignmentId);
    if (!a) return null;
    const { data, error } = await sb.rpc('submit_answer', {
      p_problem_id: problemId,
      p_answer: answer
    });
    if (error) throw fail('submitAnswer', error);

    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return null;

    S.subs.set(subKey(a.studentId, problemId), { answer: answer, correct: !!row.is_correct });
    const m = S.modules.get(a.moduleId);
    const p = m && m.problems.find((x) => x.id === problemId);
    if (p) {
      p.answer = row.correct_answer == null ? '' : row.correct_answer;
      p.explanation = row.explanation == null ? '' : row.explanation;
    }
    notify();
    return { correct: !!row.is_correct, explanation: row.explanation, correctAnswer: row.correct_answer };
  }

  // Goes through the Edge Function: creating an auth user needs the service
  // role key, which must never reach the browser.
  async function createUser(u) {
    const { data } = await sb.auth.getSession();
    const session = data && data.session;
    if (!session) throw new Error('Your session expired — sign in again.');

    const kind = dbRole(u.role) === 'tutor' ? 'tutor' : 'tutee';
    const body = { kind: kind, display_name: u.name };
    if (kind === 'tutor') {
      body.username = u.username;
      body.pin = u.pin;
    } else {
      body.email = u.email;
      if (u.tutorId) body.tutor_id = u.tutorId;
    }

    const res = await fetch(cfg.SUPABASE_URL + '/functions/v1/create-user', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: cfg.SUPABASE_ANON_KEY,
        Authorization: 'Bearer ' + session.access_token
      },
      body: JSON.stringify(body)
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || ('Could not create the account (' + res.status + ').'));

    await load();
    notify();
    return out.id;
  }

  async function linkStudent(studentId, tutorId) {
    const before = S.links.slice();
    S.links = S.links.filter((l) => l.tutee_id !== studentId);
    if (tutorId) S.links.push({ tutor_id: tutorId, tutee_id: studentId });
    notify();

    const del = await sb.from('tutor_tutees').delete().eq('tutee_id', studentId);
    if (del.error) { S.links = before; notify(); throw fail('linkStudent', del.error); }
    if (tutorId) {
      const ins = await sb.from('tutor_tutees').insert({ tutor_id: tutorId, tutee_id: studentId });
      if (ins.error) { S.links = before; notify(); throw fail('linkStudent', ins.error); }
    }
  }

  // ---- error log ----------------------------------------------------------

  function findProblem(problemId) {
    let found = null;
    S.modules.forEach((m) => {
      if (found) return;
      const p = m.problems.find((x) => x.id === problemId);
      if (p) found = { module: m, problem: p };
    });
    return found;
  }

  // The RPC returns the raw table row, not the joined view, so the display
  // fields are filled from the cache the tutee is already looking at. By the
  // time this can be called they have submitted the problem, which means the
  // answer key is in that cache too.
  async function addErrorEntry(problemId, comment) {
    const { data, error } = await sb.rpc('add_error_log_entry', {
      p_problem_id: problemId,
      p_comment: comment || null
    });
    if (error) throw fail('addErrorEntry', error);
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return null;

    const hit = findProblem(problemId);
    const sub = S.subs.get(subKey(row.tutee_id, problemId));
    putErrorEntry({
      id: row.id,
      tutee_id: row.tutee_id,
      problem_id: problemId,
      submission_id: row.submission_id,
      comment: row.comment,
      resolved: row.resolved,
      created_at: row.created_at,
      module_id: hit ? hit.module.id : null,
      module_title: hit ? hit.module.title : null,
      module_subject: hit ? hit.module.subject : null,
      question: hit ? hit.problem.text : '',
      type: hit ? hit.problem.type : 'mc',
      choices: hit ? hit.problem.choices : [],
      correct_answer: hit ? hit.problem.answer : '',
      explanation: hit ? hit.problem.explanation : '',
      given_answer: sub ? sub.answer : '',
      is_correct: sub ? sub.correct : false
    });
    notify();
    return S.errors.get(row.id) || null;
  }

  async function saveErrorComment(id, comment) {
    const e = S.errors.get(id);
    if (!e) return;
    const before = e.comment;
    const next = String(comment == null ? '' : comment).trim();
    e.comment = next;
    notify();
    const { error } = await sb.from('error_log_entries')
      .update({ comment: next || null }).eq('id', id);
    if (error) { e.comment = before; notify(); throw fail('saveErrorComment', error); }
  }

  // Tutors have no UPDATE policy on the table — this RPC is the only column
  // they may move, and the tutee and admin use it too so there is one path.
  async function setErrorResolved(id, resolved) {
    const e = S.errors.get(id);
    if (!e) return;
    const before = e.resolved;
    e.resolved = !!resolved;
    notify();
    const { error } = await sb.rpc('set_error_log_resolved', {
      p_entry_id: id,
      p_resolved: !!resolved
    });
    if (error) { e.resolved = before; notify(); throw fail('setErrorResolved', error); }
  }

  async function deleteErrorEntry(id) {
    const e = S.errors.get(id);
    if (!e) return;
    S.errors.delete(id);
    notify();
    const { error } = await sb.from('error_log_entries').delete().eq('id', id);
    if (error) { S.errors.set(id, e); notify(); throw fail('deleteErrorEntry', error); }
  }

  // ---- public API (synchronous reads, same shapes as the old mock) --------

  window.db = {
    init: init,
    auth: auth,
    client: sb,
    ready: () => S.loaded,
    booting: () => S.booting,
    // Refetch everything. The importer writes straight to Supabase in bulk
    // rather than through the mutations above, so the cache has to be told
    // that the library it is holding is stale.
    reload: () => load().then((me) => { notify(); return me; }),
    onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    me: () => (S.meId ? S.users.get(S.meId) || null : null),

    getUser: (id) => S.users.get(id) || null,
    getUsers: () => Array.from(S.users.values()),

    getModules: () => Array.from(S.modules.values()),
    getModule: (id) => S.modules.get(id) || null,
    createModule: createModule,
    updateModule: updateModule,
    saveProblem: saveProblem,
    deleteProblem: deleteProblem,
    deleteModule: deleteModule,
    moduleDeleteCounts: moduleDeleteCounts,

    getAssignments: (studentId) =>
      Array.from(S.assignments.values()).filter((a) => a.studentId === studentId),
    getAssignment: (id) => S.assignments.get(id) || null,
    getTutorAssignments: (tutorId) =>
      Array.from(S.assignments.values()).filter((a) => a.tutorId === tutorId),
    assignModule: assignModule,
    unassign: unassign,

    getSubmissions: (assignmentId) => {
      const a = S.assignments.get(assignmentId);
      const m = a && S.modules.get(a.moduleId);
      const out = {};
      if (!m) return out;
      m.problems.forEach((p) => {
        const s = S.subs.get(subKey(a.studentId, p.id));
        if (s) out[p.id] = s;
      });
      return out;
    },
    submitAnswer: submitAnswer,

    getProgress: (assignmentId) => {
      const a = S.assignments.get(assignmentId);
      const m = a && S.modules.get(a.moduleId);
      const problems = m ? m.problems : [];
      let answered = 0, correct = 0;
      problems.forEach((p) => {
        const s = a && S.subs.get(subKey(a.studentId, p.id));
        if (!s) return;
        answered += 1;
        if (s.correct) correct += 1;
      });
      return { answered: answered, correct: correct, total: problems.length };
    },

    getStudentsOf: (tutorId) => S.links
      .filter((l) => l.tutor_id === tutorId)
      .map((l) => S.users.get(l.tutee_id))
      .filter(Boolean),
    tutorOf: (studentId) => {
      const link = S.links.find((l) => l.tutee_id === studentId);
      return (link && S.users.get(link.tutor_id)) || null;
    },
    createUser: createUser,
    linkStudent: linkStudent,

    // Newest first, which is the order both the tutee's tab and the tutor's
    // read-only view show.
    getErrorLog: (tuteeId) => Array.from(S.errors.values())
      .filter((e) => e.tuteeId === tuteeId)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))),
    getErrorEntry: (tuteeId, problemId) =>
      Array.from(S.errors.values())
        .find((e) => e.tuteeId === tuteeId && e.problemId === problemId) || null,
    unresolvedCount: (tuteeId) => Array.from(S.errors.values())
      .filter((e) => e.tuteeId === tuteeId && !e.resolved).length,
    addErrorEntry: addErrorEntry,
    saveErrorComment: saveErrorComment,
    setErrorResolved: setErrorResolved,
    deleteErrorEntry: deleteErrorEntry
  };

  // Start resolving the session now rather than waiting for the component to
  // mount, so a signed-in reload lands on the dashboard directly.
  init();
})();
