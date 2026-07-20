// SAPI fallback TTS engine (Windows, CPU-only, zero-install).
// Implements the DRAMATIS TTS engine interface: renderLines(lines, voices, cacheRoot).
// Real engines (Kokoro, Chatterbox) plug in behind the same interface.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentKey, cached, pexecFile, log, speakable } from '../../src/util.mjs';

const ENGINE = 'sapi@2';

// Normalize typography for speech: em-dashes read as pauses, curly quotes and
// ellipses to ASCII. Keeps SAPI prosody sane regardless of manifest encoding.
const here = path.dirname(fileURLToPath(import.meta.url));

export async function renderLines(lines, voices, cacheRoot) {
  const jobs = [];
  const results = {};
  for (const line of lines) {
    const v = voices[line.entity] || voices.narrator;
    const text = speakable(line.text);
    const key = contentKey([ENGINE, v.voice, String(v.rate), v.pitch || 'medium', text]);
    const { path: out, hit } = cached(cacheRoot, key);
    results[line.id] = out;
    if (!hit) jobs.push({ text, voice: v.voice, rate: v.rate, pitch: v.pitch || 'medium', out });
  }
  log('render:tts', `${lines.length} lines, ${lines.length - jobs.length} cache hits, ${jobs.length} to synthesize`);
  if (jobs.length) {
    const manifest = path.join(cacheRoot, 'tts-manifest.json');
    writeFileSync(manifest, JSON.stringify(jobs));
    const { stdout } = await pexecFile('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(here, 'render-batch.ps1'), '-Manifest', manifest,
    ], { maxBuffer: 16 * 1024 * 1024 });
    log('render:tts', stdout.trim().split('\n').pop());
  }
  return results; // lineId -> wav path
}
