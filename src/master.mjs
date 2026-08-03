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
// the dialogue — on every chapter this project has ever produced. Because a
// compressor's output level depends on the material, the miss differs per
// chapter, which is where chapter-to-chapter loudness drift came from. The
// two-pass form preserves the range but inherits the filter's own measurement,
// which reads 0.54 LU off ebur128, so it lands hot. Measure-then-gain is the
// only form exact on both axes. EBU Tech 3343 prescribes it outright.
//
// Two more things that bit during the measurement, recorded so nobody pays for
// them twice: the dynamic filter resamples its output to 192 kHz (any chain
// using it needs an explicit aresample or the container rate changes silently),
// and mono is measured 3.01 dB quieter unless dualmono=true — see
// measureLoudness in util.mjs, which owns that convention for both sides.
//
// TWO METRICS FOR TWO JOBS. immersive/clean are LISTENING artifacts and
// normalise to integrated loudness, which is perceptual. The retail file is a
// COMPLIANCE artifact, and the retail spec gates on RMS dBFS — unweighted,
// ungated, a different metric — so aiming at LUFS and hoping RMS lands in the
// window is a guess. It targets the centre of the band, measured on the metric
// it is actually judged by. That also sidesteps the dualmono ambiguity
// entirely: RMS is channel-independent.
import { ffmpeg, measureLoudness, astatsRms, log } from './util.mjs';

// Delivery targets. `ceilingDb` is a true-peak ceiling enforced by arithmetic
// rather than a limiter's best effort — which is why loudnorm asking for TP=-3
// delivered -2.9 and this does not.
//
// THE TARGETS WERE RECALIBRATED 2026-08-03, and the reason matters. A linear
// master can reach target T under ceiling C only if C - T >= the material's
// crest factor. Measured on a real levelled dialogue stem (I -20.5, TP -3.0,
// RMS -22.59): programme crest 17.5 dB, RMS-to-peak crest 19.6 dB. The old
// −18/−19 LUFS targets against −2/−3 dBTP allow only 16.0 dB, so they were
// unreachable by 1.5 LU — by ANY linear master, on any material this project
// produces. They were only ever met because loudnorm was compressing: reducing
// crest is precisely the mechanism it used to hit a number, and that is the
// same defect from the other end. Removing the compressor exposed targets that
// had been calibrated around it.
//
// So these are derived from what the material can actually do — max reachable
// is (ceiling - crest), and each target sits ~0.5 LU under it. Note the
// measurement convention (mono, no dualmono — see util.mjs) reads 3.01 dB below
// the dual-mono convention most meters use, so −20/−21 here is −17/−18 LUFS
// read the usual way: an ordinary spoken-word delivery level. The old numbers
// were very likely written in that convention and never re-derived in ours.
//
// The retail file is different again: its spec is a WINDOW, not a point. It
// aims for the middle and passes anywhere inside, because a compliance artifact
// is judged by whether it is in the band. The ceiling is the tightest of the
// three because "peak below −3 dB" is a pass/fail that the file is measured on.
export const IMMERSIVE = { name: 'immersive', metric: 'lufs', target: -20, ceilingDb: -2 };
export const CLEAN = { name: 'clean', metric: 'lufs', target: -21, ceilingDb: -3 };
export const RETAIL = { name: 'retail', metric: 'rms', target: -20, window: [-23, -18], ceilingDb: -3.1 };

// How far the verified output may sit from target before the render fails.
// The whole chain is linear, so the only real error source is the lossy
// encode: measured at 0.1 LU on I and 0.0 on LRA/TP for aac 128k @ 44.1 kHz.
// 0.5 leaves 5x headroom while still catching the 2.0 LU miss of the defect.
export const TOL_LU = 0.5;
// Linear gain cannot change loudness range at all, so any real drop here means
// a dynamics process has re-entered the chain. The defect cost 3.0 LU.
export const LRA_SQUASH_MAX_LU = 0.5;
// Below this there is no programme to normalize; boosting it would apply +50 dB
// of gain to a broken render. ebur128 floors digital silence at -70 LUFS.
export const SILENCE_FLOOR_LUFS = -50;
// When the true-peak ceiling binds, the master CANNOT reach its target without
// clipping, and pulling the whole programme down is the correct response — so a
// small shortfall is physics, not a defect, and is reported rather than fatal.
// A large one is different: it means the mix has a transient problem and this
// chapter will play audibly quieter than its neighbours, which is precisely the
// drift this stage exists to end. The fix is upstream, in the cue/stem gains.
export const PEAK_LIMITED_MAX_SHORTFALL_LU = 2.0;

// The gain a master may apply: enough to reach the target, but never more than
// the true-peak ceiling allows. Pure, so the arithmetic is testable without
// rendering anything.
export function masterGainDb(measured, target) {
  const { integratedLufs, truePeakDb } = measured;
  if (typeof integratedLufs !== 'number') {
    throw new Error('master: could not measure the premaster (no integrated loudness)');
  }
  if (integratedLufs <= SILENCE_FLOOR_LUFS) {
    return { db: 0, byTarget: 0, byPeak: 0, peakLimited: false, silent: true };
  }
  const current = target.metric === 'rms' ? measured.rmsDb : integratedLufs;
  if (typeof current !== 'number') {
    throw new Error(`master: could not measure the premaster on ${target.metric}`);
  }
  const byTarget = target.target - current;
  // a null true peak means ffmpeg printed "-inf": nothing to clip against
  const byPeak = typeof truePeakDb === 'number' ? target.ceilingDb - truePeakDb : Infinity;
  const db = Math.min(byTarget, byPeak);
  return { db, byTarget, byPeak, peakLimited: byPeak < byTarget, silent: false };
}

// Measure everything the target is judged on, in one place, so the gain stage
// and the gate that verifies it can never read different numbers.
async function measureFor(file, target) {
  const m = await measureLoudness(file);
  return target.metric === 'rms' ? { ...m, rmsDb: await astatsRms(file) } : m;
}

// Measure -> gain -> encode -> re-measure -> assert. Throws (failing the
// render) rather than shipping a chapter that is off target or compressed,
// because both defects are only discoverable by ear afterwards, one chapter at
// a time, which is the expensive way to find them.
export async function master(src, out, target, codecArgs, title) {
  const before = await measureFor(src, target);
  const gain = masterGainDb(before, target);
  if (gain.silent) {
    throw new Error(`${target.name} master: premaster is silent ` +
      `(${before.integratedLufs} LUFS) — the mix produced no audio`);
  }

  await ffmpeg(['-i', src, '-af', gain.db ? `volume=${gain.db.toFixed(2)}dB` : 'anull',
    ...codecArgs, '-ar', '44100', ...(title ? ['-metadata', `title=${title}`] : []), out]);
  const measured = await measureFor(out, target);

  const after = target.metric === 'rms' ? measured.rmsDb : measured.integratedLufs;
  const unit = target.metric === 'rms' ? 'dBRMS' : 'LUFS';
  // A point target passes within tolerance; a window spec passes anywhere
  // inside the band it is actually judged against.
  const [lo, hi] = target.window || [target.target - TOL_LU, target.target + TOL_LU];
  const band = target.window ? `${lo}..${hi} ${unit} window` : `${target.target} ${unit} target`;
  const problems = [];
  const warnings = [];

  if (typeof after !== 'number' || typeof measured.lra !== 'number') {
    problems.push('could not measure the mastered output');
  } else {
    if (after > hi) {
      // louder than asked for is never explicable by the peak ceiling
      problems.push(`${after} ${unit} is ${(after - hi).toFixed(1)} LU ABOVE the ${band}`);
    } else if (after < lo) {
      const short = lo - after;
      if (!gain.peakLimited) {
        problems.push(`${after} ${unit} is ${short.toFixed(1)} LU below the ${band}`);
      } else if (short > PEAK_LIMITED_MAX_SHORTFALL_LU) {
        problems.push(`${after} ${unit} is ${short.toFixed(1)} LU below the ${band} — ` +
          `the gain was capped at ${gain.db.toFixed(2)} dB by the ${target.ceilingDb} dBTP ceiling ` +
          `(premaster peaks at ${before.truePeakDb} dBTP, crest ` +
          `${(before.truePeakDb - after + gain.db).toFixed(1)} dB). This chapter would play audibly ` +
          'quieter than its neighbours. Pull down the hot cue or stem gains; do not compress the master');
      } else {
        warnings.push(`${short.toFixed(1)} LU below the ${band}, capped by the true-peak ceiling ` +
          `(premaster peaks at ${before.truePeakDb} dBTP)`);
      }
    }
    const squash = before.lra - measured.lra;
    if (squash > LRA_SQUASH_MAX_LU) {
      problems.push(`loudness range fell ${squash.toFixed(1)} LU (${before.lra} -> ${measured.lra}) — ` +
        'a master may only apply linear gain');
    }
  }
  if (typeof measured.truePeakDb === 'number' && measured.truePeakDb > target.ceilingDb + TOL_LU) {
    problems.push(`true peak ${measured.truePeakDb} dBTP exceeds the ${target.ceilingDb} dBTP ceiling`);
  }
  if (problems.length) {
    throw new Error(`${target.name} master failed its loudness gate: ${problems.join('; ')}`);
  }

  log('master', `${target.name}: ${gain.db >= 0 ? '+' : ''}${gain.db.toFixed(2)} dB -> ` +
    `${after} ${unit}, ${measured.truePeakDb} dBTP, LRA ${measured.lra} LU (was ${before.lra})` +
    (warnings.length ? ` — WARN ${warnings.join('; ')}` : ''));

  return {
    file: out,
    gainDb: +gain.db.toFixed(2),
    peakLimited: gain.peakLimited,
    target: {
      metric: target.metric, target: target.target, ceilingDb: target.ceilingDb,
      ...(target.window && { window: target.window }),
    },
    premaster: { file: src, ...before },
    measured,
    ...(warnings.length && { warnings }),
  };
}

// The published retail thresholds. Passing them does NOT mean the file can go
// to ACX — their terms prohibit author-uploaded AI narration outright — but
// every wide aggregator cloned these numbers, so this is the bar the retail
// file has to clear wherever it ends up.
export function acxVerdict({ truePeakDb }, rmsDb, floorDb) {
  const checks = {
    rms: rmsDb == null ? null : rmsDb >= -23 && rmsDb <= -18,
    peak: truePeakDb == null ? null : truePeakDb < -3,
    noiseFloor: floorDb == null ? null : floorDb < -60,
  };
  const failed = Object.entries(checks).filter(([, v]) => v === false).map(([k]) => k);
  return { ...checks, pass: failed.length === 0, failed };
}
