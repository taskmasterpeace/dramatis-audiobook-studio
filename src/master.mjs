// Master stage: measure the premaster, apply ONE linear gain, verify the
// result. No dynamics processing ever touches a finished chapter.
//
// THE INCIDENT (2026-07-28 audit): this stage used to be a single-pass ffmpeg
// `loudnorm` filter. Without measured_I/measured_TP/measured_LRA/measured_thresh
// that filter runs in DYNAMIC mode — a gated multi-band compressor, not a gain
// stage. It reports this itself: add print_format=json to the shipped filter
// and it prints "normalization_type" : "dynamic".
//
// Measured on a real render (ffmpeg 8.1.2), verifying the RENDERED output with
// ebur128 rather than trusting the filter's self-report:
//
//   chain                                   I (target -19)   LRA (src 9.6)   TP
//   source                                      -16.7             9.6       -1.6
//   single-pass, the shipped chain              -17.0             6.6       -3.0
//   two-pass linear=true w/ measured_*          -19.5             9.6       -4.5
//   measure with ebur128, then volume=-2.3dB    -19.0             9.6       -3.9
//
// The shipped chain missed its target by 2.0 LU AND compressed 3.0 LU out of
// the dialogue. Because a compressor's output level depends on the material,
// the miss differs per chapter — that is where chapter-to-chapter loudness
// drift came from. The two-pass form preserves the range but inherits the
// filter's own measurement, which reads 0.54 LU off ebur128, so it lands hot.
// Measure-then-gain is the only form that is exact on both axes.
//
// Two more things that bit during the measurement, recorded so nobody pays
// for them twice: the dynamic filter resamples its output to 192 kHz (any
// chain using it needs an explicit aresample or the container rate changes
// silently), and mono is measured 3.01 dB quieter unless dualmono=true — see
// measureLoudness in util.mjs, which owns that convention for both sides.
import { ffmpeg, measureLoudness, log } from './util.mjs';

// Delivery targets. Immersive is the full 4-stem mix, clean is dialog only.
export const IMMERSIVE = { name: 'immersive', i: -18, tp: -2 };
export const CLEAN = { name: 'clean', i: -19, tp: -3 };

// How far the verified output may sit from target before the render fails.
// The whole chain is linear, so the only real error source is the lossy
// encode: measured at 0.1 LU on I and 0.0 on LRA/TP for aac 128k @ 44.1 kHz.
// 0.5 leaves 5x headroom while still catching the 2.0 LU miss of the defect.
export const TOL_LU = 0.5;
// Linear gain cannot change loudness range at all, so any real drop here means
// a dynamics process has re-entered the chain. The defect cost 3.0 LU.
export const LRA_SQUASH_MAX_LU = 0.5;
// Below this there is no program to normalize; boosting it would apply +50 dB
// of gain to a broken render. ebur128 floors digital silence at -70 LUFS.
export const SILENCE_FLOOR_LUFS = -50;

// The gain a master may apply: enough to reach the loudness target, but never
// more than the true-peak ceiling allows. Pure, so the arithmetic is testable
// without rendering anything.
export function masterGainDb(measured, target) {
  const { integratedLufs: i, truePeakDb: tp } = measured;
  if (typeof i !== 'number') {
    throw new Error('master: could not measure the premaster (no integrated loudness)');
  }
  if (i <= SILENCE_FLOOR_LUFS) {
    return { db: 0, byLoudness: 0, byPeak: 0, peakLimited: false, silent: true };
  }
  const byLoudness = target.i - i;
  // a null true peak means ffmpeg printed "-inf": nothing to clip against
  const byPeak = typeof tp === 'number' ? target.tp - tp : Infinity;
  const db = Math.min(byLoudness, byPeak);
  return { db, byLoudness, byPeak, peakLimited: byPeak < byLoudness, silent: false };
}

// Measure -> gain -> encode -> re-measure -> assert. Throws (failing the
// render) rather than shipping a chapter that is off target or compressed,
// because both defects are only discoverable by ear afterwards, one chapter
// at a time, which is the expensive way to find them.
export async function master(premaster, out, target, encodeArgs) {
  const before = await measureLoudness(premaster);
  const gain = masterGainDb(before, target);
  if (gain.silent) {
    throw new Error(`${target.name} master: premaster is silent ` +
      `(${before.integratedLufs} LUFS) — the mix produced no audio`);
  }

  await ffmpeg(['-i', premaster, '-af', `volume=${gain.db.toFixed(2)}dB`, ...encodeArgs, out]);
  const measured = await measureLoudness(out);

  const problems = [];
  if (typeof measured.integratedLufs !== 'number' || typeof measured.lra !== 'number') {
    problems.push('could not measure the mastered output');
  } else {
    const off = Math.abs(measured.integratedLufs - target.i);
    if (off > TOL_LU) {
      problems.push(`integrated ${measured.integratedLufs} LUFS is ${off.toFixed(1)} LU off the ` +
        `${target.i} target` + (gain.peakLimited
          ? ` — the gain was capped at ${gain.db.toFixed(2)} dB by the true-peak ceiling ` +
            `(premaster peaks at ${before.truePeakDb} dBTP). Pull down the hot cue or stem gains; ` +
            'do not compress the master'
          : ''));
    }
    const squash = before.lra - measured.lra;
    if (squash > LRA_SQUASH_MAX_LU) {
      problems.push(`loudness range fell ${squash.toFixed(1)} LU (${before.lra} -> ${measured.lra}) — ` +
        'a master may only apply linear gain');
    }
  }
  if (typeof measured.truePeakDb === 'number' && measured.truePeakDb > target.tp + TOL_LU) {
    problems.push(`true peak ${measured.truePeakDb} dBTP exceeds the ${target.tp} dBTP ceiling`);
  }
  if (problems.length) {
    throw new Error(`${target.name} master failed its loudness gate: ${problems.join('; ')}`);
  }

  log('master', `${target.name}: ${before.integratedLufs} LUFS ${gain.db >= 0 ? '+' : ''}` +
    `${gain.db.toFixed(2)} dB -> ${measured.integratedLufs} LUFS, ` +
    `${measured.truePeakDb} dBTP, LRA ${measured.lra} LU (was ${before.lra})` +
    (gain.peakLimited ? ' [true-peak limited]' : ''));

  return {
    file: out,
    gainDb: +gain.db.toFixed(2),
    peakLimited: gain.peakLimited,
    target: { i: target.i, tp: target.tp },
    premaster: { file: premaster, ...before },
    measured,
  };
}
