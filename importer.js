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
  // Page size for reads. Comfortably under PostgREST's default row cap, so a
  // short page always means "that was the last one".
  var PAGE = 500;

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

  function sanitizeText(value) {
    if (value == null) return '';
    return String(value).replace(TAG_RE, '').replace(CTRL_RE, '').trim();
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
      sourceId: '',
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
        p.tags = value.tags.map(sanitizeText).filter(Boolean);
      } else {
        p.errors.push('tags must be an array of strings.');
      }
    }

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
    }

    return p;
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
    // would overrun the URL length PostgREST accepts.
    var idBatches = chunk(sourceIds, batchSize);
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
      // re-insert everything it could not see.
      async listProblems(moduleId) {
        var out = [];
        for (var from = 0; ; from += PAGE) {
          var res = await client.from('problems').select('id,source_id,question,sort_order')
            .eq('module_id', moduleId).order('sort_order').range(from, from + PAGE - 1);
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
            '&select=id,source_id,question,sort_order&order=sort_order' +
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
      }
    };
  }

  return {
    BATCH_SIZE: BATCH_SIZE,
    LETTERS: LETTERS,
    parse: parse,
    run: run,
    slugify: slugify,
    sanitizeText: sanitizeText,
    supabaseGateway: supabaseGateway,
    restGateway: restGateway
  };
});
