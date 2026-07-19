// Kokoro-82M TTS engine (Apache-2.0 weights, ONNX runtime, offline).
// Same interface as the SAPI fallback: renderLines(lines, voices, cacheRoot).
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentKey, cached, pexecFile, pythonExe, log } from '../../src/util.mjs';

const ENGINE = 'kokoro-onnx@1';
const here = path.dirname(fileURLToPath(import.meta.url));

function speakable(text) {
  return text
    .replace(/\s*—\s*/g, ', ')
    .replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
    .replace(/…/g, '...')
    .replace(/\s+,/g, ',').replace(/,{2,}/g, ',');
}

export async function renderLines(lines, voices, cacheRoot) {
  const jobs = [];
  const results = {};
  for (const line of lines) {
    const v = voices[line.entity] || voices.narrator;
    // never silently render a character in the narrator's voice — that defect is
    // only discoverable by listening to the finished book (an original P0 miss)
    if (!v) throw new Error(`kokoro: no voice for entity '${line.entity}' and no narrator fallback`);
    if (!voices[line.entity]) log('render:tts', `WARN kokoro: '${line.entity}' has no voice — using narrator`);
    const text = speakable(line.text);
    const key = contentKey([ENGINE, v.voice, String(v.speed ?? 1), text]);
    const { path: out, hit } = cached(cacheRoot, key);
    results[line.id] = out;
    if (!hit) jobs.push({ text, voice: v.voice, speed: v.speed ?? 1, out });
  }
  log('render:tts', `kokoro: ${lines.length} lines, ${lines.length - jobs.length} cache hits, ${jobs.length} to synthesize`);
  if (jobs.length) {
    // per-run manifest name: a fixed name races with any concurrent caller
    // (auditioning mid-render used to overwrite the file the batch was reading)
    const manifest = path.join(cacheRoot, `kokoro-manifest-${contentKey(jobs.map((j) => j.out)).slice(0, 12)}.json`);
    writeFileSync(manifest, JSON.stringify(jobs));
    const { stdout } = await pexecFile(pythonExe(), [path.join(here, 'kokoro-batch.py'), manifest],
      { maxBuffer: 16 * 1024 * 1024 });
    log('render:tts', stdout.trim().split('\n').pop());
  }
  return results;
}
