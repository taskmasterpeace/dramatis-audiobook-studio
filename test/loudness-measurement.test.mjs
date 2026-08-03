// measureLoudness() used to read an ffmpeg PROGRESS line instead of the summary
// block on short audio, and report -70.0 LUFS — the absolute gate floor — for a
// perfectly normal clip.
//
// The mechanism: ebur128 prints one progress line per frame and only afterwards
// the "Integrated loudness:" summary. The old code took stderr.slice(-2000) and
// then the FIRST regex hit inside it. On a long file that window contains only
// the summary, so it worked and nobody noticed. On a short file the whole
// stderr fits in the window, so the first hit is an early progress line — and
// integration has not started yet, so those read -70.0.
//
// This was latent for as long as loudness was only measured on whole chapters.
// Per-line levelling measures individual LINES, which are exactly this size, so
// the bug became load-bearing: every short line measured ~32 dB too quiet,
// asked for an impossible gain, and hit the clamp instead of being levelled.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { ffmpeg, measureLoudness } from '../src/util.mjs';

const DIR = path.join(tmpdir(), 'ams-loudness-test');

test.before(() => { rmSync(DIR, { recursive: true, force: true }); mkdirSync(DIR, { recursive: true }); });
test.after(() => rmSync(DIR, { recursive: true, force: true }));

async function tone(name, seconds, db) {
  const f = path.join(DIR, name);
  await ffmpeg(['-f', 'lavfi', '-i', `sine=frequency=1000:duration=${seconds}`,
    '-af', `volume=${db}dB`, '-ar', '24000', '-ac', '1', f]);
  return f;
}

test('a short clip does not measure as the -70 LUFS gate floor', async () => {
  // 0.4s is shorter than one line of dialogue and returned exactly -70.0 before
  const f = await tone('tiny.wav', 0.4, -14);
  const { integratedLufs } = await measureLoudness(f);

  assert.ok(integratedLufs != null, 'no loudness measured at all');
  assert.notEqual(integratedLufs, -70,
    'measured exactly -70.0 LUFS — that is ebur128\'s absolute gate floor from an ' +
    'early progress line, not this clip. The summary block is the last match, not the first.');
  assert.ok(integratedLufs > -45,
    `a -14 dBFS 1 kHz tone cannot be ${integratedLufs} LUFS`);
});

test('short and long clips at the same level measure the same', async () => {
  // The real invariant: duration must not change the reading. The old code was
  // right on long files and wrong on short ones, so this is the exact split.
  const short = await tone('s.wav', 0.5, -14);
  const long = await tone('l.wav', 12, -14);
  const a = (await measureLoudness(short)).integratedLufs;
  const b = (await measureLoudness(long)).integratedLufs;

  assert.ok(Math.abs(a - b) < 1.5,
    `same signal, different durations, measured ${a} vs ${b} LUFS — the reading depends on file length`);
});

test('true peak is read from the summary, and tracks the signal', async () => {
  const quiet = await tone('q.wav', 1.0, -30);
  const loud = await tone('L.wav', 1.0, -6);
  const q = (await measureLoudness(quiet)).truePeakDb;
  const l = (await measureLoudness(loud)).truePeakDb;

  assert.ok(q != null && l != null, 'true peak not parsed');
  assert.ok(l > q + 20, `peak should track the 24 dB level difference, got ${q} and ${l}`);
  assert.ok(l < 0, `true peak ${l} dBFS is at or above full scale`);
});
