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
const crypto = require('crypto');
const ppaImport = require(path.join(__dirname, '..', 'importer.js'));

const USAGE = `
Usage: node scripts/import.js [options] <file.json> [more.json ...]

Options:
  --replace      Replace every problem in a module that already exists,
                 instead of adding to it. This deletes tutee submissions
                 for the problems it removes.
  --dry-run      Parse, validate and report. Writes nothing.
  --cache-images Download every image link in the file and store a copy in
                 the problem-images bucket, then import with the bucket URLs
                 in place of the originals. A link that cannot be fetched
                 keeps its original URL and is listed at the end.
  --batch <n>    Rows per request (default ${ppaImport.BATCH_SIZE}).
  -h, --help     This text.

Environment:
  SUPABASE_URL         Project URL, e.g. https://xxxx.supabase.co
  SUPABASE_SECRET_KEY  A secret/service-role key. Never a publishable one:
                       RLS would reject every write.
`.trim();

function parseArgs(argv) {
  const opts = { files: [], replace: false, dryRun: false, cacheImages: false, batch: ppaImport.BATCH_SIZE };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '--replace') opts.replace = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--cache-images') opts.cacheImages = true;
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

// The cache-image Edge Function's job, done from this machine: download, check
// the bytes really are an image, and store them under their own hash. Same
// bucket, same names, so a figure the editor already copied is not stored
// twice. A link already in the bucket is left as it is.
function imageCacher(url, gateway) {
  const ours = String(url).replace(/\/+$/, '') + '/storage/v1/object/public/' + ppaImport.IMAGE_BUCKET + '/';
  return async (link) => {
    if (link.startsWith(ours)) return link;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    let res;
    try {
      res = await fetch(link, { signal: ctrl.signal, redirect: 'follow' });
    } catch (e) {
      throw new Error(e.name === 'AbortError' ? 'timed out' : 'could not be downloaded (' + e.message + ')');
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > ppaImport.MAX_IMAGE_BYTES) throw new Error('larger than 10 MB');
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > ppaImport.MAX_IMAGE_BYTES) throw new Error('larger than 10 MB');
    const kind = ppaImport.sniffImage(bytes);
    if (!kind) throw new Error('not a PNG, JPEG, GIF or WebP image');
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    return gateway.uploadImage(ppaImport.imagePath(hash, kind.ext), bytes, kind.type);
  };
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
      // Tutors assign by difficulty, so a module that turns out to be
      // entirely untagged is worth seeing before it is written, not after
      // "Hard — 10 random" comes back with nothing to choose from.
      const byLevel = {};
      d.problems.forEach((p) => {
        if (p.errors.length) return;
        const k = p.difficulty || '(none)';
        byLevel[k] = (byLevel[k] || 0) + 1;
      });
      const levels = ppaImport.DIFFICULTIES.concat('(none)')
        .filter((k) => byLevel[k])
        .map((k) => byLevel[k] + ' ' + k);
      if (levels.length) console.log('      difficulty: ' + levels.join(', '));
      // Only printed when something carries it. The count is the one cheap
      // check that the flag landed on the rows meant to have it — otherwise
      // it stays invisible until a tutee opens a problem and finds no
      // calculator, or finds one they should not have had.
      const calc = d.problems.filter((p) => !p.errors.length && p.calculator).length;
      if (calc) console.log('      calculator: ' + calc + ' of ' + d.validCount);
      const pics = d.problems.filter((p) => !p.errors.length && (p.imageUrl || p.choiceImages)).length;
      if (pics) console.log('      images: ' + pics + ' of ' + d.validCount);
    }
    d.problems.forEach((p) => {
      if (p.errors.length) console.log('      row ' + p.row + ': ' + p.errors.join(' '));
    });
  }

  const runnable = docs.filter((d) => d.importable);
  console.log('');
  if (!runnable.length) fail('Nothing importable.');

  if (opts.dryRun) {
    if (opts.cacheImages) {
      const links = new Set();
      runnable.forEach((d) => d.problems.forEach((p) => {
        if (p.errors.length) return;
        if (p.imageUrl) links.add(p.imageUrl);
        (p.choiceImages || []).forEach((u) => { if (u) links.add(u); });
      }));
      console.log('--cache-images would copy ' + plural(links.size, 'image link') + '.');
    }
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

  const gateway = ppaImport.restGateway(url, key);

  let imageReport = null;
  if (opts.cacheImages) {
    imageReport = await ppaImport.cacheDocImages(docs, imageCacher(url, gateway), (p) => {
      const line = '  images ' + p.done + '/' + p.total;
      if (process.stdout.isTTY) process.stdout.write('\r\u001b[2K' + line);
      else console.log(line);
    });
    if (process.stdout.isTTY) process.stdout.write('\r\u001b[2K');
    console.log('  ' + plural(imageReport.cached, 'image') + ' copied to storage' +
      (imageReport.failed.length ? ', ' + imageReport.failed.length + ' kept as links (see below)' : ''));
  }

  const modes = {};
  if (opts.replace) runnable.forEach((d) => { modes[d.slug] = 'replace'; });

  let lastLine = '';
  const summary = await ppaImport.run(docs, gateway, {
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

  if (imageReport && imageReport.failed.length) {
    console.log('');
    console.log('Images not copied (imported with their original link):');
    imageReport.failed.forEach((f) => {
      console.log('  ' + f.module + ' row ' + f.row + ': ' + f.url + ' \u2014 ' + f.message);
    });
  }

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
