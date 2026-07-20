// Qwen3-TTS engine (Apache-2.0) — local designed voices + emotion instruct.
// Voice map entries: { design: "<persona description>" } for a designed voice
// (frozen via clone prompt -> consistent across the book), or
// { speaker: "Ryan" } for a CustomVoice preset. Emotion comes from
// line.emotion -> a natural-language instruct, batched per entity.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentKey, cached, pexecFile, pythonExe, log, speakable } from '../../src/util.mjs';

const ENGINE = 'qwen3-tts@1';
const here = path.dirname(fileURLToPath(import.meta.url));

const EMOTION_ADJ = {
  anger: 'angry', sadness: 'sad', joy: 'happy', fear: 'fearful',
  surprise: 'surprised', disgust: 'annoyed', tenderness: 'warm', curiosity: 'curious',
};
function instruct(emotion) {
  if (!emotion) return '';
  const [k, v] = Object.entries(emotion).sort((a, b) => b[1] - a[1])[0];
  if (v < 0.4) return '';
  return `Speak with a ${v >= 0.75 ? 'very ' : ''}${EMOTION_ADJ[k] || k} tone.`;
}

export async function renderLines(lines, voices, cacheRoot) {
  const jobs = [];
  const results = {};
  const entities = {};
  let emotive = 0;
  for (const line of lines) {
    const v = voices[line.entity] || voices.narrator;
    if (!v) throw new Error(`qwen3: no voice for entity '${line.entity}' and no narrator fallback`);
    entities[line.entity] = v;
    const ins = instruct(line.emotion);
    if (ins) emotive++;
    const voiceKey = v.design || v.speaker;
    const text = speakable(line.text);
    const key = contentKey([ENGINE, voiceKey, ins, text]);
    const { path: out, hit } = cached(cacheRoot, key);
    results[line.id] = out;
    if (!hit) jobs.push({ entity: line.entity, text, instruct: ins, out });
  }
  log('render:tts', `qwen3: ${lines.length} lines, ${lines.length - jobs.length} cache hits, ` +
    `${jobs.length} to synthesize, ${emotive} with emotion instruct`);
  if (jobs.length) {
    // per-run manifest name — fixed names race with concurrent callers
    const manifest = path.join(cacheRoot, `qwen3-manifest-${contentKey(jobs.map((j) => j.out)).slice(0, 12)}.json`);
    writeFileSync(manifest, JSON.stringify({ cacheRoot, entities, lines: jobs }));
    const { stdout } = await pexecFile(pythonExe(), [path.join(here, 'qwen3-batch.py'), manifest],
      { maxBuffer: 16 * 1024 * 1024 });
    log('render:tts', stdout.trim().split('\n').pop());
  }
  return results;
}
