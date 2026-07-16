// ElevenLabs TTS engine — premium tier for expressive character dialogue.
// Voices are resolved by NAME against the account's voice list, with per-entity
// fallback candidates, so the book config ports across accounts.
// Requires ELEVENLABS_API_KEY in the environment.
import { writeFileSync, unlinkSync } from 'node:fs';
import { contentKey, cached, ffmpeg, log } from '../../src/util.mjs';

const ENGINE = 'elevenlabs@1';
const API = 'https://api.elevenlabs.io/v1';
const MODEL = 'eleven_multilingual_v2';
const CONCURRENCY = 2;

function apiKey() {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error('ELEVENLABS_API_KEY not set');
  return key;
}

function speakable(text) {
  return text
    .replace(/\s*—\s*/g, ', ')
    .replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
    .replace(/\s+,/g, ',').replace(/,{2,}/g, ',');
}

let voiceIndex = null;
async function resolveVoice(candidates) {
  if (!voiceIndex) {
    const res = await fetch(`${API}/voices`, { headers: { 'xi-api-key': apiKey() } });
    if (!res.ok) throw new Error(`elevenlabs /voices ${res.status}`);
    const data = await res.json();
    voiceIndex = {};
    for (const v of data.voices) {
      const full = v.name.toLowerCase().trim();
      const base = full.split(/\s+-\s+/)[0].trim(); // "george - warm storyteller" -> "george"
      voiceIndex[full] ??= v.voice_id;
      voiceIndex[base] ??= v.voice_id;
    }
  }
  for (const name of candidates) {
    const id = voiceIndex[name.toLowerCase()];
    if (id) return { id, name };
  }
  throw new Error(`no ElevenLabs voice found among: ${candidates.join(', ')}`);
}

async function synthOne(job, key) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${API}/text-to-speech/${job.voiceId}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({
        text: job.text,
        model_id: MODEL,
        voice_settings: { stability: job.stability, similarity_boost: 0.75, style: job.style },
      }),
    });
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }
    if (!res.ok) throw new Error(`elevenlabs tts ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const mp3 = job.out.replace(/\.wav$/, '.tmp.mp3');
    writeFileSync(mp3, Buffer.from(await res.arrayBuffer()));
    await ffmpeg(['-i', mp3, '-ar', '48000', '-ac', '1', job.out]);
    unlinkSync(mp3);
    return;
  }
  throw new Error('elevenlabs tts: retries exhausted');
}

export async function renderLines(lines, voices, cacheRoot) {
  const jobs = [];
  const results = {};
  for (const line of lines) {
    const v = voices[line.entity] || voices.narrator;
    const { id: voiceId, name } = await resolveVoice(v.candidates);
    const text = speakable(line.text);
    const stability = v.stability ?? 0.45;
    const style = v.style ?? 0.3;
    const key = contentKey([ENGINE, name, MODEL, String(stability), String(style), text]);
    const { path: out, hit } = cached(cacheRoot, key);
    results[line.id] = out;
    if (!hit) jobs.push({ text, voiceId, stability, style, out });
  }
  const chars = jobs.reduce((a, j) => a + j.text.length, 0);
  log('render:tts', `elevenlabs: ${lines.length} lines, ${lines.length - jobs.length} cache hits, ` +
    `${jobs.length} to synthesize (~${chars} chars of credit)`);
  const key = apiKey();
  let i = 0, done = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (i < jobs.length) {
      const job = jobs[i++];
      await synthOne(job, key);
      if (++done % 20 === 0) log('render:tts', `elevenlabs ${done}/${jobs.length}`);
    }
  }));
  if (jobs.length) log('render:tts', `elevenlabs complete: ${jobs.length} lines`);
  return results;
}
