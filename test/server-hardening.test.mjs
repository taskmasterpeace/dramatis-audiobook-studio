// Regression tests for the 2026-07-27 crash class.
//
// THE INCIDENT: `GET /actors/` streamed a DIRECTORY. Four static routes checked
// existsSync but not isFile(), and piped without an 'error' handler, so the
// EISDIR surfaced as an uncaught error event and the process EXITED. Reachable
// from any web page the user visits (<img src="http://localhost:4600/actors/">),
// and it orphaned any running render. A hostile `Range:` header killed it the
// same way — the stream threw AFTER writeHead(206), so the error path hit
// ERR_HTTP_HEADERS_SENT inside the catch.
//
// These tests drive a REAL server over HTTP, because that is the only place the
// bug existed: every one of these requests returned a well-formed 404/416 in
// unit-land and still killed the process in production.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readdirSync, statSync } from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4788;
const base = `http://127.0.0.1:${PORT}`;

let child;
test.before(async () => {
  child = spawn(process.execPath, [path.join(root, 'studio', 'server.mjs'), '--port', String(PORT)],
    { cwd: root, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {                       // wait for listen
    try { await fetch(`${base}/api/books`); return; } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  throw new Error('studio server did not start');
});
test.after(() => child?.kill());

const alive = async () => (await fetch(`${base}/api/books`)).ok;

test('a directory request 404s instead of killing the server', async () => {
  for (const p of ['/actors/', '/corpus/', '/bookart/', '/actors/liu-xiao']) {
    const res = await fetch(base + p);
    assert.equal(res.status, 404, `${p} should 404`);
    await res.arrayBuffer();
    assert.ok(await alive(), `server died after ${p}`);   // the actual regression
  }
});

test('hostile Range headers yield 416, never a crash', async () => {
  // find any real file under out/ to range over; skip if the checkout is bare
  const out = path.join(root, 'out');
  const find = (dir, depth = 0) => {
    if (depth > 3 || !existsSync(dir)) return null;
    for (const e of readdirSync(dir)) {
      const f = path.join(dir, e);
      const st = statSync(f);
      if (st.isFile() && st.size > 1000) return f;
      if (st.isDirectory()) { const hit = find(f, depth + 1); if (hit) return hit; }
    }
    return null;
  };
  const file = find(out);
  if (!file) { console.log('  (no rendered media in out/ — Range test skipped)'); return; }
  const rel = path.relative(out, file).split(path.sep).join('/');
  const size = statSync(file).size;

  const unsatisfiable = ['bytes=99999999-', 'bytes=5-2'];
  for (const r of unsatisfiable) {
    const res = await fetch(`${base}/media/${rel}`, { headers: { Range: r } });
    await res.arrayBuffer();
    assert.equal(res.status, 416, `${r} should be 416`);
    assert.ok(await alive(), `server died on Range ${r}`);
  }

  // suffix range means the LAST n bytes, not the first n+1
  const suffix = await fetch(`${base}/media/${rel}`, { headers: { Range: 'bytes=-50' } });
  assert.equal(suffix.status, 206);
  assert.equal((await suffix.arrayBuffer()).byteLength, 50);

  // an over-long end is clamped, and Content-Length must not lie
  const over = await fetch(`${base}/media/${rel}`, { headers: { Range: 'bytes=0-999999999' } });
  assert.equal(over.status, 206);
  const got = (await over.arrayBuffer()).byteLength;
  assert.equal(got, size, 'clamped body should be the whole file');
  assert.equal(+over.headers.get('content-length'), size, 'Content-Length must match what is sent');
  assert.ok(await alive());
});

test('a sibling directory sharing the route prefix is not readable', async () => {
  // actors-tenants/ shares the "actors" prefix; startsWith(root) without a
  // separator would let it through and leak another tenant's seed clip.
  const res = await fetch(`${base}/actors/..%2factors-tenants%2fsomebody%2fseed.wav`);
  await res.arrayBuffer();
  assert.equal(res.status, 404);
  assert.ok(await alive());
});
