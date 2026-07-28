// Regression test for the 2026-07-27 "the gate refused it, the cache shipped it"
// defect.
//
// THE INCIDENT: synthJob wrote every attempt straight to the CONTENT-ADDRESSED
// path. When the duration gate rejected all 3 attempts it threw — but attempt
// 3's over-long audio was sitting at <key>.wav. The next run called cached(),
// saw the file, reported "cache hit", and served the exact audio the gate had
// just refused. Law 1 (machine gates) defeated by law 5's own mechanism, and
// invisible: the second run logs success.
//
// The fix renders to a .pending.wav and RENAMES on pass, so the cache key is
// only ever published for audio that cleared the gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, readdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { renderLines } from '../engines/tts/gemini.mjs';

// a real, decodable wav far longer than any short line justifies
function longWavBytes(seconds) {
  const f = path.join(mkdtempSync(path.join(tmpdir(), 'gem-gate-')), 'long.wav');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `anullsrc=r=24000:cl=mono`,
    '-t', String(seconds), '-y', f]);
  return readFileSync(f);
}

async function renderWithStub(bytes, cacheRoot, text) {
  const realFetch = globalThis.fetch;
  const hadTok = 'REPLICATE_API_TOKEN' in process.env;
  const oldTok = process.env.REPLICATE_API_TOKEN;
  process.env.REPLICATE_API_TOKEN = 'test-token';
  globalThis.fetch = async (url) => (String(url).includes('/predictions')
    ? { ok: true, json: async () => ({ status: 'succeeded', output: 'https://example.invalid/a.wav' }) }
    : { ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
  try {
    return await renderLines(
      [{ id: 'l1', kind: 'narration', entity: 'narrator', text }],
      { narrator: { voice: 'Kore', prompt: 'A test voice.' } }, cacheRoot,
    );
  } finally {
    globalThis.fetch = realFetch;
    if (hadTok) process.env.REPLICATE_API_TOKEN = oldTok; else delete process.env.REPLICATE_API_TOKEN;
  }
}

const wavsIn = (dir) => {
  const cache = path.join(dir, 'cache');
  return existsSync(cache) ? readdirSync(cache).filter((f) => f.endsWith('.wav')) : [];
};

test('a gate-rejected render leaves NOTHING at the cache key', async () => {
  const cacheRoot = mkdtempSync(path.join(tmpdir(), 'gem-cache-'));
  const bytes = longWavBytes(60);                    // 60 s for an 11-char line

  await assert.rejects(
    () => renderWithStub(bytes, cacheRoot, 'Short line.'),
    /ran far longer than the text warrants/,
    'the gate must still refuse the render',
  );

  // THE REGRESSION: before the fix this directory held attempt 3's 60 s audio,
  // and the next run served it as a cache hit.
  assert.deepEqual(wavsIn(cacheRoot), [],
    'a refused render must not leave audio at the content-addressed key');
});

test('a render that passes the gate IS published to the cache key', async () => {
  const cacheRoot = mkdtempSync(path.join(tmpdir(), 'gem-cache-ok-'));
  const bytes = longWavBytes(1);                     // 1 s is well inside budget

  const out = await renderWithStub(bytes, cacheRoot, 'Short line.');
  assert.ok(out.l1, 'renderLines should return a path');
  assert.equal(wavsIn(cacheRoot).length, 1, 'the accepted take should be cached');
  assert.ok(!wavsIn(cacheRoot).some((f) => f.includes('.pending.')),
    'no .pending. scratch file may survive a successful render');
});
