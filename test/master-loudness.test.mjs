// Regression test for law 1 ("machine gates first") and the mix law that
// dialog is sacred, after the 2026-07-28 audit found the master stage
// COMPRESSING every chapter.
//
// THE INCIDENT: src/mix.mjs mastered with a single-pass ffmpeg `loudnorm`
// (`loudnorm=I=-18:TP=-2:LRA=11`). Without measured_I/measured_TP/measured_LRA/
// measured_thresh, loudnorm runs in DYNAMIC mode — it is a gated multi-band
// compressor, not a gain stage. It says so itself: `print_format=json` on the
// shipped filter prints `"normalization_type" : "dynamic"`.
//
// Measured 2026-07-28 (ffmpeg 8.1.2) on a real render, verifying the RENDERED
// output with ebur128 rather than trusting loudnorm's self-report:
//
//   chain                                   I (target -19)   LRA (source 9.6)   TP
//   source                                      -16.7             9.6          -1.6
//   loudnorm=I=-19:TP=-3:LRA=9 (1-pass)         -17.0             6.6          -3.0
//   2-pass linear=true w/ measured_*            -19.5             9.6          -4.5
//   ebur128 measure, then volume=-2.3dB         -19.0             9.6          -3.9
//
// So the shipped chain missed its target by 2.0 LU AND destroyed 3.0 LU of
// dialogue dynamics. Worse, the miss is program-dependent: a compressor's
// output level depends on the material, which is exactly why chapters drifted
// against each other. Measure-then-gain is the only one of the three that is
// exact on BOTH axes; the 2-pass form inherits loudnorm's own measurement,
// which disagreed with ebur128 by 0.54 LU on this same file (-16.16 vs -16.7)
// and lands 0.5 LU hot as a result.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { masterGainDb, master, IMMERSIVE, CLEAN, TOL_LU, LRA_SQUASH_MAX_LU } from '../src/master.mjs';
import { measureLoudness, ffmpeg } from '../src/util.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function haveFfmpeg() {
  try { await ffmpeg(['-f', 'lavfi', '-i', 'anullsrc=r=8000:cl=mono:d=0.1', '-f', 'null', '-']); return true; }
  catch { return false; }
}

// A speech-like signal: alternating loud/quiet blocks, so it has a real gated
// loudness range (~14 LU) for a compressor to visibly destroy. Measured with
// this seed: I=-18.4 LUFS, peak=-4.3 dBTP, LRA=13.9 LU.
//
// Every constant here was tuned against the -3.5 dBTP master ceiling; do not
// nudge them casually.
//  - s=7 (seed) makes it DETERMINISTIC. anoisesrc with no seed draws fresh
//    noise each run, and the PEAK is the volatile statistic — right at a -3.5
//    ceiling that makes the master flip between peak-limited and not, run to
//    run. That is the flake, and the seed removes it.
//  - a=0.8 / quiet=0.2 put the integrated near -18 with peak -4.3, i.e. crest
//    ~14 dB. The ceiling only lets a premaster reach -18 if crest is under
//    ~14.5 dB (a signal AT -18 LUFS with 14.5 dB crest peaks exactly AT -3.5),
//    so this masters with a small +0.4 dB and lands -18.0 with peak -3.9 —
//    clear of the ceiling, NOT peak-limited, LRA intact. A quiet fixture
//    (the original a=0.35 measured -25.5 LUFS) is far too peaky for its level
//    and gets capped short of target. Widening the gate (quiet 0.14) pushes
//    crest past 14.5 and the master starts clipping the ceiling; that is the
//    tension between "wide LRA" and "a tight true-peak ceiling", made concrete.
//
// The lowpass is not cosmetic either. Full-band pink noise carries real energy
// in the 22–24 kHz band that the 44.1 kHz delivery resample throws away, and
// K-weighting's high shelf makes the loss count: measured 2026-07-28, the same
// fixture drifted 0.4 LU through resample+encode unfiltered vs 0.2 LU banded,
// against 0.1 LU for actual speech. Testing the gate with a signal the codec
// finds harder than anything it will ever see just makes it flake.
async function fixture(dir) {
  const f = path.join(dir, 'premaster.wav');
  await ffmpeg(['-f', 'lavfi', '-i', 'anoisesrc=r=48000:c=pink:d=32:a=0.8:s=7',
    '-af', "volume='if(lt(mod(t,8),4), 1, 0.2)':eval=frame,lowpass=f=8000", '-ac', '1', f]);
  return f;
}

// ---------------------------------------------------------------- gain math

test('gain is a pure linear offset to the loudness target', () => {
  const g = masterGainDb({ integratedLufs: -16.7, truePeakDb: -1.6, lra: 9.6 }, CLEAN);
  assert.equal(+g.db.toFixed(2), -2.3, 'clean target -19 from -16.7 is exactly -2.3 dB');
  assert.equal(g.peakLimited, false);
});

test('the true-peak ceiling wins when it binds — a master never clips to hit a number', () => {
  // quiet program, hot transient: hitting -19 LUFS would need +6 dB and push
  // the peak to +5.5 dBTP. The min() is what keeps that from happening.
  const g = masterGainDb({ integratedLufs: -25, truePeakDb: -0.5, lra: 12 }, CLEAN);
  assert.equal(+g.db.toFixed(2), -3.0, 'peak ceiling -3.5 from -0.5 caps the gain at -3.0 dB');
  assert.equal(g.peakLimited, true, 'peak-limited masters must be flagged, not silently shipped quiet');
});

test('silence is never boosted to the target', () => {
  // ebur128 floors digital silence at -70 LUFS and prints "-inf dBFS" for the
  // peak (so measureLoudness returns null). Naive gain math would apply +51 dB.
  const g = masterGainDb({ integratedLufs: -70, truePeakDb: null, lra: 0 }, CLEAN);
  assert.equal(g.db, 0, 'silent premaster must pass through at unity');
  assert.equal(g.silent, true);
});

test('both delivery targets clear the ACX true-peak requirement', () => {
  // ACX/Audible retail wants peak levels BELOW -3 dB (help.acx.com, 2026-07).
  // Here tp is a linear-gain ceiling, verified on the rendered output, so the
  // target value IS what the file peaks at (unlike a loudnorm TP request).
  // Measured 2026-07-28: a -3 ceiling lands at -3.0, which does not clear
  // "below -3"; -3.5 is the first that does. Robert's ear ruled -3.5 on both.
  for (const t of [IMMERSIVE, CLEAN]) {
    assert.ok(t.tp <= -3.5, `${t.name} true-peak ceiling ${t.tp} is too hot to clear ACX`);
  }
});

// ------------------------------------------------------- structural guards

test('the master stage contains no loudnorm — the whole point of the fix', () => {
  // A single-pass loudnorm anywhere in a master chain re-introduces dynamic
  // mode. Assert it structurally so it cannot creep back in.
  for (const f of ['src/mix.mjs', 'src/master.mjs']) {
    const src = readFileSync(path.join(root, f), 'utf8');
    const code = src.split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n');
    assert.ok(!/loudnorm/.test(code), `${f} must not use loudnorm in code (dynamic mode compresses dialog)`);
  }
});

test('measurement convention is stated once and shared by gate and verifier', () => {
  // ffmpeg reads a MONO file 3.01 dB quieter without dualmono=true (measured:
  // -16.7 vs -13.7 LUFS on the same mono file). Our masters are mono, so if
  // the gain stage and the verify stage ever used different flags the gate
  // would disagree with itself by exactly 3 LU. One helper, one convention.
  const m = readFileSync(path.join(root, 'src/master.mjs'), 'utf8');
  assert.match(m, /measureLoudness/, 'master.mjs must measure via the shared helper');
  assert.ok(!/ebur128/.test(m.split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n')),
    'master.mjs must not call ebur128 directly — that is how the two sides drift');
});

// ------------------------------------------------------------ end-to-end

test('mastered output hits its target and preserves the loudness range', async () => {
  if (!await haveFfmpeg()) { console.log('  (ffmpeg not on PATH — master render skipped)'); return; }
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ams-master-'));
  try {
    const pre = await fixture(dir);
    const before = await measureLoudness(pre);
    assert.ok(before.lra > 12, `fixture must be dynamic enough to test squash (got LRA ${before.lra})`);

    const out = path.join(dir, 'immersive.m4a');
    const r = await master(pre, out, IMMERSIVE, ['-c:a', 'aac', '-b:a', '128k', '-ar', '44100']);
    assert.ok(existsSync(out), 'master must produce the output file');

    assert.ok(Math.abs(r.measured.integratedLufs - IMMERSIVE.i) <= TOL_LU,
      `integrated loudness ${r.measured.integratedLufs} must be within ${TOL_LU} LU of ${IMMERSIVE.i}`);
    assert.ok(r.measured.truePeakDb <= IMMERSIVE.tp + TOL_LU,
      `true peak ${r.measured.truePeakDb} must not exceed ${IMMERSIVE.tp} dBTP`);
    assert.ok(before.lra - r.measured.lra <= LRA_SQUASH_MAX_LU,
      `LRA fell ${(before.lra - r.measured.lra).toFixed(1)} LU (${before.lra} -> ${r.measured.lra}); ` +
      'a master may only apply linear gain');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the gate actually bites: the OLD single-pass loudnorm chain fails it', async () => {
  // Guards the tolerances. If TOL_LU or LRA_SQUASH_MAX_LU are ever loosened
  // far enough for the original defect to pass, this test fails instead.
  if (!await haveFfmpeg()) { console.log('  (ffmpeg not on PATH — old-chain probe skipped)'); return; }
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ams-oldchain-'));
  try {
    const pre = await fixture(dir);
    const before = await measureLoudness(pre);
    const bad = path.join(dir, 'old.m4a');
    await ffmpeg(['-i', pre, '-af', `loudnorm=I=${IMMERSIVE.i}:TP=${IMMERSIVE.tp}:LRA=11`,
      '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', bad]);
    const after = await measureLoudness(bad);

    const missedTarget = Math.abs(after.integratedLufs - IMMERSIVE.i) > TOL_LU;
    const squashed = before.lra - after.lra > LRA_SQUASH_MAX_LU;
    assert.ok(missedTarget || squashed,
      `single-pass loudnorm must not pass this gate (I ${after.integratedLufs}, ` +
      `LRA ${before.lra} -> ${after.lra})`);
    assert.ok(squashed, 'the defining symptom is a squashed LRA — assert it directly');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('measureLoudness reports LRA, not just I and true peak', async () => {
  if (!await haveFfmpeg()) { console.log('  (ffmpeg not on PATH — measurement probe skipped)'); return; }
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ams-measure-'));
  try {
    const m = await measureLoudness(await fixture(dir));
    for (const k of ['integratedLufs', 'truePeakDb', 'lra']) {
      assert.equal(typeof m[k], 'number', `measureLoudness must report ${k}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
