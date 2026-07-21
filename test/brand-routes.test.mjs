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
  const landingText = landingHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  assert.equal(landing.status, 200);
  assert.match(landingHtml, /Audio Movie Studio/);
  assert.match(landingHtml, /CLOSED BETA/i);
  assert.match(landingText, /Write the story\. Direct the performance\. Build the world in sound\./);
  for (const audience of ['Authors', 'Filmmakers', 'Developers']) assert.match(landingHtml, new RegExp(audience));
  for (const stage of ['Compile', 'Cast', 'Perform', 'Sound Design', 'Mix', 'Master']) assert.match(landingHtml, new RegExp(stage));
  for (const stem of ['Dialogue', 'Ambience', 'SFX', 'Score']) assert.match(landingHtml, new RegExp(stem, 'i'));
  assert.match(landingHtml, /Request beta access/);
  assert.match(landingHtml, /href="\/studio"/);
  assert.match(landingHtml, /<canvas[^>]+id="hero-canvas"/);
  assert.match(landingHtml, /\/shared\/logo-mark\.svg/);

  const landingCss = await fetch(`${base}/landing/landing.css`);
  assert.equal(landingCss.status, 200);
  const landingCssText = await landingCss.text();
  assert.match(landingCssText, /prefers-reduced-motion/);
  assert.match(landingCssText, /\.site-nav\{[^}]*height:100vh/s, 'mobile menu must translate by a viewport-height box');

  for (const asset of ['landing.js', 'hero-scene.js']) {
    const script = await fetch(`${base}/landing/${asset}`);
    assert.equal(script.status, 200, `${asset} should exist`);
    assert.match(script.headers.get('content-type'), /text\/javascript/);
  }

  const studio = await fetch(`${base}/studio`);
  const studioHtml = await studio.text();
  assert.equal(studio.status, 200);
  assert.match(studioHtml, /id="main"/);
  assert.match(studioHtml, /Audio Movie Studio/);
  assert.doesNotMatch(studioHtml, /\/logo\.png/);

  for (const asset of ['logo-mark.svg', 'logo-horizontal.svg', 'logo-stacked.svg']) {
    const logo = await fetch(`${base}/shared/${asset}`);
    assert.equal(logo.status, 200, `${asset} should exist`);
    assert.equal(logo.headers.get('content-type'), 'image/svg+xml');
    assert.match(await logo.text(), /Audio Movie Studio/);
  }

  const api = await fetch(`${base}/api/books`);
  assert.equal(api.headers.get('content-type'), 'application/json');
  assert.ok(Array.isArray((await api.json()).books));
});
