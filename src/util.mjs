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

export async function measureLoudness(file) {
  // ebur128 prints to stderr; parse integrated loudness + true peak
  const { stderr } = await pexecFile('ffmpeg', [
    '-hide_banner', '-nostats', '-i', file, '-filter_complex', 'ebur128=peak=true', '-f', 'null', '-',
  ], { maxBuffer: 64 * 1024 * 1024 });
  const tail = stderr.slice(-2000);
  const i = tail.match(/I:\s*(-?[\d.]+)\s*LUFS/);
  const tp = tail.match(/Peak:\s*(-?[\d.]+)\s*dBFS/);
  return { integratedLufs: i ? parseFloat(i[1]) : null, truePeakDb: tp ? parseFloat(tp[1]) : null };
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
