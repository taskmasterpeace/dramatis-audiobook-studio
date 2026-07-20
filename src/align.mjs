// Word-level forced alignment for rendered lines, cached per line.
// alignLines([{id, text}], { id: wavPath }, cacheRoot) -> { id: [{word,start,end}] }
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentKey, pexecFile, pythonExe, log } from './util.mjs';

const ALIGNER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'engines', 'align', 'qwen3fa.py');

export async function alignLines(lines, wavById, cacheRoot) {
  const out = {};
  const missing = [];
  for (const line of lines) {
    const key = contentKey(['align@1', line.text, wavById[line.id]]);
    const f = path.join(cacheRoot, 'cache', `${key}.align.json`);
    if (existsSync(f)) out[line.id] = JSON.parse(readFileSync(f, 'utf8'));
    else missing.push({ line, f });
  }
  if (missing.length) {
    // per-run names — fixed names race with any concurrent aligner call
    const runId = contentKey(missing.map((m) => m.f)).slice(0, 12);
    const manifest = path.join(cacheRoot, `align-manifest-${runId}.json`);
    const tmpOut = path.join(cacheRoot, `align-out-${runId}.json`);
    writeFileSync(manifest, JSON.stringify(missing.map((m) => ({ id: m.line.id, wav: wavById[m.line.id], text: m.line.text }))));
    log('align', `${missing.length} lines to align (${lines.length - missing.length} cached)`);
    // Alignment is an ENHANCEMENT — it buys word-exact cue placement. It used to
    // be able to kill a render outright (missing torch, missing model, no GPU),
    // throwing away the entire TTS pass, which is the expensive part. Cue
    // placement already degrades on its own: mix.mjs falls back to line-start
    // offsets when a line has no words. So warn loudly and carry on.
    try {
      const { stdout } = await pexecFile(pythonExe(), [ALIGNER, manifest, tmpOut], { maxBuffer: 16 * 1024 * 1024 });
      log('align', stdout.trim().split('\n').pop());
      const fresh = JSON.parse(readFileSync(tmpOut, 'utf8'));
      for (const m of missing) {
        const words = fresh[m.line.id] ?? [];
        writeFileSync(m.f, JSON.stringify(words));
        out[m.line.id] = words;
      }
    } catch (e) {
      log('align', `WARN alignment unavailable (${String(e.message).split('\n')[0].slice(0, 140)}) — `
        + 'cues will be placed at line start instead of on the exact word. '
        + 'Install the aligner deps to get word-accurate placement.');
      for (const m of missing) out[m.line.id] = [];
    }
  }
  return out;
}
