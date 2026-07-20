// Gemini 3.1 Flash TTS engine (via Replicate): the direction-heavy voice engine.
// Voice map entry: { voice: "Charon", prompt: "<style prompt: persona/scene/notes>" }
// line.emotion -> inline [tag] prepended to the text (Gemini interprets bracketed
// modifiers natively). Content-addressed per line like every other engine.
import { contentKey, cached, log, ffprobeDuration } from '../../src/util.mjs';
import { writeFileSync, unlinkSync } from 'node:fs';

const ENGINE = 'gemini-tts@1';
const MODEL = 'google/gemini-3.1-flash-tts';
const CONCURRENCY = 3;

const apiKey = () => {
  const k = process.env.REPLICATE_API_TOKEN;
  if (!k) throw new Error('REPLICATE_API_TOKEN not set (Gemini TTS runs via Replicate)');
  return k;
};

// Emotion goes in the PROMPT, never in a bracket tag. Google documents four tag
// behaviours, and "vocalized markup" — where the tag is SPOKEN ALOUD as a word —
// is triggered by exactly the adjective/adverb shape we used to emit
// ([angrily], [sadly], [curiously]); the fallback `[${name}]` emitted bare nouns
// ([sadness]), the highest-risk shape of all. Since `prompt` and `text` are
// separate API fields and the prompt is built per call, per-line emotion can ride
// in the direction instead — which is also what Google recommends for steering.
const EMOTION_DIRECTION = {
  anger: 'This line is angry — hard consonants, pushed volume, clipped ends.',
  fear: 'This line is frightened — tight throat, unsteady breath, faster than they mean to be.',
  sadness: 'This line is grief-heavy — quieter, slower, the voice thinning out at the end.',
  // KEEP THE SHAPE. Every entry here must read "This line is <adjective> —
  // <delivery>." This one said "This line lands as a shock — …" and rendered
  // 3.8x over length, reproducibly, on every pass. Swapping only the opener to
  // "This line is shocked" — same trailing clause — measured 0.99x. The unusual
  // phrasing, not the content, is what got vocalized.
  surprise: 'This line is shocked — the pitch jumps, the words come fast and clipped.',
  joy: 'This line is delighted — lifted, open, a smile audible in the vowels.',
  tenderness: 'This line is tender — soft, close, almost private.',
  curiosity: 'This line is genuinely curious — rising at the end, leaning in.',
  disgust: 'This line is repelled — pulled back, flattened, distaste in the tone.',
};
function emotionDirection(emotion) {
  if (!emotion) return '';
  const [name, weight] = Object.entries(emotion).sort((a, b) => b[1] - a[1])[0] || [];
  if (!name || weight < 0.4) return '';
  return EMOTION_DIRECTION[name] || `This line carries ${name}.`;
}

// the API caps are in BYTES; slicing by character overflows on multibyte text
function clampBytes(s, limit) {
  if (Buffer.byteLength(s) <= limit) return s;
  let out = s;
  while (Buffer.byteLength(out) > limit) out = out.slice(0, Math.floor(out.length * 0.95));
  return out;
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

// ── the length gate ─────────────────────────────────────────────────────────
// Google documents that a style prompt can make the model READ THE DIRECTION
// ALOUD instead of performing it. Measured 2026-07-20 over 8 emotions x 2 prompt
// shapes x 3 reps: normal delivery lands 0.9-2.1x the neutral duration and no
// prompt shape is reliably safer — but isolated renders came back at 5.3x and
// 6.2x, i.e. seconds of speech that is not in the script. It is intermittent,
// so wording cannot fix it; re-rolling can, because generation is
// non-deterministic. Same discipline as the Qwen3 register gate: measure the
// output, retry, and refuse rather than ship audio nobody has heard.
const CHARS_PER_SEC = 14;   // measured on neutral delivery, this voice family
const ATTEMPTS = 3;

function lengthBudget(chars) {
  const expected = chars / CHARS_PER_SEC;
  // 3x covers the slowest legitimate delivery measured (2.1x) with headroom.
  // The floor was +8 s and let a 4.1x render through on a short line, because
  // 8 s dwarfs a 2 s line — +3 s is enough slack for one held pause without
  // swallowing the fault the gate exists to catch.
  return Math.max(expected * 3, expected + 3);
}

async function synthJobGated(job, key) {
  const chars = job.chunks.reduce((n, c) => n + c.length, 0);
  const budget = lengthBudget(chars);
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    await synthJob(job, key);
    // a probe failure must not kill a render — an unmeasurable clip is simply
    // ungated, the same as before this gate existed
    let got = null;
    try { got = await ffprobeDuration(job.out); } catch { return; }
    if (!(got > budget)) return;
    log('render:tts', `WARN gemini [${job.lineId} / ${job.entity}]: ${got.toFixed(1)}s for ${chars} chars `
      + `(budget ${budget.toFixed(1)}s) — the direction may have been read aloud; re-rolling (${attempt}/${ATTEMPTS})`);
  }
  throw new Error(`gemini [line ${job.lineId}, entity '${job.entity}']: ${ATTEMPTS} renders all ran far longer `
    + `than the text warrants (${chars} chars, budget ${budget.toFixed(1)}s) — the style prompt is probably being `
    + `spoken aloud. Shorten or re-word the voice prompt for this character. Prompt was: ${job.prompt.slice(-160)}`);
}

export async function renderLines(lines, voices, cacheRoot) {
  const jobs = [];
  const results = {};
  let tagged = 0;
  for (const line of lines) {
    const v = voices[line.entity] || voices.narrator;
    if (!v) throw new Error(`gemini: no voice for entity ${line.entity} and no narrator fallback`);
    const dir = emotionDirection(line.emotion);
    if (dir) tagged++;
    const text = line.text;                       // full text — chunked below, never sliced
    // A vague prompt is a documented failure mode: it can trip the synthesis
    // classifier (PROHIBITED_CONTENT) or make the model read the notes aloud.
    const base = v.prompt || 'Synthesize this performance as speech. PERFORMANCE\nStyle: a natural, engaging audiobook narrator. Pace: unhurried and clear.';
    const prompt = clampBytes(dir ? `${base}\n${dir}` : base, 3900);
    const key = contentKey([ENGINE, v.voice || 'Kore', prompt, text]);
    const { path: out, hit } = cached(cacheRoot, key);
    results[line.id] = out;
    // text and prompt share an 8,000-byte budget per call, so a long director's
    // note shrinks how much text may ride with it — chunk against what's left
    const room = Math.min(MAX_CHUNK, 7800 - Buffer.byteLength(prompt));
    if (!hit) jobs.push({ chunks: splitChunks(text, room), voice: v.voice || 'Kore', prompt, language_code: v.language_code || 'en-US', out, lineId: line.id, entity: line.entity });
  }
  log('render:tts', `gemini(${MODEL}): ${lines.length} lines, ${lines.length - jobs.length} cache hits, ` +
    `${jobs.length} to synthesize, ${tagged} emotion-directed`);
  const key = apiKey();
  let i = 0, done = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (i < jobs.length) {
      const job = jobs[i++];
      await synthJobGated(job, key);
      if (++done % 10 === 0) log('render:tts', `gemini ${done}/${jobs.length}`);
    }
  }));
  if (jobs.length) log('render:tts', `gemini complete: ${jobs.length} lines`);
  return results;
}
