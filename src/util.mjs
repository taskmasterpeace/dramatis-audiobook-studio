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
//  - framelog=quiet: the per-frame log is ~1.6 kB/s of stderr, i.e. ~3 MB for
//    a 30-minute chapter, measured against a 64 MB buffer for no benefit.
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
