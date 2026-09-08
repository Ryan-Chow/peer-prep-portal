#!/usr/bin/env node
//
// Bulk-import SAT problems from the terminal.
//
//   SUPABASE_URL=https://xxxx.supabase.co \
//   SUPABASE_SECRET_KEY=sb_secret_... \
//   node scripts/import.js samples/sample-module.json
//
// Same parsing, validation and write logic as the admin Import tab — both go
// through importer.js — so a file that imports here imports there.
//
// No dependencies: Node 18+ has fetch, and importer.js talks to PostgREST
// directly. The key is a *secret* key and bypasses RLS, which is why this is a
// terminal tool and not something the page can do.

'use strict';

const fs = require('fs');
const path = require('path');
const ppaImport = require(path.join(__dirname, '..', 'importer.js'));

const USAGE = `
Usage: node scripts/import.js [options] <file.json> [more.json ...]

Options:
  --replace      Replace every problem in a module that already exists,
                 instead of adding to it. This deletes tutee submissions
                 for the problems it removes.
  --dry-run      Parse, validate and report. Writes nothing.
  --batch <n>    Rows per request (default ${ppaImport.BATCH_SIZE}).
  -h, --help     This text.

Environment:
  SUPABASE_URL         Project URL, e.g. https://xxxx.supabase.co
  SUPABASE_SECRET_KEY  A secret/service-role key. Never a publishable one:
                       RLS would reject every write.
`.trim();

function parseArgs(argv) {
  const opts = { files: [], replace: false, dryRun: false, batch: ppaImport.BATCH_SIZE };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '--replace') opts.replace = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--batch') {
      const n = parseInt(argv[++i], 10);
      if (!n || n < 1) fail('--batch needs a positive number.');
      opts.batch = n;
    } else if (a.startsWith('-')) fail('Unknown option ' + a + '.');
    else opts.files.push(a);
  }
  return opts;
}

function fail(msg) {
  console.error('Error: ' + msg);
  process.exit(1);
}

function plural(n, word) {
  return n + ' ' + word + (n === 1 ? '' : 's');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(USAGE); return; }
  if (!opts.files.length) { console.log(USAGE); process.exit(1); }

  if (typeof fetch !== 'function') {
    fail('This needs Node 18 or newer (it uses the built-in fetch).');
  }

  // Parse every file before touching the network, so a typo in file three does
  // not leave files one and two half-imported.
  const docs = [];
  for (const file of opts.files) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      fail('Could not read ' + file + ': ' + e.message);
    }
    const out = ppaImport.parse(text);
    if (out.error) fail(file + ': ' + out.error);
    out.docs.forEach((d) => docs.push(d));
  }

  // ---- report ----

  console.log('');
  for (const d of docs) {
    const label = d.title || '(untitled module ' + (d.index + 1) + ')';
    if (!d.importable) {
      console.log('  ✗ ' + label);
      d.errors.forEach((e) => console.log('      ' + e));
      if (!d.errors.length) console.log('      no valid problems');
    } else {
      console.log('  • ' + label + '  [' + d.subject + ']  ' +
        plural(d.validCount, 'problem') +
        (d.invalidCount ? ', ' + d.invalidCount + ' skipped' : ''));
    }
    d.problems.forEach((p) => {
      if (p.errors.length) console.log('      row ' + p.row + ': ' + p.errors.join(' '));
    });
  }

  const runnable = docs.filter((d) => d.importable);
  console.log('');
  if (!runnable.length) fail('Nothing importable.');

  if (opts.dryRun) {
    console.log('Dry run — nothing written. ' + plural(runnable.length, 'module') + ' would be imported.');
    return;
  }

  // ---- write ----

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY;
  if (!url) fail('SUPABASE_URL is not set.');
  if (!key) fail('SUPABASE_SECRET_KEY is not set.');
  if (/^sb_publishable_|^eyJ.*anon/.test(key)) {
    fail('That looks like a publishable key. Writes need a secret key.');
  }

  const modes = {};
  if (opts.replace) runnable.forEach((d) => { modes[d.slug] = 'replace'; });

  let lastLine = '';
  const summary = await ppaImport.run(docs, ppaImport.restGateway(url, key), {
    modes: modes,
    batchSize: opts.batch,
    onProgress: (p) => {
      const line = '  ' + p.done + '/' + p.total + '  ' + (p.label || '');
      if (line === lastLine) return;
      lastLine = line;
      // Overwrite in place on a terminal; append plainly when piped to a file.
      if (process.stdout.isTTY) process.stdout.write('\r\u001b[2K' + line);
      else console.log(line);
    }
  });
  if (process.stdout.isTTY) process.stdout.write('\r\u001b[2K');

  console.log('');
  console.log('  ' + plural(summary.modulesCreated, 'module') + ' created');
  console.log('  ' + plural(summary.modulesUpdated, 'module') + ' already existed');
  console.log('  ' + plural(summary.problemsInserted, 'problem') + ' inserted');
  console.log('  ' + plural(summary.problemsUpdated, 'problem') + ' updated');
  console.log('  ' + plural(summary.problemsDeleted, 'problem') + ' deleted');
  console.log('  ' + plural(summary.problemsSkipped, 'problem') + ' skipped');

  if (summary.errors.length) {
    console.log('');
    console.log('Skipped rows:');
    summary.errors.forEach((e) => {
      console.log('  ' + e.module + (e.row == null ? '' : ' row ' + e.row) + ': ' + e.message);
    });
  }
  console.log('');
}

main().catch((err) => {
  // A failure part-way through leaves earlier batches committed. The import is
  // idempotent, so the fix is to re-run the same file once the cause is dealt
  // with: rows already in are matched and updated, not duplicated.
  console.error('');
  console.error('Import stopped: ' + (err && err.message ? err.message : err));
  console.error('Anything already written stays. Re-run the same file to finish.');
  process.exit(1);
});
