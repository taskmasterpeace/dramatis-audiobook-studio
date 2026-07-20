// ElevenLabs TTS engine — premium tier for expressive character dialogue.
// Voices are resolved by NAME against the account's voice list, with per-entity
// fallback candidates, so the book config ports across accounts.
// Requires ELEVENLABS_API_KEY in the environment.
import { writeFileSync, unlinkSync } from 'node:fs';
import { contentKey, cached, ffmpeg, log, speakable } from '../../src/util.mjs';

const ENGINE = 'elevenlabs@1';
const API = 'https://api.elevenlabs.io/v1';
const MODEL = 'eleven_v3';
const CONCURRENCY = 2;

// Production Script emotion { anger: 0.6, ... } -> v3 audio tag for the dominant
// emotion when clearly present (>= 0.4). Tag is prepended; text stays verbatim.
const EMOTION_TAGS = {
  anger: 'angry', sadness: 'sad', joy: 'happy', fear: 'fearful',
  surprise: 'surprised', disgust: 'annoyed', tenderness: 'warmly', curiosity: 'curious',
};
function audioTag(emotion) {
  if (!emotion) return '';
  const [k, v] = Object.entries(emotion).sort((a, b) => b[1] - a[1])[0];
  return v >= 0.4 ? `[${EMOTION_TAGS[k] || k}] ` : '';
}

// v3 stability is a 3-detent slider: 0 creative / 0.5 natural / 1 robust.
function snapStability(v) {
  return v < 0.25 ? 0 : v < 0.75 ? 0.5 : 1;
}

function apiKey() {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error('ELEVENLABS_API_KEY not set');
  return key;
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

// Per-request caps, measured 2026-07-20: the enforced wall is exactly 1.1x the
// documented cap, but we budget against the DOCUMENTED number — the extra 10%
// is undocumented slack nobody should build on.
const MODEL_CAP = { eleven_v3: 5000, eleven_multilingual_v2: 10000, eleven_flash_v2_5: 40000 };
const capFor = (model) => MODEL_CAP[model] ?? 5000;

// Split long text so a whole story can become one file. Sentence-first so the
// joins land at natural pauses.
function splitChunks(text, limit) {
  if (text.length <= limit) return [text];
  const out = [];
  let buf = '';
  for (const s of text.split(/(?<=[.!?…])\s+/)) {
    if (buf && buf.length + s.length + 1 > limit) { out.push(buf); buf = s; }
    else buf = buf ? `${buf} ${s}` : s;
    while (buf.length > limit) {                     // one giant sentence
      let cut = buf.lastIndexOf(' ', limit);
      if (cut <= 0) cut = limit;
      out.push(buf.slice(0, cut));
      buf = buf.slice(cut).trim();
    }
  }
  if (buf) out.push(buf);
  return out;
}

async function synthOne(job, key) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${API}/text-to-speech/${job.voiceId}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({
        text: job.text,
        // Prosody continuity across chunk joins. NOT billed (verified: a 52-char
        // text with 36 chars of previous_text cost 52). v3 rejects these fields
        // outright, so they only ride on the v2 family — which is the honest
        // trade: v3 gives you audio tags, v2 gives you continuity.
        ...(job.isV3 ? {} : {
          ...(job.previousText ? { previous_text: job.previousText } : {}),
          ...(job.nextText ? { next_text: job.nextText } : {}),
        }),
        model_id: job.model || MODEL,
        // `style` is SILENTLY IGNORED on v3 — /v1/models reports
        // can_use_style:false, yet the API happily returns 200 for any value, so
        // we were sending a setting that did nothing and could never learn it
        // didn't. (Same for speed and use_speaker_boost on v3.) Send it only
        // where it actually works: v2-family models.
        voice_settings: job.isV3
          ? { stability: job.stability, similarity_boost: 0.75 }
          : { stability: job.stability, similarity_boost: 0.75, style: job.style },
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

// One logical line = 1..N chunks, stitched. Each chunk is told what came before
// and after so the delivery carries across the seam.
async function synthJob(job, key) {
  if (job.chunks.length === 1) return synthOne({ ...job, text: job.chunks[0] }, key);
  log('render:tts', `elevenlabs: long text -> ${job.chunks.length} chunks`);
  const parts = [];
  for (let i = 0; i < job.chunks.length; i++) {
    const partFile = job.out.replace(/\.wav$/, `.part${i}.wav`);
    await synthOne({
      ...job,
      text: job.chunks[i],
      out: partFile,
      previousText: job.chunks[i - 1]?.slice(-300),
      nextText: job.chunks[i + 1]?.slice(0, 300),
    }, key);
    parts.push(partFile);
  }
  const list = job.out.replace(/\.wav$/, '.concat.txt');
  writeFileSync(list, parts.map((p) => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
  await ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-ar', '48000', '-ac', '1', job.out]);
  for (const p of parts) { try { unlinkSync(p); } catch { /* fine */ } }
  try { unlinkSync(list); } catch { /* fine */ }
}

export async function renderLines(lines, voices, cacheRoot) {
  const jobs = [];
  const results = {};
  let tagged = 0;
  for (const line of lines) {
    const v = voices[line.entity] || voices.narrator;
    if (!v) throw new Error(`elevenlabs: no voice for entity '${line.entity}' and no narrator fallback`);
    if (!voices[line.entity]) log('render:tts', `WARN elevenlabs: '${line.entity}' has no voice — using narrator`);
    const { id: voiceId, name } = await resolveVoice(v.candidates);
    // per-voice model override (e.g. Robert's narrator preference is
    // eleven_monolingual_v1 — "v1 English"); v3 stays the default for tags
    const model = v.model || MODEL;
    const isV3 = /_v3|^eleven_v3/.test(model);
    const tag = isV3 ? audioTag(line.emotion) : ''; // [tags] are a v3 feature
    if (tag) tagged++;
    const text = tag + speakable(line.text);
    const stability = isV3 ? snapStability(v.stability ?? 0.5) : (v.stability ?? 0.5);
    const style = v.style ?? 0.3;
    const key = contentKey([ENGINE, name, model, String(stability), String(style), text]);
    const { path: out, hit } = cached(cacheRoot, key);
    results[line.id] = out;
    // Chunk rather than refuse. A whole story pasted into Quick Narrate used to
    // hit a hard 400 at the model's cap; now it splits, renders each part with
    // the neighbouring text as prosody context, and ffmpeg-concats to one file.
    if (!hit) jobs.push({ text, voiceId, stability, style, out, model, isV3, chunks: splitChunks(text, capFor(model)) });
  }
  const chars = jobs.reduce((a, j) => a + j.text.length, 0);
  const modelsUsed = [...new Set(jobs.map((j) => j.model))].join('+') || MODEL;
  log('render:tts', `elevenlabs(${modelsUsed}): ${lines.length} lines, ${lines.length - jobs.length} cache hits, ` +
    `${jobs.length} to synthesize (~${chars} chars of credit), ${tagged} emotion-tagged`);
  const key = apiKey();
  let i = 0, done = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (i < jobs.length) {
      const job = jobs[i++];
      await synthJob(job, key);
      if (++done % 20 === 0) log('render:tts', `elevenlabs ${done}/${jobs.length}`);
    }
  }));
  if (jobs.length) log('render:tts', `elevenlabs complete: ${jobs.length} lines`);
  return results;
}
