#!/usr/bin/env node
// Studio smoke test: boots the server on a test port, exercises every read
// route against the real repo, round-trips a hint write, and exits 0/1.
//   node studio/smoke.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4699;
const base = `http://localhost:${PORT}`;
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
  if (!ok) failures++;
};

const server = spawn(process.execPath, [path.join(root, 'studio', 'server.mjs'), '--port', String(PORT)], { cwd: root });
let up = false;
server.stdout.on('data', (d) => { if (/Studio at/.test(d.toString())) up = true; });
server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

const until = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 150)); } return false; };

try {
  check('server boots', await until(() => up, 8000));

  const app = await fetch(base + '/');
  check('GET / serves app', app.ok && (await app.text()).includes('DRAMATIS'));

  const books = await (await fetch(base + '/api/books')).json();
  check('GET /api/books lists books', Array.isArray(books.books) && books.books.length >= 3, `${books.books?.length} books`);
  const withAudio = books.books.find((b) => b.minutes > 0);
  check('rollup has minutes + spend', !!withAudio && typeof withAudio.spend.llmUsd === 'number', withAudio && `${withAudio.id}: ${withAudio.minutes} min`);

  const id = 'open-window';
  const detail = await (await fetch(`${base}/api/books/${id}`)).json();
  check('GET book detail: chapters + preflight', detail.chapters?.length === 1 && detail.preflight?.hero > 0,
    detail.preflight && `hero=${detail.preflight.hero} (${detail.preflight.heroChars} chars)`);
  check('chapter has media path', !!detail.chapters[0].media);

  const media = await fetch(base + detail.chapters[0].media, { headers: { Range: 'bytes=0-999' } });
  check('media Range request -> 206', media.status === 206 && media.headers.get('content-range')?.startsWith('bytes 0-999/'));

  const script = await fetch(`${base}/media/${id}/ch-01/production-script.json`);
  check('production script served', script.ok && (await script.json()).scenes?.length > 0);

  // hint round-trip on a copy-safe book (write + verify + revert)
  const bookFile = path.join(root, 'books', id, 'book.json');
  const before = readFileSync(bookFile, 'utf8');
  const hint = { match: '__smoke_test_hint__', entity: 'vera' };
  const post = await fetch(`${base}/api/books/${id}/hints`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(hint) });
  const after = JSON.parse(readFileSync(bookFile, 'utf8'));
  check('POST hint writes book.json atomically', post.ok && after.hints.some((h) => h.match === '__smoke_test_hint__'));
  writeFileSync(bookFile, before); // revert
  check('revert clean', !readFileSync(bookFile, 'utf8').includes('__smoke_test_hint__'));

  const busy = await (await fetch(base + '/api/render/status')).json();
  check('render status route', 'job' in busy);

  const badRender = await fetch(base + '/api/render', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ book: 'no-such-book' }) });
  check('render rejects unknown book', badRender.status === 404);

  const bad = await fetch(base + '/media/../../secrets');
  check('media path traversal blocked', bad.status === 404);
} catch (e) {
  check('unexpected error', false, String(e.message));
} finally {
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
  server.on('exit', () => process.exit(failures ? 1 : 0));
  server.kill();
  setTimeout(() => process.exit(failures ? 1 : 0), 3000); // belt and braces
}
