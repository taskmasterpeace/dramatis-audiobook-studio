import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 4698;
const base = `http://127.0.0.1:${port}`;

async function waitForServer(child) {
  for (let i = 0; i < 50; i++) {
    if (child.exitCode !== null) throw new Error(`server exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${base}/api/books`);
      if (response.ok) return;
    } catch { /* server is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('server did not become ready');
}

test('public landing and production studio have separate routes', async (t) => {
  const child = spawn(process.execPath, ['studio/server.mjs', '--port', String(port)], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  await waitForServer(child);

  const landing = await fetch(`${base}/`);
  const landingHtml = await landing.text();
  assert.equal(landing.status, 200);
  assert.match(landingHtml, /Audio Movie Studio/);
  assert.match(landingHtml, /CLOSED BETA/i);

  const studio = await fetch(`${base}/studio`);
  const studioHtml = await studio.text();
  assert.equal(studio.status, 200);
  assert.match(studioHtml, /id="main"/);

  const api = await fetch(`${base}/api/books`);
  assert.equal(api.headers.get('content-type'), 'application/json');
  assert.ok(Array.isArray((await api.json()).books));
});
