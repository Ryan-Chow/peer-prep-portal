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
    sessions: new Map(),    // id -> UI calendar session
    avail: new Map(),       // id -> UI availability block
    // Admin only. `loaded` stays false (with `error`) on a project without
    // migration 012, so the Finance tab can say why it is empty.
    fin: newFin(),
    loaded: false,
    // True until the first getSession() (and any profile load it triggers)
    // settles. The UI shows a neutral splash rather than flashing the login
    // card at someone who is already signed in.
    booting: true
  };

  function newFin() {
    return {
      loaded: false, error: '',
      rows: new Map(), ledger: new Map(),
      rates: { tutee: new Map(), tutor: new Map() },
      settings: { timezone: 'UTC', quickCategories: [] }
    };
  }

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
    S.sessions.clear(); S.avail.clear();
    S.fin = newFin();
    S.links = [];
    S.loaded = false;
  }

  function putUser(row) {
    S.users.set(row.id, {
      id: row.id,
      role: uiRole(row.role),
      name: row.display_name || row.username || row.email || '\u2014',
      email: row.email || '',
      username: row.username || '',
      // Missing on a project that has not run 010 yet, which is the same as
      // every account being active.
      active: row.active !== false
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
        ...imageFields(row),
        sortOrder: row.sort_order
      }));
    });
  }

  // The figure and the per-choice pictures. Both problems and problems_public
  // carry them, and so does error_log_view, so all three caches read them the
  // same way. choiceImages is null or exactly four entries, each a URL or null.
  function imageFields(row) {
    const ci = Array.isArray(row.choice_images) && row.choice_images.length === 4
      ? row.choice_images.map((u) => (typeof u === 'string' && u ? u : null))
      : null;
    return {
      imageUrl: row.image_url || '',
      imageAlt: row.image_alt || '',
      imagePosition: row.image_position === 'below' ? 'below' : 'above',
      choiceImages: ci && ci.some(Boolean) ? ci : null
    };
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
      createdAt: row.created_at,
      ...imageFields(row)
    });
  }

  // The intake sheet from the handbook. The student's name is not stored here —
  // it lives on the profile — so only the grade half of "STUDENT NAME & GRADE"
  // has a column.
  const text = (v) => (v == null ? '' : String(v));
  const SESSION_STATUSES = ['scheduled', 'completed', 'cancelled', 'no_show'];
  const SESSION_ORDER = ['starts_at', 'id'];

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
      // Kept by a trigger (010), so a sheet whose tutor's account has been
      // deleted still says who wrote it.
      tutorName: text(row.tutor_name),
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
      // The calendar session this sheet was written for, or '' for a sheet
      // logged from My Students or written before the calendar existed.
      sessionId: row.session_id || '',
      createdAt: row.created_at,
      updatedAt: row.updated_at
    });
  }

  // start and end are epoch milliseconds, kept alongside the ISO strings
  // because every screen that draws a session compares and positions by them.
  function putSession(row) {
    const start = Date.parse(row.starts_at), end = Date.parse(row.ends_at);
    S.sessions.set(row.id, {
      id: row.id,
      tutorId: row.tutor_id,
      tuteeId: row.tutee_id,
      start: start,
      end: end,
      location: text(row.location),
      notes: text(row.notes),
      status: SESSION_STATUSES.indexOf(row.status) >= 0 ? row.status : 'scheduled',
      recurrenceId: row.recurrence_id || '',
      repeatWeeks: Number(row.repeat_weeks) || 0,
      groupId: row.group_id || '',
      createdBy: row.created_by || ''
    });
  }

  // 'HH:MM', as Postgres returns 'HH:MM:SS'.
  function putAvailability(row) {
    S.avail.set(row.id, {
      id: row.id,
      tutorId: row.tutor_id,
      weekday: Number(row.weekday),
      start: String(row.start_time).slice(0, 5),
      end: String(row.end_time).slice(0, 5)
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
    const [profRes, modRes, probs, revealed, subs, errors, sprofs, sessions] = await Promise.all([
      tutorIds.length ? sb.from('profiles').select('*').in('id', tutorIds) : NONE,
      moduleIds.length ? sb.from('modules').select('*').in('id', moduleIds) : NONE,
      moduleIds.length ? allRows('problems_public', { filter: (q) => q.in('module_id', moduleIds) }) : NO_ROWS,
      allRows('revealed_answers'),
      allRows('submissions', { filter: (q) => q.eq('tutee_id', id) }),
      // Unfiltered on purpose: the view returns only this tutee's own rows,
      // and it keeps entries whose module has since been unassigned.
      allRows('error_log_view'),
      // At most one row, but the filter costs nothing and says what is meant.
      allRows('student_profiles', { order: ['tutee_id'], filter: (q) => q.eq('tutee_id', id) }),
      allRows('sessions', { order: SESSION_ORDER, filter: (q) => q.eq('tutee_id', id) })
    ]);

    rows(profRes, 'profiles').forEach(putUser);
    rows(modRes, 'modules').forEach(putModule);
    putProblems(probs);
    applyRevealed(revealed);
    subs.forEach(putSubmission);
    errors.forEach(putErrorEntry);
    sprofs.forEach(putStudentProfile);
    sessions.forEach(putSession);
  }

  async function loadTutor(id) {
    const linkRes = await sb.from('tutor_tutees').select('*').eq('tutor_id', id);
    S.links = rows(linkRes, 'tutor_tutees');
    const tuteeIds = S.links.map((l) => l.tutee_id);

    // A tutor reads the whole library — every module and every problem in it,
    // not just what they have assigned — so this is the read that first outgrew
    // one page.
    const [profRes, mods, probs, asg, subs, errors, sprofs, logs, sessions, avail] = await Promise.all([
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
      allRows('session_logs'),
      // By tutor rather than by tutee, for the same reason: a session with a
      // tutee since reassigned still occupies this tutor's time.
      allRows('sessions', { order: SESSION_ORDER, filter: (q) => q.eq('tutor_id', id) }),
      allRows('tutor_availability', { filter: (q) => q.eq('tutor_id', id) })
    ]);

    rows(profRes, 'profiles').forEach(putUser);
    mods.forEach(putModule);
    putProblems(probs);
    asg.forEach(putAssignment);
    subs.forEach(putSubmission);
    errors.forEach(putErrorEntry);
    sprofs.forEach(putStudentProfile);
    logs.forEach(putSessionLog);
    sessions.forEach(putSession);
    avail.forEach(putAvailability);
  }

  async function loadAdmin() {
    // Every one of these is the whole table, unfiltered.
    const [profs, links, mods, probs, asg, subs, errors, sprofs, logs, sessions, avail] = await Promise.all([
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
      allRows('session_logs'),
      allRows('sessions', { order: SESSION_ORDER }),
      allRows('tutor_availability')
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
    sessions.forEach(putSession);
    avail.forEach(putAvailability);
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
      // Deactivating bans the account in auth, so this is only reached by a
      // tab that was already signed in at the time. RLS has stopped returning
      // it anything else; say why rather than leave it on an empty screen.
      if (profRes.data.active === false) {
        clear();
        await sb.auth.signOut();
        toast('This account has been deactivated. Ask an admin if you think that is a mistake.');
        return null;
      }

      clear();
      putUser(profRes.data);
      S.meId = profRes.data.id;

      if (profRes.data.role === 'tutee') await loadTutee(user.id);
      else if (profRes.data.role === 'tutor') await loadTutor(user.id);
      else { await loadAdmin(); await loadFinance(); }

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

    // Checked here as well as in the editor, with the importer's own rule, so
    // nothing reaches the table's check constraint as a raw Postgres error.
    const prior = idx >= 0 ? m.problems[idx] : null;
    const clean = (u, label) => {
      const c = window.ppaImport.cleanImageUrl(u);
      if (c.error) throw fail('saveProblem', { message: label + ' ' + c.error });
      return c.url;
    };
    const imageUrl = clean(problem.imageUrl, 'The image link');
    const choiceImages = problem.type === 'mc' && Array.isArray(problem.choiceImages)
      ? problem.choiceImages.slice(0, 4).map((u, i) => clean(u, 'The image link for choice ' + 'ABCD'[i]) || null)
      : null;
    while (choiceImages && choiceImages.length < 4) choiceImages.push(null);
    const hasChoiceImages = !!(choiceImages && choiceImages.some(Boolean));

    // Attaching a figure is the fix for a problem flagged as missing one, so
    // saving it with an image takes it off the Flagged list. flag_reason stays,
    // as it does for any unflag, so no later sweep puts it back.
    const unflag = !!(prior && prior.flagged && imageUrl);

    const next = {
      id: id,
      type: problem.type,
      text: problem.text,
      choices: problem.type === 'mc' ? (problem.choices || []) : [],
      answer: problem.answer == null ? '' : problem.answer,
      explanation: problem.explanation || '',
      tags: tags,
      flagged: prior ? prior.flagged && !unflag : false,
      flagReason: prior ? prior.flagReason : '',
      imageUrl: imageUrl,
      imageAlt: imageUrl ? String(problem.imageAlt || '').trim().slice(0, 500) : '',
      imagePosition: problem.imagePosition === 'below' ? 'below' : 'above',
      choiceImages: hasChoiceImages ? choiceImages : null,
      sortOrder: sortOrder
    };
    if (idx >= 0) m.problems[idx] = next; else m.problems.push(next);
    notify();

    const row = {
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
      image_url: next.imageUrl || null,
      image_alt: next.imageAlt || null,
      image_position: next.imagePosition,
      choice_images: next.choiceImages,
      sort_order: next.sortOrder
    };
    if (unflag) row.flagged = false;
    const { error } = await sb.from('problems').upsert(row);
    if (error) { m.problems = before; notify(); throw fail('saveProblem', error); }
    return next;
  }

  // ---- images -------------------------------------------------------------

  const IMAGE_BUCKET = window.ppaImport.IMAGE_BUCKET;

  // Copies a hot-linked image into the problem-images bucket through the
  // cache-image Edge Function, which does the download server-side, and
  // returns the bucket URL to use in its place.
  async function cacheImage(url) {
    const out = await callFn('cache-image', { url: url }, 'Could not save a copy of that image');
    if (!out.url) throw new Error('The copy was stored but no address came back.');
    return out.url;
  }

  // An image from the admin's own disk, straight into the bucket under its
  // hash. The bytes are checked here because a file's name and type are
  // whatever the browser guessed from its extension.
  async function uploadImage(file) {
    if (!file) throw new Error('No file chosen.');
    if (file.size > window.ppaImport.MAX_IMAGE_BYTES) throw new Error('That file is larger than 10 MB.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const kind = window.ppaImport.sniffImage(bytes);
    if (!kind) throw new Error('That file is not a PNG, JPEG, GIF or WebP image.');
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const hash = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
    const path = window.ppaImport.imagePath(hash, kind.ext);
    const bucket = sb.storage.from(IMAGE_BUCKET);
    const { error } = await bucket.upload(path, new Blob([bytes], { type: kind.type }), {
      contentType: kind.type, upsert: false, cacheControl: '31536000'
    });
    // Named by content, so "already exists" means this exact picture is there.
    if (error && !(String(error.statusCode) === '409' || /exists|duplicate/i.test(error.message || ''))) {
      throw new Error('Upload failed: ' + (error.message || 'unknown error'));
    }
    return bucket.getPublicUrl(path).data.publicUrl;
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
  //
  // "chosen" and "random" are mutually exclusive by construction: a hand-picked
  // assignment never runs the draw. They are named differently on purpose, so a
  // tutee looking at "12 chosen" knows somebody selected those twelve for them
  // and a re-run would produce the same twelve.
  function describeFilter(moduleId, filter, take, chosen) {
    const m = S.modules.get(moduleId);
    const parts = [];
    const level = lower(filter && filter.difficulty);
    if (level) parts.push(level.charAt(0).toUpperCase() + level.slice(1));
    const tags = ((filter && filter.tags) || []).filter(Boolean);
    if (tags.length) parts.push(tags.join(', '));
    return (m ? m.title : 'Module') +
      (parts.length ? ' \u2014 ' + parts.join(' \u2014 ') : '') +
      (take ? ' (' + take + ' random)' : chosen ? ' (' + chosen + ' chosen)' : '');
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

  // Turns an assign-screen spec into the pool it reaches and the problems it
  // would hand out. Shared by assignModule() and the tutor's preview of it, so
  // what the preview shows and what the tutee is given cannot be computed two
  // different ways.
  //
  // spec: { moduleId, difficulty, tags, limit, problemIds }
  function resolveSpec(spec) {
    const m = S.modules.get(spec.moduleId);
    if (!m) return null;
    const filter = {
      difficulty: spec.difficulty || '',
      tags: (spec.tags || []).slice(),
      limit: Number(spec.limit) || 0
    };
    const pool = matchProblems(spec.moduleId, filter);

    // Hand-picked problems replace the draw rather than narrowing it: the tutor
    // has named the questions they want, so neither the count nor the shuffle
    // has anything left to decide. Every tutee then gets the same set, which is
    // the point — a random assignment deliberately gives them different ones.
    //
    // Intersected with the pool rather than trusted, because the ids arrive
    // from a screen that was rendered against some earlier state of the world:
    // a problem flagged, retagged or deleted between ticking and pressing
    // Assign must not survive on the strength of a stale checkbox.
    const wanted = Array.isArray(spec.problemIds) && spec.problemIds.length
      ? new Set(spec.problemIds) : null;
    const picked = wanted ? pool.filter((p) => wanted.has(p.id)) : pool;

    // Asking for more than there are is not an error; it just means everything
    // matched, and the label should not claim a random draw that never happened.
    const take = !wanted && filter.limit && filter.limit < pool.length ? filter.limit : 0;
    const narrowed = !!(wanted || filter.difficulty || filter.tags.length || filter.limit);
    return {
      module: m, filter: filter, pool: pool, picked: picked, take: take, narrowed: narrowed,
      label: describeFilter(spec.moduleId, filter, take, wanted ? picked.length : 0),
      // Seeded on the assignment id, so the draw is reproducible from the row
      // and two tutees given the same filter get different questions.
      draw: (seed) => (take ? pickSome(pool, take, seed) : picked)
    };
  }

  // What the assign screen's Preview button opens: the problems one tutee
  // would get from this spec, before anything is written. A random draw is
  // shown once, seeded on the module rather than on an assignment id that does
  // not exist yet — so it is one possible draw, and `random` says so.
  function previewAssignment(spec) {
    const r = resolveSpec(spec);
    if (!r) return null;
    return {
      label: r.label,
      random: r.take > 0,
      poolSize: r.pool.length,
      problems: r.draw('preview:' + spec.moduleId)
    };
  }

  // Assign a slice of a module rather than all of it. The filter is resolved
  // here, once, and only the resulting ids are stored: a module reworded or
  // retagged next month cannot change what a tutee was asked to do, and cannot
  // quietly add problems to an assignment they have half finished.
  //
  // spec: { moduleId, studentIds, tutorId, due, difficulty, tags, limit, problemIds }
  async function assignModule(spec) {
    const r = resolveSpec(spec);
    if (!r) return [];
    const m = r.module, filter = r.filter, label = r.label;
    if (!r.pool.length) {
      throw fail('assignModule', { message: 'Nothing in \u201c' + m.title + '\u201d matches those options.' });
    }
    if (!r.picked.length) {
      throw fail('assignModule', { message: 'None of the problems you picked are still in \u201c' + m.title + '\u201d.' });
    }

    const made = [];
    const payload = [];
    (spec.studentIds || []).forEach((sid) => {
      const id = uuid();
      const chosen = r.draw(id);
      const problemIds = r.narrowed ? chosen.map((p) => p.id) : null;
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

  // The comparison submit_answer() makes in Postgres — trimmed, lower-cased,
  // whitespace removed — so a tutor's preview grades exactly as the tutee's
  // submission will. Only the preview calls it: a tutee's answer is still
  // graded server-side, where the key is.
  const canon = (s) => String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, '');
  const gradeAnswer = (answer, key) => canon(answer) === canon(key);

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

  // Anything that touches the auth schema goes through an Edge Function:
  // creating, editing and deleting a user all need the service role key, which
  // must never reach the browser. The admin's own access token is what each
  // function checks the caller against.
  async function callFn(name, body, fallbackMsg) {
    const { data } = await sb.auth.getSession();
    const session = data && data.session;
    if (!session) throw new Error('Your session expired — sign in again.');

    const res = await fetch(cfg.SUPABASE_URL + '/functions/v1/' + name, {
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

    const out = await callFn('create-user', body, 'Could not create the account');
    await load();
    notify();
    return out.id;
  }

  // No cache reload afterwards: Supabase keeps only the hash, so there is
  // nothing about the new PIN for the roster to display.
  async function setPin(userId, pin) {
    await callFn('create-user', { action: 'set_pin', user_id: userId, pin: pin }, 'Could not set the PIN');
  }

  // patch: any of { name, email, username, pin, tutorId, tuteeIds }. Only the
  // keys present are sent, and the function leaves the rest alone. A reload
  // follows because the change can move links, rename, and readdress at once.
  async function updateUser(userId, patch) {
    const body = { user_id: userId };
    if (patch.name != null) body.display_name = patch.name;
    if (patch.email != null) body.email = patch.email;
    if (patch.username != null) body.username = patch.username;
    if (patch.pin) body.pin = patch.pin;
    if (patch.tutorId !== undefined) body.tutor_id = patch.tutorId || '';
    if (patch.tuteeIds !== undefined) body.tutee_ids = patch.tuteeIds;
    // Reloaded even on failure: the function writes auth, then the profile,
    // then the links, and a refusal part-way leaves the earlier steps done.
    try {
      await callFn('update-user', body, 'Could not save those changes');
    } finally {
      await load();
      notify();
    }
  }

  // Deactivating keeps every row and bans the account; reactivating lifts it.
  async function setUserActive(userId, active) {
    await callFn('update-user', { user_id: userId, active: !!active }, active ? 'Could not reactivate the account' : 'Could not deactivate the account');
    const u = S.users.get(userId);
    if (u) u.active = !!active;
    notify();
  }

  // confirmName is the display name, typed by the admin; the function checks
  // it again before deleting anything.
  async function deleteUser(userId, confirmName) {
    await callFn('delete-user', { user_id: userId, confirm_name: confirmName }, 'Could not delete the account');
    await load();
    notify();
  }

  async function userDeleteCounts(userId) {
    const { data, error } = await sb.rpc('user_delete_counts', { p_user: userId });
    if (error) throw fail('userDeleteCounts', error);
    const row = (Array.isArray(data) ? data[0] : data) || {};
    const n = (k) => Number(row[k]) || 0;
    return {
      assignments: n('assignments'), assignmentsMade: n('assignments_made'),
      submissions: n('submissions'), errors: n('error_log_entries'),
      logsDeleted: n('session_logs_deleted'), logsKept: n('session_logs_kept'),
      sessions: n('sessions'), links: n('links'), availability: n('availability'),
      studentProfile: n('student_profile')
    };
  }

  // The one self-service edit there is: a tutor's own display name. The
  // profiles policy and column grant (010) refuse anything wider.
  async function updateMyName(name) {
    const me = S.meId && S.users.get(S.meId);
    const next = String(name == null ? '' : name).trim();
    if (!me) return;
    if (!next) throw fail('updateMyName', { message: 'Your name cannot be blank.' });
    if (next.length > 80) throw fail('updateMyName', { message: 'Keep your name under 80 characters.' });
    const before = me.name;
    me.name = next;
    notify();
    const { error } = await sb.from('profiles').update({ display_name: next }).eq('id', S.meId);
    if (error) { me.name = before; notify(); throw fail('updateMyName', error); }
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
      is_correct: sub ? sub.correct : false,
      image_url: hit ? hit.problem.imageUrl : null,
      image_alt: hit ? hit.problem.imageAlt : null,
      image_position: hit ? hit.problem.imagePosition : 'above',
      choice_images: hit ? hit.problem.choiceImages : null
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
      parentCommunication: '', paymentStatus: '', status: 'draft', sessionId: '',
      createdAt: new Date().toISOString(), updatedAt: null
    }, before || {}, patch, { id: id });

    S.logs.set(id, next);
    notify();

    const row = Object.assign(logColumns(next), {
      id: id,
      tutee_id: next.tuteeId,
      // Pinned by the insert policy to the caller anyway; sent explicitly so an
      // admin editing someone else's log does not rewrite its author.
      tutor_id: next.tutorId || null,
      session_id: next.sessionId || null
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

  // ---- calendar sessions --------------------------------------------------

  // Everything here is in the browser's own zone: a tutor types "4:00 PM" and
  // means 4pm where they are sitting. Postgres keeps UTC, and toISOString() is
  // the only conversion between the two.
  const pad2 = (n) => String(n).padStart(2, '0');
  const localDate = (ms) => { const d = new Date(ms); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); };
  const localTime = (ms) => { const d = new Date(ms); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); };
  const minutesOf = (hhmm) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : NaN; };

  // new Date(y, m, d + n, h, min) rather than adding n * 86400000: across a
  // daylight-saving change a day is 23 or 25 hours, and a weekly 4pm session
  // has to stay at 4pm on the wall clock, not drift to 3pm or 5pm.
  function atLocal(dateISO, hhmm, plusDays) {
    const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateISO || ''));
    const t = minutesOf(hhmm);
    if (!dm || isNaN(t)) return NaN;
    return new Date(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]) + (plusDays || 0), Math.floor(t / 60), t % 60).getTime();
  }
  const dayDiff = (fromISO, toISO) => Math.round((atLocal(toISO, '12:00') - atLocal(fromISO, '12:00')) / DAY_MS);

  const fmtWhen = (ms) => new Date(ms).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  const sessionRow = (s) => ({
    id: s.id,
    tutor_id: s.tutorId,
    tutee_id: s.tuteeId,
    starts_at: new Date(s.start).toISOString(),
    ends_at: new Date(s.end).toISOString(),
    location: orNull(s.location),
    notes: orNull(s.notes),
    status: s.status,
    recurrence_id: s.recurrenceId || null,
    repeat_weeks: s.repeatWeeks || null,
    group_id: s.groupId || null
  });

  // The same test as the sessions_no_overlap constraint, run against the cache
  // first so the refusal can say which session is in the way. The constraint is
  // still what decides: an admin may have booked the slot a moment ago, into a
  // cache this tab has not reloaded.
  // The rows of one group are the same session, so they never clash with each
  // other.
  function findClash(tutorId, start, end, ignore, groupId) {
    let hit = null;
    S.sessions.forEach((s) => {
      if (hit || s.tutorId !== tutorId || s.status === 'cancelled' || (ignore && ignore.has(s.id))) return;
      if (groupId && s.groupId === groupId) return;
      if (s.start < end && start < s.end) hit = s;
    });
    return hit;
  }

  const clashError = (s) => {
    const who = S.users.get(s.tuteeId);
    const whose = s.groupId ? 'a group' : who ? who.name + '\u2019s' : 'another';
    return { message: 'That overlaps ' + whose + ' session on ' + fmtWhen(s.start) + '. A tutor can only be in one session at a time.' };
  };

  const MAX_GROUP = 12;

  // One occurrence of a session: the row itself, or every row of its group.
  const sessionKey = (s) => s.groupId || s.id;
  function groupOf(s) {
    if (!s.groupId) return [s];
    return Array.from(S.sessions.values()).filter((x) => x.groupId === s.groupId);
  }

  // What a group shows as one status: scheduled while anyone still is, then
  // completed if anyone came, cancelled only when everyone was.
  function groupStatus(rows) {
    const has = (k) => rows.some((r) => r.status === k);
    if (has('scheduled')) return 'scheduled';
    if (has('completed')) return 'completed';
    if (rows.every((r) => r.status === 'cancelled')) return 'cancelled';
    return 'no_show';
  }

  const memberName = (r) => { const u = S.users.get(r.tuteeId); return u ? u.name : ''; };

  // One entry per occurrence, for the screens that draw a session once however
  // many tutees are in it. The entry is a copy of one member, with `members`
  // (every row, by tutee name) and the group's status.
  function collapseSessions(list) {
    const byKey = new Map();
    list.forEach((s) => {
      const k = sessionKey(s);
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(s);
    });
    return Array.from(byKey.values()).map((rows) => {
      rows.sort((a, b) => memberName(a).localeCompare(memberName(b)) || String(a.id).localeCompare(String(b.id)));
      return Object.assign({}, rows[0], { members: rows, status: rows.length > 1 ? groupStatus(rows) : rows[0].status });
    }).sort((a, b) => a.start - b.start || String(a.id).localeCompare(String(b.id)));
  }

  const uniqIds = (ids) => Array.from(new Set((ids || []).filter(Boolean)));

  // 23P01 is exclusion_violation. The raw message names the constraint and
  // dumps two tstzranges, which means nothing to a tutor.
  function sessionFail(where, error) {
    if (error && (error.code === '23P01' || /sessions_no_overlap/.test(error.message || ''))) {
      return fail(where, { message: 'That time overlaps another session this tutor already has. Someone may have just booked it \u2014 reload to see it.' });
    }
    return fail(where, error);
  }

  // A repeating session becomes `count` concrete rows sharing a recurrence_id,
  // `everyWeeks` apart. A group puts one row per tutee into each occurrence,
  // sharing a group_id. All of them go in one insert, so a clash in week 6
  // leaves weeks 1–5 unwritten rather than half a series on the calendar.
  //
  // spec: { tutorId, tuteeIds, date, time, minutes, location, notes, count, everyWeeks }
  async function createSessions(spec) {
    const minutes = Math.round(Number(spec.minutes));
    const count = Math.round(Number(spec.count) || 1);
    const every = Math.round(Number(spec.everyWeeks) || 1);
    const tuteeIds = uniqIds(spec.tuteeIds || [spec.tuteeId]);
    if (!(minutes >= 5 && minutes <= 720)) throw fail('createSessions', { message: 'A session must last between 5 minutes and 12 hours.' });
    if (!(count >= 1 && count <= 26)) throw fail('createSessions', { message: 'A repeating series has 1 to 26 sessions.' });
    if (!(every >= 1 && every <= 4)) throw fail('createSessions', { message: 'A series repeats every 1 to 4 weeks.' });
    if (!spec.tutorId || !tuteeIds.length) throw fail('createSessions', { message: 'Pick a tutor and at least one tutee.' });
    if (tuteeIds.length > MAX_GROUP) throw fail('createSessions', { message: 'A group session holds up to ' + MAX_GROUP + ' tutees.' });
    if (isNaN(atLocal(spec.date, spec.time))) throw fail('createSessions', { message: 'Pick a date and a start time.' });

    const recurrenceId = count > 1 ? uuid() : '';
    const made = [];
    for (let i = 0; i < count; i++) {
      const start = atLocal(spec.date, spec.time, 7 * every * i);
      const groupId = tuteeIds.length > 1 ? uuid() : '';
      const clash = findClash(spec.tutorId, start, start + minutes * 60000);
      if (clash) throw fail('createSessions', clashError(clash));
      tuteeIds.forEach((tid) => made.push({
        id: uuid(), tutorId: spec.tutorId, tuteeId: tid,
        start: start, end: start + minutes * 60000,
        location: text(spec.location).trim(), notes: text(spec.notes).trim(),
        status: 'scheduled', recurrenceId: recurrenceId, repeatWeeks: count > 1 ? every : 0,
        groupId: groupId, createdBy: S.meId
      }));
    }

    made.forEach((s) => S.sessions.set(s.id, s));
    notify();
    const { error } = await sb.from('sessions').insert(made.map(sessionRow));
    if (error) {
      made.forEach((s) => S.sessions.delete(s.id));
      notify();
      throw sessionFail('createSessions', error);
    }
    financeTouched();
    return made;
  }

  // The rows an edit reaches. 'self' is this row alone (one tutee's status in a
  // group); 'one' is this occurrence, every tutee in it; 'future' is this
  // occurrence and every later one in its series. "Later" is by start time, so
  // a session moved out of order earlier is still judged by where it is now.
  function sessionScope(id, scope) {
    const s = S.sessions.get(id);
    if (!s) return [];
    if (scope === 'self') return [s];
    if (scope !== 'future' || !s.recurrenceId) return groupOf(s);
    return Array.from(S.sessions.values())
      .filter((x) => x.recurrenceId === s.recurrenceId && x.start >= s.start)
      .sort((a, b) => a.start - b.start);
  }

  // patch: any of { date, time, minutes, location, notes, tutorId, tuteeIds, status }
  // scope: 'self' | 'one' | 'future'
  //
  // Only what the patch changes relative to the session it was opened on is
  // carried to the rest of the series. Moving Tuesday's session to Wednesday
  // moves each later one a day as well; changing only the room leaves the time
  // of a week that was individually rescheduled where it is. The same goes for
  // the roster: adding a tutee adds them to every occurrence in scope, and
  // removing one removes only them.
  async function updateSessions(id, patch, scope) {
    const base = S.sessions.get(id);
    if (!base) return [];
    const targets = sessionScope(id, scope);
    const baseDate = localDate(base.start), baseTime = localTime(base.start);
    const baseMinutes = Math.round((base.end - base.start) / 60000);

    const shift = patch.date && patch.date !== baseDate ? dayDiff(baseDate, patch.date) : 0;
    const newTime = patch.time && patch.time !== baseTime ? patch.time : null;
    const newMinutes = patch.minutes != null && Math.round(Number(patch.minutes)) !== baseMinutes ? Math.round(Number(patch.minutes)) : null;
    if (newMinutes != null && !(newMinutes >= 5 && newMinutes <= 720)) {
      throw fail('updateSessions', { message: 'A session must last between 5 minutes and 12 hours.' });
    }
    const changed = (key) => patch[key] != null && text(patch[key]).trim() !== text(base[key]).trim();

    const want = scope === 'self' ? null : patch.tuteeIds ? uniqIds(patch.tuteeIds) : patch.tuteeId ? [patch.tuteeId] : null;
    if (want && !want.length) throw fail('updateSessions', { message: 'A session needs at least one tutee.' });
    if (want && want.length > MAX_GROUP) throw fail('updateSessions', { message: 'A group session holds up to ' + MAX_GROUP + ' tutees.' });
    const had = groupOf(base).map((r) => r.tuteeId);
    const adding = want ? want.filter((t) => had.indexOf(t) < 0) : [];
    const dropping = want ? had.filter((t) => want.indexOf(t) < 0) : [];

    const before = targets.map((t) => Object.assign({}, t));
    let next = targets.map((t) => {
      const n = Object.assign({}, t);
      if (shift || newTime || newMinutes != null) {
        const minutes = newMinutes != null ? newMinutes : Math.round((t.end - t.start) / 60000);
        n.start = atLocal(localDate(t.start), newTime || localTime(t.start), shift);
        n.end = n.start + minutes * 60000;
      }
      if (changed('location')) n.location = text(patch.location).trim();
      if (changed('notes')) n.notes = text(patch.notes).trim();
      if (patch.tutorId && patch.tutorId !== base.tutorId) n.tutorId = patch.tutorId;
      if (patch.status && SESSION_STATUSES.indexOf(patch.status) >= 0) n.status = patch.status;
      return n;
    });

    // Roster changes, one occurrence at a time. A tutee added to a past
    // occurrence starts scheduled, and one added to a cancelled one starts
    // cancelled with it. A dropped tutee's completed or no-show row stays: it is
    // their attendance record, not a booking.
    const removed = [];
    const ungroup = new Set();
    if (adding.length || dropping.length) {
      const occ = new Map();
      next.forEach((n) => { const k = sessionKey(n); if (!occ.has(k)) occ.set(k, []); occ.get(k).push(n); });
      next = [];
      const drops = (r) => dropping.indexOf(r.tuteeId) >= 0 && r.status !== 'completed' && r.status !== 'no_show';
      occ.forEach((rows) => {
        const keep = rows.filter((r) => !drops(r));
        rows.filter(drops).forEach((r) => removed.push(r));
        const like = keep[0] || rows[0];
        const present = keep.map((r) => r.tuteeId);
        const all = keep.length && keep.every((r) => r.status === 'cancelled');
        adding.filter((t) => present.indexOf(t) < 0).forEach((tid) => keep.push(Object.assign({}, like, {
          id: uuid(), tuteeId: tid, status: all ? 'cancelled' : 'scheduled', createdBy: S.meId
        })));
        if (!keep.length) return;
        const groupId = keep.length > 1 ? (like.groupId || uuid()) : '';
        keep.forEach((r) => {
          if (!groupId && r.groupId) ungroup.add(r.id);
          r.groupId = groupId;
          next.push(r);
        });
      });
    }
    const removedIds = removed.map((r) => r.id);
    const added = next.filter((n) => !S.sessions.has(n.id));

    const moving = new Set(targets.map((t) => t.id));
    for (const n of next) {
      if (n.status === 'cancelled') continue;
      const clash = findClash(n.tutorId, n.start, n.end, moving, n.groupId);
      if (clash) throw fail('updateSessions', clashError(clash));
    }

    const undo = () => {
      added.forEach((a) => S.sessions.delete(a.id));
      before.forEach((b) => S.sessions.set(b.id, b));
      notify();
    };
    next.forEach((n) => S.sessions.set(n.id, n));
    removedIds.forEach((rid) => S.sessions.delete(rid));
    notify();
    // One statement for the whole series, so the overlap constraint (deferred
    // to the end of the statement) sees every row in its new place at once.
    // Added tutees ride in the same upsert as inserts. A group shrinking to one
    // tutee keeps its group_id until the dropped rows are gone, because those
    // rows still sit at the same time and only the shared group_id lets them.
    if (next.length) {
      const rows = next.map((n) => sessionRow(ungroup.has(n.id) ? Object.assign({}, n, { groupId: before.find((b) => b.id === n.id).groupId }) : n));
      const { error } = await sb.from('sessions').upsert(rows);
      if (error) { undo(); throw sessionFail('updateSessions', error); }
    }
    if (removedIds.length) {
      const { error } = await sb.from('sessions').delete().in('id', removedIds);
      if (error) {
        removed.forEach((r) => S.sessions.set(r.id, before.find((b) => b.id === r.id) || r));
        ungroup.forEach((uid) => { const n = S.sessions.get(uid); if (n) S.sessions.set(uid, Object.assign({}, n, { groupId: before.find((b) => b.id === uid).groupId })); });
        notify();
        throw fail('updateSessions', error);
      }
    }
    // A group of one is harmless if this last step fails: it clashes with
    // nothing and draws as a single session.
    if (ungroup.size) {
      const { error } = await sb.from('sessions').upsert(next.filter((n) => ungroup.has(n.id)).map(sessionRow));
      if (error) console.warn('[ppa] updateSessions: could not clear group_id', error);
    }
    financeTouched();
    return next;
  }

  // Several rows to one status in one statement: "everyone came" on a group
  // marks only the tutees still scheduled, so a no-show stays one.
  async function setSessionStatus(ids, status) {
    if (SESSION_STATUSES.indexOf(status) < 0) return [];
    const rows = uniqIds(ids).map((rid) => S.sessions.get(rid)).filter(Boolean);
    if (!rows.length) return [];
    const before = rows.map((r) => Object.assign({}, r));
    const next = rows.map((r) => Object.assign({}, r, { status: status }));
    if (status !== 'cancelled') {
      const moving = new Set(rows.map((r) => r.id));
      for (const n of next) {
        const clash = findClash(n.tutorId, n.start, n.end, moving, n.groupId);
        if (clash) throw fail('setSessionStatus', clashError(clash));
      }
    }
    next.forEach((n) => S.sessions.set(n.id, n));
    notify();
    const { error } = await sb.from('sessions').upsert(next.map(sessionRow));
    if (error) {
      before.forEach((b) => S.sessions.set(b.id, b));
      notify();
      throw sessionFail('setSessionStatus', error);
    }
    financeTouched();
    return next;
  }

  // A drag in the week view: same length, new start, this occurrence only.
  function moveSession(id, start) {
    return updateSessions(id, { date: localDate(start), time: localTime(start) }, 'one');
  }

  // The whole occurrence: every tutee's row of a group.
  async function deleteSession(id) {
    const s = S.sessions.get(id);
    if (!s) return;
    const rows = groupOf(s);
    rows.forEach((r) => S.sessions.delete(r.id));
    notify();
    const { error } = await sb.from('sessions').delete().in('id', rows.map((r) => r.id));
    if (error) { rows.forEach((r) => S.sessions.set(r.id, r)); notify(); throw fail('deleteSession', error); }
    financeTouched();
  }

  // Sessions overlapping [from, to), earliest first. Either bound may be
  // omitted, and tutorId / tuteeId narrow it further.
  function sessionsIn(q) {
    const o = q || {};
    return Array.from(S.sessions.values())
      .filter((s) => (o.from == null || s.end > o.from) && (o.to == null || s.start < o.to)
        && (!o.tutorId || s.tutorId === o.tutorId) && (!o.tuteeId || s.tuteeId === o.tuteeId))
      .sort((a, b) => a.start - b.start || String(a.id).localeCompare(String(b.id)));
  }

  // The sheet written for this session. A sheet logged from My Students before
  // the calendar knew about it has no session_id, so one for the same tutee on
  // the same local day stands in, as long as it is not claimed by another
  // session. Submitted beats draft.
  function logForSession(id) {
    const s = S.sessions.get(id);
    if (!s) return null;
    const day = localDate(s.start);
    const logs = Array.from(S.logs.values()).filter((l) =>
      l.sessionId === id || (!l.sessionId && l.tuteeId === s.tuteeId && l.sessionDate === day));
    return logs.find((l) => l.status === 'submitted') || logs[0] || null;
  }

  // Past sessions still marked scheduled: someone has to say whether they
  // happened. Scoped to one tutor, or every tutor when tutorId is omitted.
  const needsStatus = (tutorId) => Array.from(S.sessions.values())
    .filter((s) => s.status === 'scheduled' && s.end < Date.now() && (!tutorId || s.tutorId === tutorId))
    .sort((a, b) => a.start - b.start);

  // ---- availability -------------------------------------------------------

  const availabilityOf = (tutorId) => Array.from(S.avail.values())
    .filter((a) => a.tutorId === tutorId)
    .sort((a, b) => a.weekday - b.weekday || a.start.localeCompare(b.start));

  async function addAvailability(block) {
    const b = {
      id: uuid(), tutorId: block.tutorId, weekday: Number(block.weekday),
      start: String(block.start).slice(0, 5), end: String(block.end).slice(0, 5)
    };
    if (!(b.weekday >= 0 && b.weekday <= 6) || !(minutesOf(b.end) > minutesOf(b.start))) {
      throw fail('addAvailability', { message: 'The block has to end after it starts.' });
    }
    S.avail.set(b.id, b);
    notify();
    const { error } = await sb.from('tutor_availability').insert({
      id: b.id, tutor_id: b.tutorId, weekday: b.weekday, start_time: b.start, end_time: b.end
    });
    if (error) { S.avail.delete(b.id); notify(); throw fail('addAvailability', error); }
    return b;
  }

  async function removeAvailability(id) {
    const b = S.avail.get(id);
    if (!b) return;
    S.avail.delete(id);
    notify();
    const { error } = await sb.from('tutor_availability').delete().eq('id', id);
    if (error) { S.avail.set(id, b); notify(); throw fail('removeAvailability', error); }
  }

  // null when the tutor has set no availability at all — nothing to compare
  // against, which is not the same as "unavailable". Otherwise true only when
  // one block on that weekday covers the whole session.
  function isAvailable(tutorId, start, end) {
    const blocks = availabilityOf(tutorId);
    if (!blocks.length) return null;
    if (localDate(start) !== localDate(end - 1)) return false;
    const day = new Date(start).getDay();
    const from = minutesOf(localTime(start));
    const to = from + Math.round((end - start) / 60000);
    return blocks.some((b) => b.weekday === day && minutesOf(b.start) <= from && minutesOf(b.end) >= to);
  }

  // ---- finance (admin only) -----------------------------------------------

  // Money is integer cents end to end. These two are the only places a dollar
  // string becomes cents or cents become one.
  //
  // Accepts "45", "45.5", "45.00", "$45", "$1,234.56" and " 45 ". Anything else,
  // a negative, or more than two decimals is NaN, which every caller refuses.
  function parseMoney(input) {
    const s = String(input == null ? '' : input).trim().replace(/^\$\s*/, '').replace(/,/g, '');
    if (!/^\d+(\.\d{0,2})?$|^\.\d{1,2}$/.test(s)) return NaN;
    const [whole, frac] = s.split('.');
    return Number(whole || '0') * 100 + Number(((frac || '') + '00').slice(0, 2));
  }
  function fmtMoney(cents, opts) {
    if (cents == null || isNaN(cents)) return '—';
    const neg = cents < 0, abs = Math.abs(Math.round(cents));
    const dollars = Math.floor(abs / 100).toLocaleString('en-US');
    const out = '$' + dollars + (opts && opts.whole ? '' : '.' + String(abs % 100).padStart(2, '0'));
    return neg ? '−' + out : out;
  }

  const PAYMENT_STATUSES = ['unpaid', 'paid', 'waived', 'comped'];
  const PAYOUT_STATUSES = ['owed', 'paid'];
  const DEFAULT_QUICK = ['Ads', 'Software', 'Materials', 'Referral bonus', 'Refund', 'Package prepayment'];

  function putFinRow(r) {
    S.fin.rows.set(r.id, {
      id: r.id,
      sessionId: r.session_id || '',
      tuteeId: r.tutee_id || '',
      tutorId: r.tutor_id || '',
      date: text(r.session_date),
      minutes: Number(r.duration_min) || 0,
      billed: Number(r.billed_cents) || 0,
      tutorPay: Number(r.paid_to_tutor_cents) || 0,
      extra: Number(r.extra_cost_cents) || 0,
      extraNote: text(r.extra_cost_note),
      payment: PAYMENT_STATUSES.indexOf(r.payment_status) >= 0 ? r.payment_status : 'unpaid',
      paidOn: text(r.paid_on),
      payout: PAYOUT_STATUSES.indexOf(r.payout_status) >= 0 ? r.payout_status : 'owed',
      payoutOn: text(r.payout_on),
      notes: text(r.notes),
      rateMissing: !!r.rate_missing,
      payLocked: !!r.tutor_pay_locked
    });
  }
  const finRowColumns = (f) => ({
    id: f.id,
    session_id: f.sessionId || null,
    tutee_id: f.tuteeId || null,
    tutor_id: f.tutorId || null,
    session_date: f.date,
    duration_min: f.minutes,
    billed_cents: f.billed,
    paid_to_tutor_cents: f.tutorPay,
    extra_cost_cents: f.extra,
    extra_cost_note: orNull(f.extraNote),
    payment_status: f.payment,
    paid_on: f.paidOn || null,
    payout_status: f.payout,
    payout_on: f.payoutOn || null,
    notes: orNull(f.notes),
    rate_missing: f.rateMissing,
    tutor_pay_locked: f.payLocked
  });

  function putLedger(r) {
    S.fin.ledger.set(r.id, {
      id: r.id,
      date: text(r.date),
      kind: r.kind === 'income' ? 'income' : 'expense',
      category: text(r.category),
      amount: Number(r.amount_cents) || 0,
      counterparty: text(r.counterparty),
      tuteeId: r.tutee_id || '',
      tutorId: r.tutor_id || '',
      note: text(r.note),
      receiptUrl: text(r.receipt_url),
      createdAt: r.created_at || ''
    });
  }
  const ledgerColumns = (e) => ({
    id: e.id,
    date: e.date,
    kind: e.kind,
    category: e.category.trim(),
    amount_cents: e.amount,
    counterparty: orNull(e.counterparty),
    tutee_id: e.tuteeId || null,
    tutor_id: e.tutorId || null,
    note: orNull(e.note),
    receipt_url: orNull(e.receiptUrl)
  });

  const putRate = (kind) => (r) => {
    S.fin.rates[kind].set(r.id, {
      id: r.id, kind: kind,
      personId: kind === 'tutee' ? r.tutee_id : r.tutor_id,
      cents: Number(r.hourly_rate_cents) || 0,
      from: text(r.effective_from)
    });
  };

  // A project that has not run 012 yet answers 42P01 (or PGRST205 through
  // PostgREST) for these tables. Finance then says so on its own tab rather
  // than failing the admin's whole load.
  async function loadFinance() {
    try {
      const [rowsF, ledger, tr, pr, settings] = await Promise.all([
        allRows('session_finance'),
        allRows('ledger'),
        allRows('tutee_rates'),
        allRows('tutor_rates'),
        allRows('finance_settings', { order: ['key'] })
      ]);
      S.fin.rows.clear(); S.fin.ledger.clear(); S.fin.rates.tutee.clear(); S.fin.rates.tutor.clear();
      rowsF.forEach(putFinRow);
      ledger.forEach(putLedger);
      tr.forEach(putRate('tutee'));
      pr.forEach(putRate('tutor'));
      const set = {};
      settings.forEach((s) => { set[s.key] = s.value; });
      S.fin.settings = {
        timezone: typeof set.timezone === 'string' ? set.timezone : 'UTC',
        quickCategories: Array.isArray(set.quick_categories) ? set.quick_categories.map(String) : DEFAULT_QUICK.slice()
      };
      S.fin.error = '';
      S.fin.loaded = true;
    } catch (err) {
      S.fin.error = (err && err.message) || 'Finance data could not be loaded.';
      S.fin.loaded = false;
    }
    notify();
  }

  // Finance rows are written by a trigger when a session is completed, so any
  // session change an admin makes may have changed them server-side.
  let finTimer = null;
  function financeTouched() {
    if (!S.fin.loaded) return;
    const me = S.users.get(S.meId);
    if (!me || me.role !== 'admin') return;
    clearTimeout(finTimer);
    finTimer = setTimeout(async () => {
      try {
        const rowsF = await allRows('session_finance');
        S.fin.rows.clear();
        rowsF.forEach(putFinRow);
        notify();
      } catch (e) { /* the next Finance visit reloads */ }
    }, 300);
  }

  // patch: any of the UI row fields. One update for every id, which is what
  // the bulk "Mark selected paid" needs; a single edit is the same with one id.
  async function updateFinanceRows(ids, patch) {
    const targets = uniqIds(ids).map((id) => S.fin.rows.get(id)).filter(Boolean);
    if (!targets.length) return [];
    const p = Object.assign({}, patch);
    for (const k of ['billed', 'tutorPay', 'extra']) {
      if (p[k] != null && !(Number.isInteger(p[k]) && p[k] >= 0 && p[k] <= 100000000)) {
        throw fail('updateFinanceRows', { message: 'Enter an amount like 45 or 45.00.' });
      }
    }
    if (p.minutes != null && !(Number.isInteger(p.minutes) && p.minutes >= 0 && p.minutes <= 1440)) {
      throw fail('updateFinanceRows', { message: 'A duration is 0 to 1440 minutes.' });
    }
    if (p.tutorPay != null) p.payLocked = true;
    if (p.payment === 'paid' && p.paidOn == null) p.paidOn = localDate(Date.now());
    if (p.payment && p.payment !== 'paid' && p.paidOn == null) p.paidOn = '';
    if (p.payout === 'paid' && p.payoutOn == null) p.payoutOn = localDate(Date.now());
    if (p.payout === 'owed' && p.payoutOn == null) p.payoutOn = '';

    const before = targets.map((t) => Object.assign({}, t));
    const next = targets.map((t) => Object.assign({}, t, p));
    next.forEach((n) => S.fin.rows.set(n.id, n));
    notify();
    // Only the columns the patch touched, so a bulk status change cannot
    // overwrite an amount another tab just edited.
    const full = finRowColumns(next[0]);
    const map = {
      date: 'session_date', minutes: 'duration_min', billed: 'billed_cents', tutorPay: 'paid_to_tutor_cents',
      extra: 'extra_cost_cents', extraNote: 'extra_cost_note', payment: 'payment_status', paidOn: 'paid_on',
      payout: 'payout_status', payoutOn: 'payout_on', notes: 'notes', payLocked: 'tutor_pay_locked', rateMissing: 'rate_missing'
    };
    const body = {};
    Object.keys(p).forEach((k) => { if (map[k]) body[map[k]] = full[map[k]]; });
    if (p.billed != null || p.tutorPay != null) body.rate_missing = false;
    const { error } = await sb.from('session_finance').update(body).in('id', next.map((n) => n.id));
    if (error) {
      before.forEach((b) => S.fin.rows.set(b.id, b));
      notify();
      throw fail('updateFinanceRows', error);
    }
    if (body.rate_missing === false) next.forEach((n) => { n.rateMissing = false; });
    return next;
  }

  async function deleteFinanceRow(id) {
    const f = S.fin.rows.get(id);
    if (!f) return;
    S.fin.rows.delete(id);
    notify();
    const { error } = await sb.from('session_finance').delete().eq('id', id);
    if (error) { S.fin.rows.set(id, f); notify(); throw fail('deleteFinanceRow', error); }
  }

  // Re-prices rows from the rate tables (server side, so the rule is the
  // trigger's own), then reads them back.
  async function recalcFinance(ids) {
    const list = uniqIds(ids);
    if (!list.length) return 0;
    const { data, error } = await sb.rpc('finance_recalculate', { p_ids: list });
    if (error) throw fail('recalcFinance', error);
    const res = await sb.from('session_finance').select('*').in('id', list);
    rows(res, 'session_finance').forEach(putFinRow);
    notify();
    return Number(data) || 0;
  }

  // A session that was never on the calendar: a sessions row already marked
  // completed, which the trigger prices like any other.
  async function logManualSession(spec) {
    const minutes = Math.round(Number(spec.minutes));
    if (!spec.tutorId || !spec.tuteeId) throw fail('logManualSession', { message: 'Pick a tutor and a tutee.' });
    if (!(minutes >= 5 && minutes <= 720)) throw fail('logManualSession', { message: 'A session must last between 5 minutes and 12 hours.' });
    const start = atLocal(spec.date, spec.time);
    if (isNaN(start)) throw fail('logManualSession', { message: 'Pick a date and a start time.' });
    const s = {
      id: uuid(), tutorId: spec.tutorId, tuteeId: spec.tuteeId, start: start, end: start + minutes * 60000,
      location: text(spec.location).trim(), notes: text(spec.notes).trim(), status: 'completed',
      recurrenceId: '', repeatWeeks: 0, groupId: '', createdBy: S.meId
    };
    const clash = findClash(s.tutorId, s.start, s.end);
    if (clash) throw fail('logManualSession', clashError(clash));
    S.sessions.set(s.id, s);
    notify();
    const { error } = await sb.from('sessions').insert(sessionRow(s));
    if (error) { S.sessions.delete(s.id); notify(); throw sessionFail('logManualSession', error); }
    const res = await sb.from('session_finance').select('*').eq('session_id', s.id);
    rows(res, 'session_finance').forEach(putFinRow);
    notify();
    return Array.from(S.fin.rows.values()).find((f) => f.sessionId === s.id) || null;
  }

  // entry: { date, kind, category, amount (cents), counterparty, tuteeId, tutorId, note, receiptUrl }
  function checkLedger(e) {
    if (e.kind !== 'income' && e.kind !== 'expense') return 'Choose income or expense.';
    if (!(Number.isInteger(e.amount) && e.amount >= 1 && e.amount <= 100000000)) return 'Enter an amount like 45 or 45.00.';
    if (!e.category.trim() || e.category.trim().length > 60) return 'Give it a category.';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date)) return 'Pick a date.';
    if (e.receiptUrl && !/^https:\/\/[^\s"'<>\\@]+$/.test(e.receiptUrl)) return 'A receipt link has to be a plain https:// address.';
    return '';
  }

  async function addLedger(entry) {
    const e = Object.assign({
      date: localDate(Date.now()), kind: 'expense', category: '', amount: NaN,
      counterparty: '', tuteeId: '', tutorId: '', note: '', receiptUrl: ''
    }, entry, { id: uuid(), createdAt: new Date().toISOString() });
    e.category = text(e.category); e.receiptUrl = text(e.receiptUrl).trim();
    const bad = checkLedger(e);
    if (bad) throw fail('addLedger', { message: bad });
    S.fin.ledger.set(e.id, e);
    notify();
    const { error } = await sb.from('ledger').insert(ledgerColumns(e));
    if (error) { S.fin.ledger.delete(e.id); notify(); throw fail('addLedger', error); }
    return e;
  }

  async function updateLedger(id, patch) {
    const before = S.fin.ledger.get(id);
    if (!before) return null;
    const e = Object.assign({}, before, patch, { id: id });
    e.category = text(e.category); e.receiptUrl = text(e.receiptUrl).trim();
    const bad = checkLedger(e);
    if (bad) throw fail('updateLedger', { message: bad });
    S.fin.ledger.set(id, e);
    notify();
    const { error } = await sb.from('ledger').update(ledgerColumns(e)).eq('id', id);
    if (error) { S.fin.ledger.set(id, before); notify(); throw fail('updateLedger', error); }
    return e;
  }

  async function deleteLedger(id) {
    const e = S.fin.ledger.get(id);
    if (!e) return;
    S.fin.ledger.delete(id);
    notify();
    const { error } = await sb.from('ledger').delete().eq('id', id);
    if (error) { S.fin.ledger.set(id, e); notify(); throw fail('deleteLedger', error); }
  }

  // A new rate on the same effective date replaces that row rather than
  // failing the unique constraint: that is what correcting a typo looks like.
  async function setRate(kind, personId, cents, from) {
    if (kind !== 'tutee' && kind !== 'tutor') return null;
    if (!(Number.isInteger(cents) && cents >= 0 && cents <= 10000000)) throw fail('setRate', { message: 'Enter an hourly rate like 45 or 45.00.' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(from))) throw fail('setRate', { message: 'Pick the date the rate starts.' });
    const map = S.fin.rates[kind];
    const same = Array.from(map.values()).find((r) => r.personId === personId && r.from === from);
    const r = { id: same ? same.id : uuid(), kind: kind, personId: personId, cents: cents, from: from };
    map.set(r.id, r);
    notify();
    const col = kind === 'tutee' ? 'tutee_id' : 'tutor_id';
    const { error } = await sb.from(kind + '_rates')
      .upsert({ id: r.id, [col]: personId, hourly_rate_cents: cents, effective_from: from }, { onConflict: col + ',effective_from' });
    if (error) {
      if (same) map.set(same.id, same); else map.delete(r.id);
      notify();
      throw fail('setRate', error);
    }
    return r;
  }

  async function deleteRate(kind, id) {
    const map = S.fin.rates[kind];
    const r = map && map.get(id);
    if (!r) return;
    map.delete(id);
    notify();
    const { error } = await sb.from(kind + '_rates').delete().eq('id', id);
    if (error) { map.set(id, r); notify(); throw fail('deleteRate', error); }
  }

  // Newest first: the rate on a date is the first one that started by then.
  const ratesOf = (kind, personId) => Array.from(S.fin.rates[kind].values())
    .filter((r) => r.personId === personId)
    .sort((a, b) => b.from.localeCompare(a.from));
  function rateOn(kind, personId, date) {
    const r = ratesOf(kind, personId).find((x) => x.from <= date);
    return r ? r.cents : null;
  }

  async function saveFinanceSetting(key, value) {
    if (key !== 'timezone' && key !== 'quick_categories') return;
    const prop = key === 'timezone' ? 'timezone' : 'quickCategories';
    const before = S.fin.settings[prop];
    S.fin.settings = Object.assign({}, S.fin.settings, { [prop]: value });
    notify();
    const { error } = await sb.from('finance_settings').upsert({ key: key, value: value, updated_at: new Date().toISOString() });
    if (error) {
      S.fin.settings = Object.assign({}, S.fin.settings, { [prop]: before });
      notify();
      throw fail('saveFinanceSetting', error);
    }
  }

  // Unpaid sessions older than 14 days: the Finance badge and the red tag.
  const OVERDUE_DAYS = 14;
  function overdueFinance() {
    if (!S.fin.loaded) return [];
    const cutoff = localDate(atLocal(localDate(Date.now()), '12:00', -OVERDUE_DAYS));
    return Array.from(S.fin.rows.values()).filter((f) => f.payment === 'unpaid' && f.date && f.date < cutoff);
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
    // Everything the caller may read. Only an admin's cache holds more than
    // their own tutees' rows, so for a tutor this is the same list as above.
    getAllAssignments: () => Array.from(S.assignments.values()),
    assignModule: assignModule,
    unassign: unassign,
    // For the assign screen: what a filter would select, and what it would be
    // called, before anything is written.
    getModuleTags: moduleTags,
    matchProblems: matchProblems,
    describeFilter: describeFilter,
    previewAssignment: previewAssignment,
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
    // Client-side grading for the tutor's preview only; it writes nothing.
    gradeAnswer: gradeAnswer,

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
    updateUser: updateUser,
    setUserActive: setUserActive,
    deleteUser: deleteUser,
    userDeleteCounts: userDeleteCounts,
    updateMyName: updateMyName,
    cacheImage: cacheImage,
    uploadImage: uploadImage,

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
        || String(b.createdAt).localeCompare(String(a.createdAt))),
    getLogForSession: logForSession,

    getSessions: sessionsIn,
    getSession: (id) => S.sessions.get(id) || null,
    // The rows an edit with this scope reaches ('self' | 'one' | 'future').
    getSessionScope: sessionScope,
    // Every row of this session's occurrence: one, or one per tutee of a group.
    getSessionGroup: (id) => { const s = S.sessions.get(id); return s ? groupOf(s) : []; },
    collapseSessions: collapseSessions,
    maxGroupSize: MAX_GROUP,
    createSessions: createSessions,
    updateSessions: updateSessions,
    setSessionStatus: setSessionStatus,
    moveSession: moveSession,
    deleteSession: deleteSession,
    sessionsNeedingStatus: needsStatus,
    // The next session that has not finished and is not cancelled.
    nextSession: (tuteeId) => sessionsIn({ from: Date.now(), tuteeId: tuteeId })
      .find((s) => s.status === 'scheduled') || null,
    localDate: localDate,
    localTime: localTime,
    atLocal: atLocal,

    finance: {
      ready: () => S.fin.loaded,
      error: () => S.fin.error,
      reload: loadFinance,
      rows: () => Array.from(S.fin.rows.values()),
      row: (id) => S.fin.rows.get(id) || null,
      ledger: () => Array.from(S.fin.ledger.values()),
      rates: (kind, personId) => ratesOf(kind, personId),
      rateOn: rateOn,
      settings: () => S.fin.settings,
      overdue: overdueFinance,
      overdueDays: OVERDUE_DAYS,
      updateRows: updateFinanceRows,
      deleteRow: deleteFinanceRow,
      recalc: recalcFinance,
      logManualSession: logManualSession,
      addLedger: addLedger,
      updateLedger: updateLedger,
      deleteLedger: deleteLedger,
      setRate: setRate,
      deleteRate: deleteRate,
      saveSetting: saveFinanceSetting,
      parseMoney: parseMoney,
      fmtMoney: fmtMoney,
      paymentStatuses: PAYMENT_STATUSES,
      payoutStatuses: PAYOUT_STATUSES
    },

    getAvailability: availabilityOf,
    addAvailability: addAvailability,
    removeAvailability: removeAvailability,
    isAvailable: isAvailable
  };

  // Start resolving the session now rather than waiting for the component to
  // mount, so a signed-in reload lands on the dashboard directly.
  init();
})();
