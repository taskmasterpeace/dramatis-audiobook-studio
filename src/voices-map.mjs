// The one way to build a renderer voice map from book.json. Extracted from
// bin/dramatis.mjs so the takes API resolves voices through the SAME code as
// produce — a second copy is how a character silently renders in the
// narrator's voice, a defect only discoverable by listening to the book.
export function buildVoices(book, ttsName) {
  let voices = book.voices?.[ttsName];
  if (!voices) throw new Error(`book.json has no voice map for engine: ${ttsName}`);
  // "@name" entries reference another voice map (e.g. hybrid -> kokoro + elevenlabs)
  voices = Object.fromEntries(Object.entries(voices).map(([k, v]) =>
    [k, typeof v === 'string' && v.startsWith('@') ? book.voices[v.slice(1)] : v]));
  // per-role engine overrides from book.json casting reach the hybrid router
  if (book.casting) voices.__casting = book.casting;
  return voices;
}

// The hybrid router's decision — the ONE authority (hybrid.mjs imports this;
// a second copy already drifted once in the server's engine lists).
// Precedence: a selected take's engine pin > per-role casting override >
// kind/emotion routing.
export function routeEngine(line, voices, engineIds) {
  if (line.takeEngine && engineIds.includes(line.takeEngine) && voices[line.takeEngine]) return line.takeEngine;
  const casting = voices.__casting || {};
  const forced = casting[line.entity]?.engine;
  if (forced && engineIds.includes(forced) && voices[forced]) return forced;
  if (line.kind !== 'dialogue') return 'kokoro';
  return line.emotion ? 'elevenlabs' : 'qwen3';
}
