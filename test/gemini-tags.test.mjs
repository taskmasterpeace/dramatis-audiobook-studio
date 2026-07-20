// Guards the ONE Gemini failure mode that ships silently into finished audio:
// a bracket tag being SPOKEN ALOUD as a word instead of styling the delivery.
//
// Google Cloud documents four markup modes. Mode 3, "vocalized markup", says
// verbatim that "the markup tag itself is spoken as a word" and that this "is
// likely an undesired side effect for most use cases". It is triggered by
// adjective/adverb-shaped tags — which is exactly what this engine used to emit
// on every emotional line ([angrily], [sadly], [curiously]), with a
// `[${name}]` fallback that emitted bare nouns ([sadness]), the worst shape of
// all. Nobody catches this in review; you catch it by listening to a finished
// chapter, which is far too late.
//
// The fix moved emotion into the style prompt entirely, so the engine now emits
// NO tags. This test pins that: it stubs the network, renders one line per
// emotion, and inspects the exact payload sent to Google. Any tag that appears
// in the text must be one Google documents as not-spoken.
import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { renderLines } from '../engines/tts/gemini.mjs';

// Mode 1 (non-speech), Mode 2 (style modifiers) and Mode 4 (pacing) — documented
// as NOT spoken — plus ai.google.dev's "commonly used" list. Deliberately
// excludes [curious]: it is listed as commonly-used on ai.google.dev but as
// spoken-aloud on the Cloud docs, so it needs an ear test before it is allowed.
const DOCUMENTED_SAFE = new Set([
  'sigh', 'sighs', 'laughing', 'laughs', 'uhm', 'gasp', 'giggles', 'crying',
  'sarcasm', 'sarcastic', 'robotic', 'shouting', 'whispering', 'whispers',
  'extremely fast', 'short pause', 'medium pause', 'long pause',
  'amazed', 'excited', 'mischievously', 'panicked', 'serious', 'tired', 'trembling',
]);

const EMOTIONS = ['anger', 'fear', 'sadness', 'surprise', 'joy', 'tenderness', 'curiosity', 'disgust', 'ennui'];
const LINE_TEXT = 'I told you it would come to this.';

// Capture what would go to Google, without going to Google.
async function capturePayloads() {
  const sent = [];
  const realFetch = globalThis.fetch;
  const hadToken = 'REPLICATE_API_TOKEN' in process.env;
  const oldToken = process.env.REPLICATE_API_TOKEN;
  process.env.REPLICATE_API_TOKEN = 'test-token-not-used';
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('/predictions')) {
      sent.push(JSON.parse(opts.body).input);
      return { ok: true, json: async () => ({ status: 'succeeded', output: 'https://example.invalid/a.wav' }) };
    }
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(44) };
  };
  try {
    // a fresh cache dir guarantees every line is a miss, so every line is "sent"
    const dir = mkdtempSync(path.join(tmpdir(), 'dramatis-gemini-tags-'));
    const lines = EMOTIONS.map((e, i) => ({
      id: `l${i}`, kind: 'dialogue', entity: 'narrator', text: LINE_TEXT, emotion: { [e]: 1 },
    }));
    lines.push({ id: 'plain', kind: 'narration', entity: 'narrator', text: LINE_TEXT });
    await renderLines(lines, { narrator: { voice: 'Kore', prompt: 'A test voice.' } }, dir);
  } finally {
    globalThis.fetch = realFetch;
    if (hadToken) process.env.REPLICATE_API_TOKEN = oldToken; else delete process.env.REPLICATE_API_TOKEN;
  }
  return sent;
}

test('gemini: no undocumented bracket tag is ever sent in the spoken text', async () => {
  const sent = await capturePayloads();
  assert.strictEqual(sent.length, EMOTIONS.length + 1, 'every line should have produced one API call');
  for (const input of sent) {
    for (const m of String(input.text).matchAll(/\[([^\]]+)\]/g)) {
      const tag = m[1].toLowerCase().trim();
      assert.ok(DOCUMENTED_SAFE.has(tag),
        `[${tag}] is not a documented not-spoken tag — Google may read it aloud as a word`);
    }
  }
});

test('gemini: the spoken text is the line, untouched', async () => {
  // the regression that would reintroduce the bug is prepending anything to text
  const sent = await capturePayloads();
  for (const input of sent) assert.strictEqual(input.text, LINE_TEXT);
});

test('gemini: emotion reaches the prompt instead, and unknown emotions stay safe', async () => {
  const sent = await capturePayloads();
  const byPrompt = sent.map((s) => s.prompt);
  // a known emotion adds a direction sentence to the prompt...
  assert.ok(byPrompt.some((p) => /angry/i.test(p)), 'anger should be directed in the prompt');
  assert.ok(byPrompt.some((p) => /frightened/i.test(p)), 'fear should be directed in the prompt');
  // ...an UNKNOWN one ("ennui") must still produce prose, never a bracket tag
  const ennui = byPrompt.find((p) => /ennui/i.test(p));
  assert.ok(ennui, 'an unrecognised emotion should still be carried in the prompt');
  assert.doesNotMatch(ennui, /\[/, 'an unrecognised emotion must never become a bracket tag');
  // the plain line gets no direction at all
  assert.ok(byPrompt.some((p) => !/This line/i.test(p)), 'an un-emotional line should carry no direction');
});

test('gemini: prompt and text respect the BYTE caps, not character counts', async () => {
  // multibyte punctuation is the trap: 3,900 chars of em-dashes is 11,700 bytes
  const sent = [];
  const realFetch = globalThis.fetch;
  process.env.REPLICATE_API_TOKEN = 'test-token-not-used';
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('/predictions')) {
      sent.push(JSON.parse(opts.body).input);
      return { ok: true, json: async () => ({ status: 'succeeded', output: 'https://example.invalid/a.wav' }) };
    }
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(44) };
  };
  try {
    const dir = mkdtempSync(path.join(tmpdir(), 'dramatis-gemini-bytes-'));
    await renderLines(
      [{ id: 'big', kind: 'narration', entity: 'narrator', text: 'Word — word. '.repeat(400) }],
      { narrator: { voice: 'Kore', prompt: `Direction — ${'— '.repeat(2000)}` } },
      dir,
    );
  } catch {
    // Text this long splits into several chunks, so the engine ffmpeg-concats the
    // parts — and the stub's 44 fake bytes are not a decodable wav. The subject of
    // this test is the payload, which has already been captured by the time the
    // concat runs, so a stitching failure here is expected and not what we assert.
  } finally { globalThis.fetch = realFetch; delete process.env.REPLICATE_API_TOKEN; }
  assert.ok(sent.length > 1, 'long text should have been split into multiple calls');

  for (const input of sent) {
    assert.ok(Buffer.byteLength(input.prompt) <= 4000, `prompt ${Buffer.byteLength(input.prompt)} bytes exceeds the 4,000-byte cap`);
    assert.ok(Buffer.byteLength(input.text) <= 4000, `text ${Buffer.byteLength(input.text)} bytes exceeds the 4,000-byte cap`);
    const combined = Buffer.byteLength(input.text) + Buffer.byteLength(input.prompt);
    assert.ok(combined <= 8000, `text+prompt ${combined} bytes exceeds the 8,000-byte combined cap`);
  }
});
