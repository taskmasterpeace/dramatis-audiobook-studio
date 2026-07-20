// Gemini 3.1 Flash TTS engine (via Replicate): the direction-heavy voice engine.
// Voice map entry: { voice: "Charon", prompt: "<style prompt: persona/scene/notes>" }
// line.emotion -> inline [tag] prepended to the text (Gemini interprets bracketed
// modifiers natively). Content-addressed per line like every other engine.
import { contentKey, cached, log } from '../../src/util.mjs';
import { writeFileSync, unlinkSync } from 'node:fs';

const ENGINE = 'gemini-tts@1';
const MODEL = 'google/gemini-3.1-flash-tts';
const CONCURRENCY = 3;

const apiKey = () => {
  const k = process.env.REPLICATE_API_TOKEN;
  if (!k) throw new Error('REPLICATE_API_TOKEN not set (Gemini TTS runs via Replicate)');
  return k;
};

const EMOTION_TAGS = {
  anger: '[angrily]', fear: '[fearfully]', sadness: '[sadly]', surprise: '[surprised]',
  joy: '[joyfully]', tenderness: '[tenderly]', curiosity: '[curiously]', disgust: '[disgusted]',
};
function inlineTag(emotion) {
  if (!emotion) return '';
  const [name, weight] = Object.entries(emotion).sort((a, b) => b[1] - a[1])[0] || [];
  if (!name || weight < 0.4) return '';
  return (EMOTION_TAGS[name] || `[${name}]`) + ' ';
}

// Gemini caps text at 4,000 BYTES per call (text+prompt ≤ 8,000). Long text used
// to be silently sliced at 3,900 chars — words just vanished. Now it splits on
// sentence boundaries, renders each chunk, and ffmpeg-concats the pieces.
const MAX_CHUNK = 3200; // conservative: multibyte chars count as bytes, not chars
function splitChunks(text, limit = MAX_CHUNK) {
  if (Buffer.byteLength(text) <= limit) return [text];
  const out = [];
  let buf = '';
  for (const s of text.split(/(?<=[.!?…])\s+/)) {
    if (Buffer.byteLength(buf) + Buffer.byteLength(s) + 1 > limit && buf) { out.push(buf); buf = s; }
    else buf = buf ? `${buf} ${s}` : s;
    while (Buffer.byteLength(buf) > limit) { // one giant sentence: hard split
      let cut = Math.min(buf.length, limit);
      while (cut > 0 && buf[cut] !== ' ') cut--;
      out.push(buf.slice(0, cut || limit));
      buf = buf.slice(cut || limit).trim();
    }
  }
  if (buf) out.push(buf);
  return out;
}

async function synthOne(job, key) {
  const create = await fetch(`https://api.replicate.com/v1/models/${MODEL}/predictions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'wait=60' },
    body: JSON.stringify({ input: job.input }),
  });
  if (!create.ok) throw new Error(`replicate ${create.status}: ${(await create.text()).slice(0, 200)}`);
  let pred = await create.json();
  const t0 = Date.now();
  while (pred.status === 'starting' || pred.status === 'processing') {
    if (Date.now() - t0 > 180_000) throw new Error('gemini prediction timeout');
    await new Promise((r) => setTimeout(r, 1500));
    const poll = await fetch(pred.urls.get, { headers: { Authorization: `Bearer ${key}` } });
    pred = await poll.json();
  }
  if (pred.status !== 'succeeded') throw new Error(`gemini prediction ${pred.status}: ${String(pred.error).slice(0, 200)}`);
  const url = Array.isArray(pred.output) ? pred.output[0] : pred.output;
  const audio = await fetch(url);
  writeFileSync(job.outFile, Buffer.from(await audio.arrayBuffer()));
  return pred;
}

// render one logical job = 1..N chunks, concatenated into job.out
async function synthJob(job, key) {
  if (job.chunks.length === 1) {
    await synthOne({ input: { text: job.chunks[0], voice: job.voice, prompt: job.prompt, language_code: job.language_code }, outFile: job.out }, key);
    return;
  }
  log('render:tts', `gemini: long text -> ${job.chunks.length} chunks`);
  const parts = [];
  for (let i = 0; i < job.chunks.length; i++) {
    const partFile = job.out.replace(/\.wav$/, `.part${i}.wav`);
    await synthOne({ input: { text: job.chunks[i], voice: job.voice, prompt: job.prompt, language_code: job.language_code }, outFile: partFile }, key);
    parts.push(partFile);
  }
  const list = job.out.replace(/\.wav$/, '.concat.txt');
  writeFileSync(list, parts.map((p) => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
  const { ffmpeg } = await import('../../src/util.mjs');
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
    if (!v) throw new Error(`gemini: no voice for entity ${line.entity} and no narrator fallback`);
    const tag = inlineTag(line.emotion);
    if (tag) tagged++;
    const text = tag + line.text;                 // full text — chunked below, never sliced
    const prompt = (v.prompt || 'Narrate naturally and clearly.').slice(0, 3900);
    const key = contentKey([ENGINE, v.voice || 'Kore', prompt, text]);
    const { path: out, hit } = cached(cacheRoot, key);
    results[line.id] = out;
    if (!hit) jobs.push({ chunks: splitChunks(text), voice: v.voice || 'Kore', prompt, language_code: v.language_code || 'en-US', out });
  }
  log('render:tts', `gemini(${MODEL}): ${lines.length} lines, ${lines.length - jobs.length} cache hits, ` +
    `${jobs.length} to synthesize, ${tagged} emotion-tagged`);
  const key = apiKey();
  let i = 0, done = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (i < jobs.length) {
      const job = jobs[i++];
      await synthJob(job, key);
      if (++done % 10 === 0) log('render:tts', `gemini ${done}/${jobs.length}`);
    }
  }));
  if (jobs.length) log('render:tts', `gemini complete: ${jobs.length} lines`);
  return results;
}
