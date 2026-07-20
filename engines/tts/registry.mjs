// One TTS registry. The engine list was written out four times (server audition
// knew 4, /api/say knew 2, casting audition knew 3, hybrid kept a fifth static
// list) and they had already drifted — adding an engine meant finding all five.
// Everything that needs to name or load an engine imports this.
// limits: perCall = the raw API/model cap; chunked = the engine splits long text
// itself (sentence-packed + concatenated) so callers can send any length safely.
// An engine with chunked:false will fail or truncate past perCall — warn early.
export const ENGINES = {
  kokoro: { id: 'kokoro', label: 'Kokoro', local: true, free: true, gpu: false, limits: { perCall: 280, chunked: true }, load: () => import('./kokoro.mjs') },
  // 8192 output frames at 12.5 Hz = 655 s of audio; at a measured 17 chars/s
  // that is ~11,100 chars, so our old 1,500 was ~7x too conservative. Held at
  // 6,000: the real risk is a runaway generation loop, whose confirmed triggers
  // are exotic characters and a ~0.5% random end-of-speech failure rather than
  // length itself — but one degenerate line drags its whole batch to 11 minutes.
  qwen3: { id: 'qwen3', label: 'Qwen3', local: true, free: true, gpu: true, limits: { perCall: 6000, chunked: false, note: 'hard ceiling ~11,000 chars (655 s of audio); kept lower because a runaway line stalls its batch' }, load: () => import('./qwen3.mjs') },
  // chunked since 2026-07-20: a whole story can go in and come out as one file.
  // The per-call cap still exists (v3 5k, multilingual_v2 10k, flash_v2_5 40k —
  // enforced walls sit at 1.1x those, but that slack is undocumented); the
  // engine splits against it and stitches, using previous_text/next_text for
  // prosody continuity on the v2 family (v3 rejects those fields).
  elevenlabs: { id: 'elevenlabs', label: 'ElevenLabs', local: false, free: false, gpu: false, key: 'ELEVENLABS_API_KEY', limits: { perCall: 5000, chunked: true, note: 'splits long text and stitches; monthly credit quota is the real ceiling' }, load: () => import('./elevenlabs.mjs') },
  gemini: { id: 'gemini', label: 'Gemini 3.1 Flash TTS', local: false, free: false, gpu: false, key: 'REPLICATE_API_TOKEN', limits: { perCall: 3200, chunked: true, note: '4,000-byte API cap; engine chunks + concats automatically' }, load: () => import('./gemini.mjs') },
};

export const ENGINE_IDS = Object.keys(ENGINES).filter((k) => !ENGINES[k].legacy);

export function getEngine(id) {
  const e = ENGINES[id];
  if (!e) throw new Error(`unknown TTS engine '${id}' (known: ${ENGINE_IDS.join(', ')})`);
  return e;
}

export async function loadRenderer(id) {
  const { renderLines } = await getEngine(id).load();
  return renderLines;
}

// which engines are actually usable right now (key present / local)
export function availableEngines() {
  return Object.fromEntries(ENGINE_IDS.map((id) => [id, !ENGINES[id].key || !!process.env[ENGINES[id].key]]));
}
