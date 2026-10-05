// Peer Prep Academy — bulk problem import.
//
// One copy of the parsing, validation and write logic, shared by the admin
// Import tab and scripts/import.js. The two differ only in how they reach
// Postgres, which is what the "gateway" argument abstracts: the browser hands
// in a supabase-js client, the CLI hands in a bare fetch client holding a
// secret key.
//
// The import is idempotent. Running the same file twice leaves the library in
// the state the first run produced — see matchKey() for how a row in the file
// is tied to a row in the table.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else if (!root.ppaImport) root.ppaImport = factory();
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  var LETTERS = 'ABCD';
  var BATCH_SIZE = 100;
  // What the matcher reads back from a module: enough to recognise a row, and
  // the image columns a re-import carries over when the file leaves them out.
  var LIST_COLUMNS = 'id,source_id,question,sort_order,image_url,image_alt,image_position,choice_images';
  // Difficulty is not a column. It is a tag, so that one gin index over
  // problems.tags serves both "hard" and "Information and Ideas", and so a
  // problem can carry it without every other filter growing a column too.
  var DIFFICULTIES = ['easy', 'medium', 'hard'];
  // "Calculator allowed" is a tag for the same reason, and the portal reads it
  // straight out of problems.tags to decide whether to offer the Desmos panel.
  // problems_public already carries tags, so a tutee's browser can see this
  // one without a migration or a second column.
  var CALC_TAG = 'calculator';
  // Page size for reads. Comfortably under PostgREST's default row cap, so a
  // short page always means "that was the last one".
  var PAGE = 500;

  // Figures are links, never markup: a URL is only ever the src of an <img>.
  // The same test as public.is_image_url() in migrations/010, so a URL the
  // importer accepts is one the table's check constraint accepts too.
  var IMAGE_URL_RE = /^https:\/\/[^\s"'<>\\]+$/i;
  var IMAGE_POSITIONS = ['above', 'below'];
  var IMAGE_BUCKET = 'problem-images';
  var MAX_IMAGE_BYTES = 10 * 1024 * 1024;

  // The file speaks in long names because it is written by hand; the table
  // stores the short ones the rest of the app already renders.
  var TYPES = {
    multiple_choice: 'mc',
    free_response: 'free',
    // Accepted so a file exported from the database round-trips back in.
    mc: 'mc',
    free: 'free'
  };

  // ---- text handling ------------------------------------------------------

  // Question text is LaTeX-bearing prose, so it cannot simply be HTML-escaped
  // and it cannot have every "<" stripped: "$x < 5$" is ordinary maths. This
  // removes things shaped like a tag — "<" then a letter, then a tag name,
  // then either ">" or an attribute list — which leaves "<" as an operator
  // alone because a "<" followed by "5" or by "y$" never matches.
  //
  // It is defence in depth rather than the only defence. Nothing here is ever
  // injected as HTML: React escapes the prose, and KaTeX renders the maths
  // with trust off, so \href and \htmlClass cannot emit markup either.
  var TAG_RE = /<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^<>]*)?>/g;
  var CTRL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

  // \textdollar and \textpercent turn up all over the College Board exports
  // and are undefined in KaTeX's maths mode. index.html carries macros for
  // them, but these two are worth fixing in the stored text as well, because
  // \$ and \% parse in maths and in prose alike. The other three the exports
  // use — \textdegree, \textcent, \textbackslash — are left to the renderer:
  // their maths-mode spellings are not legal in text mode, so a blind rewrite
  // would break every one sitting outside a $…$.
  //
  // A control word swallows one following space, so "\textdollar 5" means
  // "$5"; keeping the space would introduce one that was never there.
  //
  // migrations/006 does exactly this to the rows already stored, and the two
  // have to stay identical: matchKey() falls back to the question text, so a
  // file normalised one way and a table normalised another would stop
  // matching, and a re-import would insert duplicates instead of updating.
  var MACRO_RE = /\\text(dollar|percent)(?![a-zA-Z])[ ]?/g;
  var MACRO_MAP = { dollar: '\\$', percent: '\\%' };

  function normalizeMacros(text) {
    return text.replace(MACRO_RE, function (m, word) { return MACRO_MAP[word]; });
  }

  function sanitizeText(value) {
    if (value == null) return '';
    return normalizeMacros(String(value).replace(TAG_RE, '').replace(CTRL_RE, '')).trim();
  }

  // A tag is a difficulty tag when it reads as one in any casing; the stored
  // form is always lower case, because that is what the assign filter and the
  // RLS-side lookups compare against.
  function difficultyOf(tag) {
    var t = String(tag == null ? '' : tag).trim().toLowerCase();
    return DIFFICULTIES.indexOf(t) >= 0 ? t : '';
  }

  // Canonically lower case for the same reason difficulty is: everything
  // downstream folds case anyway, and storing one form stops "Calculator" and
  // "calculator" reading as two different tags in a tutor's filter list.
  function calculatorOf(tag) {
    return String(tag == null ? '' : tag).trim().toLowerCase() === CALC_TAG ? CALC_TAG : '';
  }

  // { url, error }. Blank is not an error — it means "no image" — and comes
  // back as an empty url.
  function cleanImageUrl(value) {
    var raw = String(value == null ? '' : value).trim();
    if (!raw) return { url: '', error: '' };
    if (raw.length > 2048) return { url: '', error: 'is longer than 2048 characters.' };
    if (!/^https:\/\//i.test(raw)) return { url: '', error: 'must start with https://.' };
    if (!IMAGE_URL_RE.test(raw)) return { url: '', error: 'must be a plain link, with no spaces, quotes or angle brackets.' };
    var host = raw.slice(8).split(/[\/?#]/)[0];
    if (!host || host.indexOf('@') >= 0) return { url: '', error: 'needs a host name and no login details.' };
    return { url: raw, error: '' };
  }

  // What the bytes are, whatever a server's Content-Type claimed. The bucket
  // takes these four and nothing else; SVG is left out because, opened from the
  // bucket directly, it would run its scripts in the storage origin.
  function sniffImage(bytes) {
    var b = bytes;
    if (!b || b.length < 12) return null;
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { type: 'image/png', ext: 'png' };
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { type: 'image/jpeg', ext: 'jpg' };
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return { type: 'image/gif', ext: 'gif' };
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
        b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return { type: 'image/webp', ext: 'webp' };
    return null;
  }

  // Named by content, so the same picture saved twice — from the editor, by
  // cache-image, or by the CLI — is one object.
  function imagePath(hashHex, ext) {
    return 'img/' + hashHex + '.' + ext;
  }

  function slugify(title) {
    return String(title == null ? '' : title)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  // Whitespace-insensitive so re-indenting a question in the source file does
  // not read as a different problem.
  function normalizeQuestion(text) {
    return String(text == null ? '' : text).replace(/\s+/g, ' ').trim().toLowerCase();
  }

  // ---- parsing and validation --------------------------------------------

  // Accepts a JSON string or an already-parsed value. Returns
  // { error, docs } — `error` is set only when the input is not usable at
  // all; per-module and per-row problems are reported inside `docs` so the
  // preview can show the file even when parts of it are wrong.
  function parse(input) {
    var raw;
    if (typeof input === 'string') {
      var text = input.trim();
      if (!text) return { error: 'Nothing to import.', docs: [] };
      try {
        raw = JSON.parse(text);
      } catch (e) {
        return { error: 'That is not valid JSON: ' + e.message, docs: [] };
      }
    } else {
      raw = input;
    }

    var list = Array.isArray(raw) ? raw : [raw];
    if (!list.length) return { error: 'The file contains no modules.', docs: [] };

    var docs = [];
    var seenSlugs = {};
    for (var i = 0; i < list.length; i++) docs.push(readDoc(list[i], i, seenSlugs));
    return { error: '', docs: docs };
  }

  function readDoc(value, index, seenSlugs) {
    var doc = {
      index: index,
      title: '',
      subject: 'General',
      description: '',
      slug: '',
      errors: [],
      problems: []
    };

    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      doc.errors.push('Expected an object with "module" and "problems".');
      return finishDoc(doc);
    }

    var mod = value.module;
    if (!mod || typeof mod !== 'object' || Array.isArray(mod)) {
      doc.errors.push('Missing the "module" object.');
    } else {
      doc.title = sanitizeText(mod.title);
      doc.subject = sanitizeText(mod.subject) || 'General';
      doc.description = sanitizeText(mod.description);
      if (!doc.title) doc.errors.push('module.title is required.');
    }

    doc.slug = slugify(doc.title);
    if (doc.title && !doc.slug) {
      doc.errors.push('module.title needs at least one letter or digit.');
    } else if (doc.slug) {
      if (seenSlugs[doc.slug]) {
        doc.errors.push('Another module in this file already uses the name \u201c' +
          doc.title + '\u201d. Merge them, or retitle one.');
      }
      seenSlugs[doc.slug] = true;
    }

    var problems = value.problems;
    if (!Array.isArray(problems)) {
      doc.errors.push('"problems" must be an array.');
      return finishDoc(doc);
    }
    if (!problems.length) doc.errors.push('"problems" is empty.');

    // Two rows in one file claiming the same source_id would race each other:
    // the first insert wins and the second collides on the unique index.
    var seenSourceIds = {};
    for (var i = 0; i < problems.length; i++) {
      doc.problems.push(readProblem(problems[i], i, seenSourceIds));
    }
    return finishDoc(doc);
  }

  function readProblem(value, index, seenSourceIds) {
    var p = {
      index: index,
      row: index + 1,
      question: '',
      type: '',
      choices: [],
      answer: '',
      explanation: '',
      tags: [],
      difficulty: '',
      calculator: false,
      sourceId: '',
      imageUrl: '',
      imageAlt: '',
      imagePosition: 'above',
      choiceImages: null,
      // Which image fields the file actually wrote. A re-import that leaves
      // them out keeps whatever is stored — a figure attached in the editor
      // after the first import must not be wiped by the second.
      imageKeys: {},
      errors: []
    };

    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      p.errors.push('Expected an object.');
      return p;
    }

    p.question = sanitizeText(value.question);
    if (!p.question) p.errors.push('question is required.');

    var rawType = String(value.type == null ? '' : value.type).trim();
    p.type = TYPES[rawType] || '';
    if (!p.type) {
      p.errors.push(rawType
        ? 'type "' + rawType + '" is not multiple_choice or free_response.'
        : 'type is required (multiple_choice or free_response).');
    }

    p.explanation = sanitizeText(value.explanation);

    if (value.tags != null) {
      if (Array.isArray(value.tags)) {
        p.tags = value.tags.map(sanitizeText).filter(Boolean)
          .map(function (t) { return difficultyOf(t) || calculatorOf(t) || t; });
      } else {
        p.errors.push('tags must be an array of strings.');
      }
    }

    // Two ways of saying the same thing: a top-level "difficulty", or the word
    // sitting in "tags" among the topic labels. Both end up as one lower-case
    // tag, so a file written either way filters the same.
    if (value.difficulty != null && value.difficulty !== '') {
      p.difficulty = difficultyOf(value.difficulty);
      if (!p.difficulty) {
        p.errors.push('difficulty "' + sanitizeText(value.difficulty) +
          '" must be easy, medium or hard.');
      } else if (p.tags.indexOf(p.difficulty) < 0) {
        p.tags.push(p.difficulty);
      }
    }

    var levels = p.tags.filter(difficultyOf)
      .filter(function (t, i, all) { return all.indexOf(t) === i; });
    // Ambiguity is an error rather than first-one-wins: a problem tagged both
    // easy and hard would turn up in whichever pool was asked for.
    if (levels.length > 1) {
      p.errors.push('this problem has more than one difficulty (' + levels.join(', ') + ').');
    }
    if (!p.difficulty) p.difficulty = levels[0] || '';

    // Same two ways of saying it as difficulty: the flag, or the word already
    // sitting in "tags". The flag wins where they disagree, including when it
    // is false — an explicit false takes the tag away, so a re-import can
    // withdraw the calculator rather than the file being a one-way door.
    if (value.calculator != null) {
      if (typeof value.calculator !== 'boolean') {
        p.errors.push('calculator must be true or false.');
      } else if (value.calculator) {
        if (!p.tags.some(calculatorOf)) p.tags.push(CALC_TAG);
      } else {
        p.tags = p.tags.filter(function (t) { return !calculatorOf(t); });
      }
    }
    p.calculator = p.tags.some(calculatorOf);

    if (value.source_id != null && value.source_id !== '') {
      p.sourceId = sanitizeText(value.source_id);
      if (!p.sourceId) {
        p.errors.push('source_id cannot be blank.');
      } else if (seenSourceIds[p.sourceId]) {
        p.errors.push('source_id "' + p.sourceId + '" is used twice in this file.');
      } else {
        seenSourceIds[p.sourceId] = true;
      }
    }

    readImages(value, p);

    var answer = sanitizeText(value.answer);

    if (p.type === 'mc') {
      if (!Array.isArray(value.choices)) {
        p.errors.push('multiple_choice needs a "choices" array.');
      } else {
        p.choices = value.choices.map(sanitizeText);
        if (p.choices.length !== LETTERS.length) {
          p.errors.push('choices has ' + p.choices.length + ' entries; ' +
            LETTERS.length + ' (A\u2013D) are required.');
        }
        if (p.choices.some(function (c) { return !c; })) {
          p.errors.push('every choice needs text.');
        }
      }
      var letter = answer.toUpperCase();
      if (!letter) {
        p.errors.push('answer is required.');
      } else if (LETTERS.indexOf(letter) < 0 || letter.length !== 1) {
        p.errors.push('answer "' + answer + '" must be a single letter A\u2013D.');
      } else if (p.choices.length && LETTERS.indexOf(letter) >= p.choices.length) {
        p.errors.push('answer ' + letter + ' has no matching choice.');
      }
      p.answer = letter;
    } else {
      p.answer = answer;
      // Only meaningful once the type is known to be free response; a row with
      // a bad type has already been reported and would double up here.
      if (!answer && p.type === 'free') p.errors.push('answer is required.');
      if (p.type === 'free' && p.choiceImages) p.errors.push('choice_images only applies to multiple_choice.');
    }

    return p;
  }

  function readImages(value, p) {
    var has = function (k) { return Object.prototype.hasOwnProperty.call(value, k); };

    if (has('image_url')) {
      p.imageKeys.url = true;
      if (value.image_url !== null && typeof value.image_url !== 'string') {
        p.errors.push('image_url must be a string.');
      } else {
        var u = cleanImageUrl(value.image_url);
        if (u.error) p.errors.push('image_url ' + u.error);
        p.imageUrl = u.url;
      }
    }

    if (has('image_alt')) {
      p.imageKeys.alt = true;
      p.imageAlt = sanitizeText(value.image_alt).slice(0, 500);
    }

    if (has('image_position')) {
      p.imageKeys.position = true;
      var pos = String(value.image_position == null ? 'above' : value.image_position).trim().toLowerCase();
      if (IMAGE_POSITIONS.indexOf(pos) < 0) p.errors.push('image_position must be "above" or "below".');
      else p.imagePosition = pos;
    }

    if (has('choice_images')) {
      p.imageKeys.choices = true;
      var ci = value.choice_images;
      if (ci === null) {
        p.choiceImages = null;
      } else if (!Array.isArray(ci) || ci.length !== LETTERS.length) {
        p.errors.push('choice_images must be an array of ' + LETTERS.length + ' links or nulls, in A\u2013D order.');
      } else {
        var out = [];
        for (var i = 0; i < ci.length; i++) {
          if (ci[i] == null || ci[i] === '') { out.push(null); continue; }
          if (typeof ci[i] !== 'string') { p.errors.push('choice_images[' + i + '] must be a link or null.'); continue; }
          var c = cleanImageUrl(ci[i]);
          if (c.error) p.errors.push('choice_images[' + i + '] (' + LETTERS[i] + ') ' + c.error);
          out.push(c.url || null);
        }
        p.choiceImages = out.some(Boolean) ? out : null;
      }
    }
  }

  function finishDoc(doc) {
    var valid = 0;
    for (var i = 0; i < doc.problems.length; i++) {
      if (!doc.problems[i].errors.length) valid++;
    }
    doc.validCount = valid;
    doc.invalidCount = doc.problems.length - valid;
    // A module whose own fields are broken cannot be written at all; one with
    // only bad rows can, minus those rows.
    doc.importable = !doc.errors.length && valid > 0;
    return doc;
  }

  // A row in the file is the same problem as a row in the table when their
  // source_ids match. Files without source_ids fall back to the question
  // text, so that re-importing one still updates rather than duplicating.
  function matchKey(problem) {
    return problem.sourceId
      ? 'src:' + problem.sourceId
      : 'q:' + normalizeQuestion(problem.question);
  }

  function rowMatchKey(row) {
    return row.source_id
      ? 'src:' + row.source_id
      : 'q:' + normalizeQuestion(row.question);
  }

  function chunk(list, size) {
    var out = [];
    for (var i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
    return out;
  }

  // ---- writing ------------------------------------------------------------

  // docs      output of parse()
  // gateway   see supabaseGateway() / restGateway()
  // opts      { modes: { slug: 'add' | 'replace' }, batchSize, onProgress }
  //
  // 'add'     leaves problems already in the module alone unless the file
  //           names them again, in which case they are updated in place.
  // 'replace' deletes every problem in the module first. That cascades to
  //           submissions, so a tutee's answers to the old problems go with
  //           them; the UI says so before running it.
  async function run(docs, gateway, opts) {
    opts = opts || {};
    var modes = opts.modes || {};
    var batchSize = opts.batchSize || BATCH_SIZE;
    var onProgress = opts.onProgress || function () {};

    var summary = {
      modulesCreated: 0,
      modulesUpdated: 0,
      problemsInserted: 0,
      problemsUpdated: 0,
      problemsDeleted: 0,
      problemsSkipped: 0,
      errors: []
    };

    var runnable = docs.filter(function (d) { return d.importable; });
    docs.forEach(function (d) {
      if (d.importable) {
        summary.problemsSkipped += d.invalidCount;
        d.problems.forEach(function (p) {
          if (p.errors.length) {
            summary.errors.push({ module: d.title, row: p.row, message: p.errors[0] });
          }
        });
      } else {
        summary.problemsSkipped += d.problems.length;
        summary.errors.push({
          module: d.title || 'Module ' + (d.index + 1),
          row: null,
          message: d.errors[0] || 'Nothing importable in this module.'
        });
      }
    });

    // Every valid row is one unit of work, plus one per module for the
    // lookup/create round trip, so the bar moves on small files too.
    var total = runnable.reduce(function (n, d) { return n + d.validCount + 1; }, 0);
    var done = 0;
    var tick = function (n, label) {
      done += n;
      onProgress({ done: done, total: total, label: label });
    };

    for (var i = 0; i < runnable.length; i++) {
      var doc = runnable[i];
      await importDoc(doc, gateway, modes[doc.slug] || 'add', batchSize, summary, tick);
    }

    onProgress({ done: total, total: total, label: 'Done' });
    return summary;
  }

  async function importDoc(doc, gateway, mode, batchSize, summary, tick) {
    tick(0, 'Reading \u201c' + doc.title + '\u201d\u2026');

    var existingModule = await gateway.findModuleBySlug(doc.slug);
    var moduleId;
    var existingRows = [];

    if (existingModule) {
      moduleId = existingModule.id;
      // The file is authoritative for the module's own fields.
      await gateway.updateModule(moduleId, {
        title: doc.title,
        subject: doc.subject,
        description: doc.description
      });
      summary.modulesUpdated += 1;

      if (mode === 'replace') {
        summary.problemsDeleted += await gateway.deleteProblemsOfModule(moduleId);
      } else {
        existingRows = await gateway.listProblems(moduleId);
      }
    } else {
      var created = await gateway.createModule({
        title: doc.title,
        subject: doc.subject,
        description: doc.description,
        slug: doc.slug
      });
      moduleId = created.id;
      summary.modulesCreated += 1;
    }
    tick(1, '\u201c' + doc.title + '\u201d');

    var byKey = {};
    existingRows.forEach(function (row) { byKey[rowMatchKey(row)] = row; });

    var maxOrder = existingRows.reduce(function (n, row) {
      return Math.max(n, typeof row.sort_order === 'number' ? row.sort_order : 0);
    }, -1);

    var valid = doc.problems.filter(function (p) { return !p.errors.length; });

    // A source_id names one problem library-wide, so one already spoken for by
    // a different module cannot be inserted here — the unique index would
    // reject the whole batch. Find those first and set them aside.
    var sourceIds = valid.map(function (p) { return p.sourceId; }).filter(Boolean);
    var claimed = {};
    // Chunked because these go into the query string, and a few thousand ids
    // would overrun the URL length PostgREST accepts. Never more than a page
    // per chunk whatever --batch says: source_id is unique, so a chunk of N ids
    // matches at most N rows, and keeping N under the row cap is what stops the
    // reply being truncated. A truncated reply here reads as "not claimed", and
    // the insert that followed would hit the unique index and fail the import.
    var idBatches = chunk(sourceIds, Math.min(batchSize, PAGE));
    for (var b = 0; b < idBatches.length; b++) {
      var rows = await gateway.findProblemsBySourceIds(idBatches[b]);
      rows.forEach(function (row) {
        if (row.module_id !== moduleId) claimed[row.source_id] = row;
      });
    }

    var inserts = [];
    var updates = [];
    var appended = 0;

    valid.forEach(function (p, position) {
      if (p.sourceId && claimed[p.sourceId]) {
        summary.problemsSkipped += 1;
        summary.errors.push({
          module: doc.title,
          row: p.row,
          message: 'source_id "' + p.sourceId + '" already belongs to another module.'
        });
        return;
      }

      var match = byKey[matchKey(p)];
      var img = imageColumns(p, match);
      if (match) {
        updates.push({
          id: match.id,
          module_id: moduleId,
          question: p.question,
          type: p.type,
          choices: p.type === 'mc' ? p.choices : null,
          answer: p.answer,
          explanation: p.explanation,
          tags: p.tags.length ? p.tags : null,
          source_id: p.sourceId || null,
          image_url: img.image_url,
          image_alt: img.image_alt,
          image_position: img.image_position,
          choice_images: img.choice_images,
          // Keep the order the module already had; the file is being used to
          // correct content, not to reshuffle a module a tutee is part-way
          // through.
          sort_order: typeof match.sort_order === 'number' ? match.sort_order : position
        });
      } else {
        inserts.push({
          module_id: moduleId,
          question: p.question,
          type: p.type,
          choices: p.type === 'mc' ? p.choices : null,
          answer: p.answer,
          explanation: p.explanation,
          tags: p.tags.length ? p.tags : null,
          source_id: p.sourceId || null,
          image_url: img.image_url,
          image_alt: img.image_alt,
          image_position: img.image_position,
          choice_images: img.choice_images,
          sort_order: maxOrder + 1 + appended
        });
        appended += 1;
      }
    });

    var batches = chunk(inserts, batchSize);
    for (var i = 0; i < batches.length; i++) {
      await gateway.insertProblems(batches[i]);
      summary.problemsInserted += batches[i].length;
      tick(batches[i].length, 'Inserting into \u201c' + doc.title + '\u201d\u2026');
    }

    var upBatches = chunk(updates, batchSize);
    for (var j = 0; j < upBatches.length; j++) {
      await gateway.updateProblems(upBatches[j]);
      summary.problemsUpdated += upBatches[j].length;
      tick(upBatches[j].length, 'Updating \u201c' + doc.title + '\u201d\u2026');
    }
  }

  // Every row in a batch carries all four columns, whether or not the file
  // mentioned them: PostgREST takes a bulk write's columns from the rows, and a
  // row missing a key would have it written as null. So a field the file left
  // out is carried over from the stored row instead.
  function imageColumns(p, match) {
    var k = p.imageKeys || {};
    var m = match || {};
    return {
      image_url: k.url ? (p.imageUrl || null) : (m.image_url || null),
      image_alt: k.alt ? (p.imageAlt || null) : (m.image_alt || null),
      image_position: k.position ? p.imagePosition : (m.image_position || 'above'),
      choice_images: k.choices ? p.choiceImages : (Array.isArray(m.choice_images) ? m.choice_images : null)
    };
  }

  // Swaps every image link in the valid rows of `docs` for the URL `cache`
  // resolves it to, in place. `cache(url)` returns a promise of the new URL.
  // Each distinct link is fetched once. A link that fails keeps its original
  // URL and is reported, so one dead image does not stop the import.
  async function cacheDocImages(docs, cache, onProgress) {
    var seen = {};
    var report = { cached: 0, failed: [] };
    var jobs = [];
    docs.forEach(function (d) {
      if (!d.importable) return;
      d.problems.forEach(function (p) {
        if (p.errors.length) return;
        if (p.imageUrl) jobs.push({ doc: d, p: p, slot: -1, url: p.imageUrl });
        (p.choiceImages || []).forEach(function (u, i) {
          if (u) jobs.push({ doc: d, p: p, slot: i, url: u });
        });
      });
    });
    for (var j = 0; j < jobs.length; j++) {
      var job = jobs[j];
      if (!Object.prototype.hasOwnProperty.call(seen, job.url)) {
        try {
          seen[job.url] = { url: await cache(job.url) };
          report.cached += 1;
        } catch (e) {
          seen[job.url] = { error: (e && e.message) || String(e) };
        }
      }
      var hit = seen[job.url];
      if (hit.error) {
        report.failed.push({ module: job.doc.title, row: job.p.row, url: job.url, message: hit.error });
      } else if (job.slot < 0) {
        job.p.imageUrl = hit.url;
      } else {
        job.p.choiceImages[job.slot] = hit.url;
      }
      if (onProgress) onProgress({ done: j + 1, total: jobs.length, url: job.url });
    }
    return report;
  }

  // ---- gateways -----------------------------------------------------------

  // supabase-js, already carrying the signed-in admin's access token. RLS lets
  // only role='admin' through, so this needs no key the page does not have.
  function supabaseGateway(client) {
    var unwrap = function (res, what) {
      if (res.error) throw new Error(what + ': ' + res.error.message);
      return res.data;
    };
    return {
      async findModuleBySlug(slug) {
        var res = await client.from('modules').select('id,title,subject,description,slug')
          .eq('slug', slug).maybeSingle();
        return unwrap(res, 'looking up the module');
      },
      async createModule(patch) {
        var res = await client.from('modules').insert(patch).select('id').single();
        return unwrap(res, 'creating the module');
      },
      async updateModule(id, patch) {
        var res = await client.from('modules').update(patch).eq('id', id);
        unwrap(res, 'updating the module');
      },
      // Paged: PostgREST caps a response at max-rows, and a module that came
      // back truncated would look half-empty to the matcher, which would then
      // re-insert everything it could not see. id breaks ties because nothing
      // stops two problems sharing a sort_order, and a tie spanning a page
      // boundary would let a row repeat while another was skipped.
      async listProblems(moduleId) {
        var out = [];
        for (var from = 0; ; from += PAGE) {
          var res = await client.from('problems').select(LIST_COLUMNS)
            .eq('module_id', moduleId).order('sort_order').order('id').range(from, from + PAGE - 1);
          var page = unwrap(res, 'reading existing problems') || [];
          out = out.concat(page);
          if (page.length < PAGE) return out;
        }
      },
      async findProblemsBySourceIds(ids) {
        var res = await client.from('problems').select('id,source_id,module_id')
          .in('source_id', ids);
        return unwrap(res, 'checking source ids') || [];
      },
      async deleteProblemsOfModule(moduleId) {
        var res = await client.from('problems').delete().eq('module_id', moduleId).select('id');
        return (unwrap(res, 'clearing the module') || []).length;
      },
      async insertProblems(rows) {
        var res = await client.from('problems').insert(rows);
        unwrap(res, 'inserting problems');
      },
      async updateProblems(rows) {
        // Every row carries its primary key, so this resolves to an update.
        var res = await client.from('problems').upsert(rows, { onConflict: 'id' });
        unwrap(res, 'updating problems');
      }
    };
  }

  // PostgREST over plain fetch, for the CLI: Node 18+ has fetch built in, so
  // scripts/import.js needs nothing installed. `key` is a secret key and must
  // never reach a browser.
  function restGateway(url, key) {
    var base = String(url).replace(/\/+$/, '') + '/rest/v1/';
    var headers = {
      apikey: key,
      Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json'
    };

    async function call(path, init, what) {
      var res = await fetch(base + path, Object.assign({ headers: headers }, init));
      var text = await res.text();
      if (!res.ok) {
        var detail = text;
        try { detail = (JSON.parse(text).message) || text; } catch (e) {}
        throw new Error(what + ' failed (' + res.status + '): ' + detail);
      }
      if (!text) return null;
      try { return JSON.parse(text); } catch (e) { return null; }
    }

    // PostgREST's in.() list is comma separated with double-quoted members.
    var inList = function (values) {
      return '(' + values.map(function (v) {
        return '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
      }).join(',') + ')';
    };
    var eq = function (value) { return 'eq.' + encodeURIComponent(value); };

    return {
      async findModuleBySlug(slug) {
        var rows = await call('modules?slug=' + eq(slug) +
          '&select=id,title,subject,description,slug&limit=1', { method: 'GET' },
          'Looking up the module');
        return (rows && rows[0]) || null;
      },
      async createModule(patch) {
        var rows = await call('modules?select=id', {
          method: 'POST',
          headers: Object.assign({}, headers, { Prefer: 'return=representation' }),
          body: JSON.stringify(patch)
        }, 'Creating the module');
        return rows[0];
      },
      async updateModule(id, patch) {
        await call('modules?id=' + eq(id), {
          method: 'PATCH',
          body: JSON.stringify(patch)
        }, 'Updating the module');
      },
      async listProblems(moduleId) {
        var out = [];
        for (var from = 0; ; from += PAGE) {
          var page = (await call('problems?module_id=' + eq(moduleId) +
            '&select=' + LIST_COLUMNS + '&order=sort_order,id' +
            '&offset=' + from + '&limit=' + PAGE, { method: 'GET' },
            'Reading existing problems')) || [];
          out = out.concat(page);
          if (page.length < PAGE) return out;
        }
      },
      async findProblemsBySourceIds(ids) {
        return (await call('problems?source_id=in.' + encodeURIComponent(inList(ids)) +
          '&select=id,source_id,module_id', { method: 'GET' },
          'Checking source ids')) || [];
      },
      async deleteProblemsOfModule(moduleId) {
        var rows = await call('problems?module_id=' + eq(moduleId) + '&select=id', {
          method: 'DELETE',
          headers: Object.assign({}, headers, { Prefer: 'return=representation' })
        }, 'Clearing the module');
        return (rows || []).length;
      },
      async insertProblems(rows) {
        await call('problems', { method: 'POST', body: JSON.stringify(rows) },
          'Inserting problems');
      },
      async updateProblems(rows) {
        await call('problems', {
          method: 'POST',
          headers: Object.assign({}, headers, { Prefer: 'resolution=merge-duplicates' }),
          body: JSON.stringify(rows)
        }, 'Updating problems');
      },
      // Storage, not PostgREST, but the same key. x-upsert because the name is
      // the content's hash: an object already there is this very image.
      async uploadImage(path, bytes, contentType) {
        var root = String(url).replace(/\/+$/, '') + '/storage/v1/object/';
        var res = await fetch(root + IMAGE_BUCKET + '/' + path, {
          method: 'POST',
          headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': contentType, 'x-upsert': 'true', 'cache-control': 'max-age=31536000' },
          body: bytes
        });
        if (!res.ok) {
          var text = await res.text();
          throw new Error('Storing the image failed (' + res.status + '): ' + text.slice(0, 200));
        }
        return root + 'public/' + IMAGE_BUCKET + '/' + path;
      }
    };
  }

  return {
    BATCH_SIZE: BATCH_SIZE,
    LETTERS: LETTERS,
    DIFFICULTIES: DIFFICULTIES,
    difficultyOf: difficultyOf,
    CALC_TAG: CALC_TAG,
    calculatorOf: calculatorOf,
    parse: parse,
    run: run,
    IMAGE_BUCKET: IMAGE_BUCKET,
    MAX_IMAGE_BYTES: MAX_IMAGE_BYTES,
    IMAGE_POSITIONS: IMAGE_POSITIONS,
    cleanImageUrl: cleanImageUrl,
    sniffImage: sniffImage,
    imagePath: imagePath,
    cacheDocImages: cacheDocImages,
    slugify: slugify,
    sanitizeText: sanitizeText,
    supabaseGateway: supabaseGateway,
    restGateway: restGateway
  };
});
