import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const pexecFile = promisify(execFile);

// Python for engine sidecars: explicit env override, else the project venv,
// else whatever "python" resolves to on PATH.
export function pythonExe() {
  if (process.env.DRAMATIS_PYTHON) return process.env.DRAMATIS_PYTHON;
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  for (const rel of ['.venv/Scripts/python.exe', '.venv/bin/python']) {
    const p = path.join(root, ...rel.split('/'));
    if (existsSync(p)) return p;
  }
  return 'python';
}

export function contentKey(parts) {
  return createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 24);
}

export function ensureDir(p) {
  mkdirSync(p, { recursive: true });
  return p;
}

export function cachePath(root, key, ext = '.wav') {
  return path.join(ensureDir(path.join(root, 'cache')), key + ext);
}

export function cached(root, key, ext = '.wav') {
  const p = cachePath(root, key, ext);
  return { path: p, hit: existsSync(p) };
}

export async function ffmpeg(args) {
  return pexecFile('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { maxBuffer: 64 * 1024 * 1024 });
}

export async function ffprobeDuration(file) {
  const { stdout } = await pexecFile('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file,
  ]);
  return parseFloat(stdout.trim());
}

// THE ONE loudness measurement in this project. Both the master stage's gain
// calculation and the gate that verifies its output must call this, because
// the numbers are only comparable within a single convention:
//
//  - dualmono is deliberately NOT set. Our masters are mono, and ffmpeg reads
//    a mono file 3.01 dB quieter without it (measured 2026-07-28: -16.7 vs
//    -13.7 LUFS on the same mono file — ffmpeg's panlaw default). Whichever
//    convention is chosen has to hold on BOTH sides or the gate disagrees with
//    itself by exactly 3 LU.
//  - ebur128, never loudnorm's self-report: loudnorm's `input_i` was 0.54 LU
//    off this filter on the same file (-16.16 vs -16.7), which is precisely
//    why a 2-pass loudnorm master lands ~0.5 LU hot.
//  - framelog=quiet + parse from the Summary block. This one is a correctness
//    fix, not tidiness: ebur128 prints a progress line PER FRAME and only then
//    the summary. The old code took stderr.slice(-2000) and the FIRST regex hit
//    inside it, which is right on a long file and wrong on a short one — the
//    whole stderr fits in the window, so the first hit is an early progress
//    line, and those read -70.0 LUFS (the absolute gate floor) because
//    integration has not started. Measured 2026-07-28: a 0.4 s clip returned
//    exactly -70.0, a 32 dB fabrication. Latent while only whole chapters were
//    measured; per-line levelling measures line-sized files, so it became
//    load-bearing overnight. Quieting the frame log removes the hazard at the
//    source; anchoring on "Summary:" means even a re-enabled frame log is safe.
export async function measureLoudness(file) {
  const { stderr } = await pexecFile('ffmpeg', [
    '-hide_banner', '-nostats', '-i', file,
    '-filter_complex', 'ebur128=peak=true:framelog=quiet', '-f', 'null', '-',
  ], { maxBuffer: 64 * 1024 * 1024 });
  // parse the Summary block only — "LRA low:"/"LRA high:" live there too, and
  // the per-frame lines (if ever re-enabled) repeat every field. No Summary at
  // all means ffmpeg told us nothing: return nulls so the caller's gate fails
  // loudly, rather than slicing from -1 and matching whatever happens to be
  // in the tail.
  const at = stderr.lastIndexOf('Summary:');
  const summary = at === -1 ? '' : stderr.slice(at);
  const num = (re) => { const m = summary.match(re); return m ? parseFloat(m[1]) : null; };
  return {
    integratedLufs: num(/I:\s*(-?[\d.]+)\s*LUFS/),
    truePeakDb: num(/Peak:\s*(-?[\d.]+)\s*dBFS/),   // null when ffmpeg prints "-inf" (digital silence)
    lra: num(/LRA:\s*(-?[\d.]+)\s*LU/),
  };
}

// RMS in dBFS — unweighted and ungated, a different metric from LUFS. The
// retail master is judged on this one, so it is measured rather than inferred
// from loudness. `selectExpr` restricts the measurement to chosen time ranges.
export async function astatsRms(file, selectExpr) {
  const af = selectExpr ? `aselect='${selectExpr}',asetpts=N/SR/TB,astats` : 'astats';
  const { stderr } = await pexecFile('ffmpeg',
    ['-hide_banner', '-nostats', '-i', file, '-af', af, '-f', 'null', '-'],
    { maxBuffer: 64 * 1024 * 1024 });
  const all = [...stderr.matchAll(/RMS level dB:\s*(-?[\d.]+|-?inf)/g)];
  if (!all.length) return null;
  const v = parseFloat(all.at(-1)[1]);   // last block is astats' Overall section
  return Number.isFinite(v) ? +v.toFixed(2) : null;
}

// The noise floor as a retail spec means it: the level IN THE SILENCE.
// ffmpeg's astats has a "Noise floor" field and it does NOT measure that —
// calibrated 2026-07-27 on this box, white noise at -44.8 reads -49.0
// (plausible), a pure sine returns its PEAK, and a real TTS render returns
// -inf. It is a min-local-peak statistic that silently passes everything handed
// to it. The honest recipe: find the silent regions, trim a guard off each end
// so no speech tail leaks in, splice them, and measure THAT.
//
// Two traps, both already paid for. Measure the MASTER, because makeup gain
// lifts the floor along with everything else. And never measure gaps that are
// anullsrc — true digital zero reads -inf and passes trivially, which is the
// whole reason the mixer lays continuous room tone instead.
const FLOOR_GUARD = 0.1;         // s trimmed off each end of a silent region
// 200 between() clauses in ONE aselect expression is past what some ffmpeg
// builds will parse (8.1.2 dies with "Cannot allocate memory" at ~190 on a
// 10-minute chapter — measured 2026-08-06, it killed a finished render at the
// gate). 60 regions sampled EVENLY across the file keeps the expression well
// inside every parser we've met while still covering head, middle and tail.
const FLOOR_MAX_REGIONS = 60;

export async function noiseFloorDb(file) {
  const { stderr } = await pexecFile('ffmpeg',
    ['-hide_banner', '-nostats', '-i', file, '-af', 'silencedetect=noise=-40dB:d=0.3', '-f', 'null', '-'],
    { maxBuffer: 64 * 1024 * 1024 });
  const regions = [];
  for (const m of stderr.matchAll(/silence_start:\s*(-?[\d.]+)[\s\S]*?silence_end:\s*([\d.]+)/g)) {
    const a = Math.max(0, parseFloat(m[1])) + FLOOR_GUARD;
    const b = parseFloat(m[2]) - FLOOR_GUARD;
    if (b > a) regions.push([a, b]);
  }
  if (!regions.length) return null;
  // Even-stride sample, not first-N: first-N would measure only the chapter's
  // head and call it the floor. Never truncate coverage silently — a gate that
  // sampled a third of the file and said PASS is worse than no gate.
  let used = regions;
  if (regions.length > FLOOR_MAX_REGIONS) {
    const stride = regions.length / FLOOR_MAX_REGIONS;
    used = Array.from({ length: FLOOR_MAX_REGIONS }, (_, i) => regions[Math.floor(i * stride)]);
    log('measure', `noise floor: sampled ${used.length} of ${regions.length} silent regions (even stride)`);
  }
  try {
    return await astatsRms(file, used.map(([a, b]) => `between(t,${a.toFixed(3)},${b.toFixed(3)})`).join('+'));
  } catch (e) {
    // A MEASUREMENT must never kill a finished render. Unmeasured is a state
    // the verdict already understands (null -> check reads "unmeasured", not
    // PASS) — a crash here threw away a whole rendered chapter once.
    log('measure', `noise floor: measurement failed (${String(e.message).split('\n')[0].slice(0, 120)}) — reporting unmeasured`);
    return null;
  }
}

export function log(stage, msg) {
  console.log(`[${stage}] ${msg}`);
}

// Canonical text normalization for synthesis. Every TTS engine MUST use this
// one — four private copies had already drifted (ElevenLabs was missing the
// ellipsis rule, so the same line produced different audio and a different
// cache key there). The forced aligner must be handed this same normalized
// text: it used to receive the RAW line while the audio was synthesized from
// the normalized one, so it aligned against words that were never spoken.
export function speakable(text) {
  return text
    .replace(/\s*—\s*/g, ', ')
    .replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
    .replace(/…/g, '...')
    .replace(/\s+,/g, ',').replace(/,{2,}/g, ',');
}
