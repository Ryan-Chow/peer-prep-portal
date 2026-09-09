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
    sprofiles: new Map(),   // tuteeId -> UI student profile (intake sheet)
    logs: new Map(),        // id -> UI session log
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
    S.errors.clear(); S.sprofiles.clear(); S.logs.clear();
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
        // Both the table and the view expose these: they describe the
        // problem, not its answer, and the assign screen filters on them.
        tags: Array.isArray(row.tags) ? row.tags : [],
        // problems_public carries neither, so a tutee reads false and ''.
        // That is the right answer for them: flagging steers the assign
        // screen, and an already-assigned problem still has to render.
        flagged: !!row.flagged,
        flagReason: row.flag_reason || '',
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
      due: row.due_date || '',
      // The filter, resolved when the assignment was made. null problemIds is
      // an assignment over the whole module — which is what every row created
      // before filtering existed looks like.
      difficulty: row.difficulty || '',
      tagFilter: Array.isArray(row.tag_filter) ? row.tag_filter : [],
      limit: row.problem_limit || 0,
      problemIds: Array.isArray(row.problem_ids) ? row.problem_ids : null,
      label: row.label || ''
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

  // The intake sheet from the handbook. The student's name is not stored here —
  // it lives on the profile — so only the grade half of "STUDENT NAME & GRADE"
  // has a column.
  const text = (v) => (v == null ? '' : String(v));

  function putStudentProfile(row) {
    S.sprofiles.set(row.tutee_id, {
      tuteeId: row.tutee_id,
      grade: text(row.grade),
      subjects: text(row.subjects),
      startDate: text(row.start_date),
      regularSchedule: text(row.regular_schedule),
      parentContact: text(row.parent_contact),
      goals: text(row.goals),
      learningStyleNotes: text(row.learning_style_notes),
      updatedAt: row.updated_at
    });
  }

  // One session sheet. Field for field, and in the order they appear on paper.
  function putSessionLog(row) {
    S.logs.set(row.id, {
      id: row.id,
      tutorId: row.tutor_id || '',
      tuteeId: row.tutee_id,
      sessionDate: text(row.session_date),
      duration: text(row.duration),
      tutorInitials: text(row.tutor_initials),
      topicsCovered: text(row.topics_covered),
      homeworkAssigned: text(row.homework_assigned),
      // Null until the tutor marks one of the five. Kept as a number so the UI
      // can compare it to the radio it is rendering.
      progressRating: row.progress_rating == null ? null : Number(row.progress_rating),
      struggles: text(row.struggles),
      parentCommunication: text(row.parent_communication),
      paymentStatus: text(row.payment_status),
      status: row.status === 'submitted' ? 'submitted' : 'draft',
      createdAt: row.created_at,
      updatedAt: row.updated_at
    });
  }

  // ---- loading ------------------------------------------------------------

  const rows = (res, where) => {
    if (res && res.error) throw fail(where, res.error);
    return (res && res.data) || [];
  };
  const NONE = Promise.resolve({ data: [], error: null });
  const NO_ROWS = Promise.resolve([]);

  // PostgREST caps a select at db-max-rows — 1,000 by default — and says
  // nothing when it does: a truncated read looks like a full page of rows and
  // no error. Anything that grows with the library, the roster or usage is read
  // a page at a time instead, until a short page proves the end was reached.
  //
  // Returns rows, not a response: the error unwrapping already happened.
  //
  // opts.order  columns giving a total order, ending in a unique one. Paging
  //             over a non-unique order lets rows shift between pages as the
  //             window advances, which repeats some and drops others — the same
  //             silent wrong answer, harder to see.
  // opts.filter narrows every page the same way.
  const PAGE = 1000;

  // Modules and profiles are displayed in the order they come back — the Map
  // each is read into keeps insertion order, and the library and the roster
  // show it — so they keep ordering by created_at rather than reordering
  // themselves by primary key. created_at is not unique, hence the tiebreak.
  const CREATED_ORDER = ['created_at', 'id'];

  async function allRows(table, opts) {
    const order = (opts && opts.order) || ['id'];
    const out = [];
    for (let from = 0; ; from += PAGE) {
      let q = sb.from(table).select('*');
      order.forEach((col) => { q = q.order(col); });
      if (opts && opts.filter) q = opts.filter(q);
      const batch = rows(await q.range(from, from + PAGE - 1), table);
      out.push.apply(out, batch);
      if (batch.length < PAGE) return out;
    }
  }

  async function loadTutee(id) {
    // A tutee has at most one tutor — tutor_tutees has a unique index on
    // tutee_id — so that read is one row by construction. The assignment list
    // only grows, and everything below is scoped by it, so it is paged even
    // though reaching a thousand would take years.
    const [linkRes, asg] = await Promise.all([
      sb.from('tutor_tutees').select('*').eq('tutee_id', id),
      allRows('assignments', { filter: (q) => q.eq('tutee_id', id) })
    ]);
    S.links = rows(linkRes, 'tutor_tutees');
    asg.forEach(putAssignment);

    const tutorIds = S.links.map((l) => l.tutor_id);
    const moduleIds = Array.from(new Set(asg.map((a) => a.module_id)));

    // Both id lists are bounded by this tutee's own assignments, so those two
    // reads cannot run long. The rest can: a handful of assigned modules is
    // already more than a thousand problems.
    // No session_logs read here: the log is the tutor's write-up for staff, and
    // RLS no longer returns it to a tutee. Asking anyway would just cost a
    // round trip to be handed an empty list.
    const [profRes, modRes, probs, revealed, subs, errors, sprofs] = await Promise.all([
      tutorIds.length ? sb.from('profiles').select('*').in('id', tutorIds) : NONE,
      moduleIds.length ? sb.from('modules').select('*').in('id', moduleIds) : NONE,
      moduleIds.length ? allRows('problems_public', { filter: (q) => q.in('module_id', moduleIds) }) : NO_ROWS,
      allRows('revealed_answers'),
      allRows('submissions', { filter: (q) => q.eq('tutee_id', id) }),
      // Unfiltered on purpose: the view returns only this tutee's own rows,
      // and it keeps entries whose module has since been unassigned.
      allRows('error_log_view'),
      // At most one row, but the filter costs nothing and says what is meant.
      allRows('student_profiles', { order: ['tutee_id'], filter: (q) => q.eq('tutee_id', id) })
    ]);

    rows(profRes, 'profiles').forEach(putUser);
    rows(modRes, 'modules').forEach(putModule);
    putProblems(probs);
    applyRevealed(revealed);
    subs.forEach(putSubmission);
    errors.forEach(putErrorEntry);
    sprofs.forEach(putStudentProfile);
  }

  async function loadTutor(id) {
    const linkRes = await sb.from('tutor_tutees').select('*').eq('tutor_id', id);
    S.links = rows(linkRes, 'tutor_tutees');
    const tuteeIds = S.links.map((l) => l.tutee_id);

    // A tutor reads the whole library — every module and every problem in it,
    // not just what they have assigned — so this is the read that first outgrew
    // one page.
    const [profRes, mods, probs, asg, subs, errors, sprofs, logs] = await Promise.all([
      tuteeIds.length ? sb.from('profiles').select('*').in('id', tuteeIds) : NONE,
      allRows('modules', { order: CREATED_ORDER }),
      allRows('problems'),
      tuteeIds.length ? allRows('assignments', { filter: (q) => q.in('tutee_id', tuteeIds) }) : NO_ROWS,
      tuteeIds.length ? allRows('submissions', { filter: (q) => q.in('tutee_id', tuteeIds) }) : NO_ROWS,
      // The view already restricts a tutor to their own tutees.
      allRows('error_log_view'),
      // No id column here — the key is tutee_id, which is unique by definition.
      allRows('student_profiles', { order: ['tutee_id'] }),
      // Unfiltered rather than .in(tuteeIds): the policy also returns logs this
      // tutor wrote for a tutee since reassigned, and those must not vanish from
      // their own Session Logs screen.
      allRows('session_logs')
    ]);

    rows(profRes, 'profiles').forEach(putUser);
    mods.forEach(putModule);
    putProblems(probs);
    asg.forEach(putAssignment);
    subs.forEach(putSubmission);
    errors.forEach(putErrorEntry);
    sprofs.forEach(putStudentProfile);
    logs.forEach(putSessionLog);
  }

  async function loadAdmin() {
    // Every one of these is the whole table, unfiltered.
    const [profs, links, mods, probs, asg, subs, errors, sprofs, logs] = await Promise.all([
      allRows('profiles', { order: CREATED_ORDER }),
      // No id column on this one: the primary key is (tutor_id, tutee_id), and
      // a tutee has at most one tutor, so tutee_id alone is a total order.
      allRows('tutor_tutees', { order: ['tutee_id'] }),
      allRows('modules', { order: CREATED_ORDER }),
      allRows('problems'),
      allRows('assignments'),
      allRows('submissions'),
      allRows('error_log_view'),
      allRows('student_profiles', { order: ['tutee_id'] }),
      allRows('session_logs')
    ]);

    profs.forEach(putUser);
    S.links = links;
    mods.forEach(putModule);
    putProblems(probs);
    asg.forEach(putAssignment);
    subs.forEach(putSubmission);
    errors.forEach(putErrorEntry);
    sprofs.forEach(putStudentProfile);
    logs.forEach(putSessionLog);
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
    // Tutees sign in with the email on file plus a PIN an admin set for them.
    // Lowercased because Supabase folds addresses on the way in, so a tutee
    // typing their own address capitalised would otherwise miss their account.
    async signInStudent(email, pin) {
      const { error } = await sb.auth.signInWithPassword({
        email: String(email || '').trim().toLowerCase(),
        password: String(pin || '')
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

    // "Calculator allowed" is the editor's only tag control, so it rewrites
    // exactly one member of the array and carries the rest — the difficulty,
    // the topic labels the import wrote — through untouched. Without that
    // filter-and-concat, saving an unrelated edit would quietly drop every
    // tag the assign screen filters on.
    const priorTags = (idx >= 0 ? m.problems[idx].tags : null) || [];
    const tags = problem.calculator == null
      ? priorTags.slice()
      : priorTags.filter((t) => !isCalculator(t)).concat(problem.calculator ? [CALC_TAG] : []);

    const next = {
      id: id,
      type: problem.type,
      text: problem.text,
      choices: problem.type === 'mc' ? (problem.choices || []) : [],
      answer: problem.answer == null ? '' : problem.answer,
      explanation: problem.explanation || '',
      tags: tags,
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
      // null rather than [], matching what the importer writes, so the two
      // paths cannot leave the same "no tags" state looking like two.
      tags: next.tags.length ? next.tags : null,
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

  // ---- flagged problems ---------------------------------------------------

  // Every flagged problem in the library, module title carried along, because
  // the screen that lists them is not inside any one module.
  function flaggedProblems() {
    const out = [];
    S.modules.forEach((m) => {
      m.problems.forEach((p) => {
        if (p.flagged) out.push(Object.assign({ moduleId: m.id, moduleTitle: m.title }, p));
      });
    });
    return out;
  }

  function flaggedCount() {
    let n = 0;
    S.modules.forEach((m) => m.problems.forEach((p) => { if (p.flagged) n++; }));
    return n;
  }

  // Finds a problem by id alone. The flagged list spans modules, so the screen
  // acting on it has an id and no module to look in.
  function findProblem(problemId) {
    let hit = null;
    S.modules.forEach((m) => {
      if (hit) return;
      const p = m.problems.find((x) => x.id === problemId);
      if (p) hit = { module: m, problem: p };
    });
    return hit;
  }

  // Unflagging keeps flag_reason. It is the record that this problem was
  // looked at once and judged fine, and every sweep — 006, 007, and the rescan
  // button — skips a row that has one, so nothing can flag it all over again.
  async function setProblemsFlagged(problemIds, flagged) {
    const ids = (problemIds || []).filter(Boolean);
    if (!ids.length) return;
    const hits = ids.map(findProblem).filter(Boolean);
    const before = hits.map((h) => h.problem.flagged);
    hits.forEach((h) => { h.problem.flagged = !!flagged; });
    notify();

    const { error } = await sb.from('problems').update({ flagged: !!flagged }).in('id', ids);
    if (error) {
      hits.forEach((h, i) => { h.problem.flagged = before[i]; });
      notify();
      throw fail('setProblemsFlagged', error);
    }
  }

  // Re-runs the figure detector (007) over the whole library and returns how
  // many rows it newly flagged. The importer does not run it, so this is what
  // catches a batch that has just come in.
  //
  // A reload rather than a local patch: the sweep decides server-side which
  // rows it touched and does not say which, so the cache has no way to apply
  // the same change to itself.
  async function rescanFigures() {
    const { data, error } = await sb.rpc('flag_missing_figures');
    if (error) throw fail('rescanFigures', error);
    await load();
    notify();
    return Number(data) || 0;
  }

  // Deleting cascades to submissions and error log entries (004), and the ids
  // stay behind in the problem_ids of any assignment that named them — where
  // they are inert, because assignmentProblems() resolves ids against the
  // module and a deleted problem is no longer in it.
  async function deleteProblems(problemIds) {
    const ids = (problemIds || []).filter(Boolean);
    if (!ids.length) return;
    const gone = new Set(ids);
    const touched = [];
    S.modules.forEach((m) => {
      if (m.problems.some((p) => gone.has(p.id))) {
        touched.push([m, m.problems.slice()]);
        m.problems = m.problems.filter((p) => !gone.has(p.id));
      }
    });
    notify();

    const { error } = await sb.from('problems').delete().in('id', ids);
    if (error) {
      touched.forEach(([m, list]) => { m.problems = list; });
      notify();
      throw fail('deleteProblems', error);
    }
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

  // ---- assignment filters -------------------------------------------------

  // Difficulty is a tag, not a column: 'easy' | 'medium' | 'hard' sitting in
  // problems.tags among the topic labels. The importer stores it lower case,
  // but a tag typed by hand may not be, so every comparison here folds case.
  const DIFFICULTIES = ['easy', 'medium', 'hard'];
  const lower = (t) => String(t == null ? '' : t).trim().toLowerCase();
  const isDifficulty = (t) => DIFFICULTIES.indexOf(lower(t)) >= 0;

  // 'calculator' rides in the same array but is not a topic either: it says
  // what a tutee may open on the problem screen. Same lower-case storage and
  // same case-folded comparison as difficulty, for the same reason — a tag
  // typed by hand in the editor may be capitalised.
  const CALC_TAG = 'calculator';
  const isCalculator = (t) => lower(t) === CALC_TAG;
  const hasCalculator = (p) => ((p && p.tags) || []).some(isCalculator);

  // Whether the problem screen offers the Desmos panel. Two ways to earn it —
  // the module is SAT Math, where a calculator is allowed throughout, or the
  // single problem is tagged — and one way to lose it that beats both: a
  // Reading and Writing module never gets one, whatever a problem inside it
  // was tagged, because there the calculator is not a tool but a distraction
  // somebody mislabelled.
  const READING_RE = /\b(reading|writing)\b/;
  function calculatorAllowed(module, problem) {
    const subject = lower(module && module.subject);
    if (READING_RE.test(subject)) return false;
    return subject === 'sat math' || hasCalculator(problem);
  }

  // The topic tags a tutor can filter a module by, difficulty and the
  // calculator flag excluded — neither is a topic, and offering "calculator"
  // in the topic list would let a tutor build an assignment out of the
  // question of which tool is allowed. Flagged problems are skipped here too,
  // or a tag carried only by flagged problems would be offered as a filter
  // that matches nothing.
  function moduleTags(moduleId) {
    const m = S.modules.get(moduleId);
    const seen = new Map();
    if (m) {
      m.problems.forEach((p) => {
        if (p.flagged) return;
        (p.tags || []).forEach((t) => {
          if (!t || isDifficulty(t) || isCalculator(t)) return;
          if (!seen.has(lower(t))) seen.set(lower(t), t);
        });
      });
    }
    return Array.from(seen.values()).sort((a, b) => String(a).localeCompare(String(b)));
  }

  // Everything in the module the filter reaches, in module order. Tags are
  // "any of", not "all of": picking two topics widens the pool.
  //
  // A flagged problem is one nobody can answer — the figure it asks about was
  // never imported — so it is out of every pool this builds, and out of the
  // random draw taken from that pool. Assignments already made are untouched:
  // 003 froze their problem_ids, and assignmentProblems() reads those.
  function matchProblems(moduleId, filter) {
    const m = S.modules.get(moduleId);
    if (!m) return [];
    const want = ((filter && filter.tags) || []).map(lower).filter(Boolean);
    const level = lower(filter && filter.difficulty);
    return m.problems.filter((p) => {
      if (p.flagged) return false;
      const tags = (p.tags || []).map(lower);
      if (level && tags.indexOf(level) < 0) return false;
      if (want.length && !want.some((t) => tags.indexOf(t) >= 0)) return false;
      return true;
    });
  }

  // Fisher-Yates over mulberry32. Seeded rather than Math.random so the draw
  // is a property of the assignment id and can be re-derived from the stored
  // row; the ids are written down anyway, this just makes them explicable.
  function pickSome(list, n, seedText) {
    let h = 2166136261;
    String(seedText).split('').forEach((c) => {
      h = Math.imul(h ^ c.charCodeAt(0), 16777619);
    });
    let s = h >>> 0;
    const out = list.slice();
    for (let i = out.length - 1; i > 0; i--) {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      const j = ((t ^ (t >>> 14)) >>> 0) % (i + 1);
      const tmp = out[i]; out[i] = out[j]; out[j] = tmp;
    }
    // Back into module order: the selection is random, the numbering the tutee
    // sees should not be.
    return out.slice(0, n).sort((a, b) => list.indexOf(a) - list.indexOf(b));
  }

  // What the assignment is called once it is no longer just the module —
  // "Information and Ideas — Hard (10 random)". Written here rather than in
  // the UI so the stored label and the tutor's preview cannot drift apart.
  function describeFilter(moduleId, filter, take) {
    const m = S.modules.get(moduleId);
    const parts = [];
    const level = lower(filter && filter.difficulty);
    if (level) parts.push(level.charAt(0).toUpperCase() + level.slice(1));
    const tags = ((filter && filter.tags) || []).filter(Boolean);
    if (tags.length) parts.push(tags.join(', '));
    return (m ? m.title : 'Module') +
      (parts.length ? ' \u2014 ' + parts.join(' \u2014 ') : '') +
      (take ? ' (' + take + ' random)' : '');
  }

  // The problems this assignment actually covers. A null problemIds is an
  // assignment over the whole module, which is what everything created before
  // filtering existed looks like.
  function assignmentProblems(a) {
    const m = a && S.modules.get(a.moduleId);
    if (!m) return [];
    if (!a.problemIds) return m.problems;
    const want = new Set(a.problemIds);
    return m.problems.filter((p) => want.has(p.id));
  }

  // Assign a slice of a module rather than all of it. The filter is resolved
  // here, once, and only the resulting ids are stored: a module reworded or
  // retagged next month cannot change what a tutee was asked to do, and cannot
  // quietly add problems to an assignment they have half finished.
  //
  // spec: { moduleId, studentIds, tutorId, due, difficulty, tags, limit }
  async function assignModule(spec) {
    const m = S.modules.get(spec.moduleId);
    if (!m) return [];
    const filter = {
      difficulty: spec.difficulty || '',
      tags: (spec.tags || []).slice(),
      limit: Number(spec.limit) || 0
    };
    const pool = matchProblems(spec.moduleId, filter);
    if (!pool.length) {
      throw fail('assignModule', { message: 'Nothing in \u201c' + m.title + '\u201d matches those options.' });
    }
    // Asking for more than there are is not an error; it just means everything
    // matched, and the label should not claim a random draw that never happened.
    const take = filter.limit && filter.limit < pool.length ? filter.limit : 0;
    const narrowed = !!(filter.difficulty || filter.tags.length || filter.limit);
    const label = describeFilter(spec.moduleId, filter, take);

    const made = [];
    const payload = [];
    (spec.studentIds || []).forEach((sid) => {
      const id = uuid();
      // Seeded on the assignment id, so the draw is reproducible from the row
      // and two tutees given the same filter get different questions.
      const chosen = take ? pickSome(pool, take, id) : pool;
      const problemIds = narrowed ? chosen.map((p) => p.id) : null;
      made.push({
        id: id, moduleId: spec.moduleId, studentId: sid, tutorId: spec.tutorId,
        due: spec.due || '',
        difficulty: filter.difficulty, tagFilter: filter.tags, limit: filter.limit,
        problemIds: problemIds, label: label
      });
      payload.push({
        id: id,
        tutee_id: sid,
        module_id: spec.moduleId,
        assigned_by: spec.tutorId,
        due_date: spec.due || null,
        difficulty: filter.difficulty || null,
        tag_filter: filter.tags.length ? filter.tags : null,
        problem_limit: filter.limit || null,
        problem_ids: problemIds,
        label: label
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

  // Anything that touches the auth schema goes through the Edge Function:
  // creating a user and setting a password both need the service role key,
  // which must never reach the browser. The admin's own access token is what
  // the function checks the caller against.
  async function callAdminFn(body, fallbackMsg) {
    const { data } = await sb.auth.getSession();
    const session = data && data.session;
    if (!session) throw new Error('Your session expired — sign in again.');

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
    if (!res.ok) throw new Error(out.error || (fallbackMsg + ' (' + res.status + ').'));
    return out;
  }

  async function createUser(u) {
    const kind = dbRole(u.role) === 'tutor' ? 'tutor' : 'tutee';
    const body = { kind: kind, display_name: u.name, pin: u.pin };
    if (kind === 'tutor') {
      body.username = u.username;
    } else {
      body.email = u.email;
      if (u.tutorId) body.tutor_id = u.tutorId;
    }

    const out = await callAdminFn(body, 'Could not create the account');
    await load();
    notify();
    return out.id;
  }

  // No cache reload afterwards: Supabase keeps only the hash, so there is
  // nothing about the new PIN for the roster to display.
  async function setPin(userId, pin) {
    await callAdminFn({ action: 'set_pin', user_id: userId, pin: pin }, 'Could not set the PIN');
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

  // ---- session logs -------------------------------------------------------

  const blankProfile = (tuteeId) => ({
    tuteeId: tuteeId, grade: '', subjects: '', startDate: '', regularSchedule: '',
    parentContact: '', goals: '', learningStyleNotes: '', updatedAt: null
  });

  // Empty strings go to Postgres as null rather than '', so "not filled in" has
  // one representation and the profile-complete check has one thing to test.
  const orNull = (v) => {
    const t = String(v == null ? '' : v).trim();
    return t === '' ? null : t;
  };

  // Upsert rather than insert-or-update: the tutor has no way to know whether a
  // row exists, and tutee_id is the primary key.
  async function saveStudentProfile(tuteeId, patch) {
    const before = S.sprofiles.get(tuteeId) || null;
    const next = Object.assign(blankProfile(tuteeId), before || {}, patch, { tuteeId: tuteeId });
    S.sprofiles.set(tuteeId, next);
    notify();

    const { error } = await sb.from('student_profiles').upsert({
      tutee_id: tuteeId,
      grade: orNull(next.grade),
      subjects: orNull(next.subjects),
      start_date: orNull(next.startDate),
      regular_schedule: orNull(next.regularSchedule),
      parent_contact: orNull(next.parentContact),
      goals: orNull(next.goals),
      learning_style_notes: orNull(next.learningStyleNotes)
    });
    if (error) {
      if (before) S.sprofiles.set(tuteeId, before); else S.sprofiles.delete(tuteeId);
      notify();
      throw fail('saveStudentProfile', error);
    }
    return next;
  }

  // The columns behind the paper sheet, in sheet order. One place, so the
  // insert, the update and the CSV export cannot drift out of step.
  const logColumns = (log) => ({
    session_date: log.sessionDate || null,
    duration: orNull(log.duration),
    tutor_initials: orNull(log.tutorInitials),
    topics_covered: orNull(log.topicsCovered),
    homework_assigned: orNull(log.homeworkAssigned),
    progress_rating: log.progressRating == null || log.progressRating === '' ? null : Number(log.progressRating),
    struggles: orNull(log.struggles),
    parent_communication: orNull(log.parentCommunication),
    payment_status: orNull(log.paymentStatus),
    status: log.status === 'submitted' ? 'submitted' : 'draft'
  });

  // Creates on a missing id, updates on a present one. `status` rides in the
  // patch, so submitting is just a save that sets it — the same call the
  // "Submit" button and the "Save draft" button both make.
  async function saveSessionLog(patch) {
    const id = patch.id || uuid();
    const before = patch.id ? S.logs.get(patch.id) : null;
    if (patch.id && !before) return null;

    const next = Object.assign({
      id: id,
      tutorId: S.meId,
      tuteeId: patch.tuteeId,
      sessionDate: '', duration: '', tutorInitials: '', topicsCovered: '',
      homeworkAssigned: '', progressRating: null, struggles: '',
      parentCommunication: '', paymentStatus: '', status: 'draft',
      createdAt: new Date().toISOString(), updatedAt: null
    }, before || {}, patch, { id: id });

    S.logs.set(id, next);
    notify();

    const row = Object.assign(logColumns(next), {
      id: id,
      tutee_id: next.tuteeId,
      // Pinned by the insert policy to the caller anyway; sent explicitly so an
      // admin editing someone else's log does not rewrite its author.
      tutor_id: next.tutorId || null
    });
    const { error } = before
      ? await sb.from('session_logs').update(row).eq('id', id)
      : await sb.from('session_logs').insert(row);
    if (error) {
      if (before) S.logs.set(id, before); else S.logs.delete(id);
      notify();
      throw fail('saveSessionLog', error);
    }
    return next;
  }

  async function deleteSessionLog(id) {
    const log = S.logs.get(id);
    if (!log) return;
    S.logs.delete(id);
    notify();
    const { error } = await sb.from('session_logs').delete().eq('id', id);
    if (error) { S.logs.set(id, log); notify(); throw fail('deleteSessionLog', error); }
  }

  // Newest session first, which is the order every screen shows. session_date
  // is the tutor's own account of when the session happened, so it — not
  // created_at — is what "newest" means; created_at only breaks ties between
  // two sessions logged for the same day.
  const sessionLogsOf = (tuteeId) => Array.from(S.logs.values())
    .filter((l) => l.tuteeId === tuteeId)
    .sort((a, b) => String(b.sessionDate).localeCompare(String(a.sessionDate))
      || String(b.createdAt).localeCompare(String(a.createdAt)));

  const DAY_MS = 86400000;

  // Whole days between the most recent submitted log and today, or null when
  // there has never been one. Drafts do not count: an unfinished sheet is not a
  // record of a session.
  function daysSinceLastLog(tuteeId) {
    const last = sessionLogsOf(tuteeId).find((l) => l.status === 'submitted');
    if (!last || !last.sessionDate) return null;
    const then = Date.parse(last.sessionDate + 'T00:00:00');
    if (isNaN(then)) return null;
    const today = new Date();
    const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    // A log dated in the future reads as zero days rather than negative.
    return Math.max(0, Math.round((midnight - then) / DAY_MS));
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
    getFlaggedProblems: flaggedProblems,
    getFlaggedCount: flaggedCount,
    setProblemsFlagged: setProblemsFlagged,
    rescanFigures: rescanFigures,
    deleteProblems: deleteProblems,
    deleteModule: deleteModule,
    moduleDeleteCounts: moduleDeleteCounts,

    getAssignments: (studentId) =>
      Array.from(S.assignments.values()).filter((a) => a.studentId === studentId),
    getAssignment: (id) => S.assignments.get(id) || null,
    getTutorAssignments: (tutorId) =>
      Array.from(S.assignments.values()).filter((a) => a.tutorId === tutorId),
    assignModule: assignModule,
    unassign: unassign,
    // For the assign screen: what a filter would select, and what it would be
    // called, before anything is written.
    getModuleTags: moduleTags,
    matchProblems: matchProblems,
    describeFilter: describeFilter,
    // The calculator rule lives here rather than in the screen that draws the
    // button, because it is a question about the data — the module's subject
    // and the problem's tags — and the editor's checkbox has to agree with it.
    calculatorAllowed: calculatorAllowed,
    problemHasCalculator: hasCalculator,
    getAssignmentProblems: (assignmentId) => assignmentProblems(S.assignments.get(assignmentId)),
    // Assignments made before filtering existed have no label of their own.
    assignmentLabel: (a) => {
      if (!a) return '\u2014';
      if (a.label) return a.label;
      const m = S.modules.get(a.moduleId);
      return m ? m.title : '\u2014';
    },

    getSubmissions: (assignmentId) => {
      const a = S.assignments.get(assignmentId);
      const out = {};
      if (!a) return out;
      assignmentProblems(a).forEach((p) => {
        const s = S.subs.get(subKey(a.studentId, p.id));
        if (s) out[p.id] = s;
      });
      return out;
    },
    submitAnswer: submitAnswer,

    // Per assignment, not per module: two filtered assignments of the same
    // module each count out of their own set. A submission belongs to the
    // tutee and the problem, so a problem in both of them is answered in both
    // at once — they did answer it.
    getProgress: (assignmentId) => {
      const a = S.assignments.get(assignmentId);
      const problems = assignmentProblems(a);
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
    setPin: setPin,
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
    deleteErrorEntry: deleteErrorEntry,

    // Null when the intake sheet has never been filled in, which is what the
    // warning badge on My Students is testing.
    getStudentProfile: (tuteeId) => S.sprofiles.get(tuteeId) || null,
    saveStudentProfile: saveStudentProfile,

    getSessionLogs: sessionLogsOf,
    getSessionLog: (id) => S.logs.get(id) || null,
    daysSinceLastLog: daysSinceLastLog,
    saveSessionLog: saveSessionLog,
    deleteSessionLog: deleteSessionLog,
    // Everything the caller may read, for the admin screen's filters. Newest
    // first across all tutees.
    getAllSessionLogs: () => Array.from(S.logs.values())
      .sort((a, b) => String(b.sessionDate).localeCompare(String(a.sessionDate))
        || String(b.createdAt).localeCompare(String(a.createdAt)))
  };

  // Start resolving the session now rather than waiting for the component to
  // mount, so a signed-in reload lands on the dashboard directly.
  init();
})();
