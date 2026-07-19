// One TTS registry. The engine list was written out four times (server audition
// knew 4, /api/say knew 2, casting audition knew 3, hybrid kept a fifth static
// list) and they had already drifted — adding an engine meant finding all five.
// Everything that needs to name or load an engine imports this.
export const ENGINES = {
  kokoro: { id: 'kokoro', label: 'Kokoro', local: true, free: true, gpu: false, load: () => import('./kokoro.mjs') },
  qwen3: { id: 'qwen3', label: 'Qwen3', local: true, free: true, gpu: true, load: () => import('./qwen3.mjs') },
  elevenlabs: { id: 'elevenlabs', label: 'ElevenLabs', local: false, free: false, gpu: false, key: 'ELEVENLABS_API_KEY', load: () => import('./elevenlabs.mjs') },
  gemini: { id: 'gemini', label: 'Gemini 3.1 Flash TTS', local: false, free: false, gpu: false, key: 'REPLICATE_API_TOKEN', load: () => import('./gemini.mjs') },
  sapi: { id: 'sapi', label: 'Windows SAPI (legacy)', local: true, free: true, gpu: false, legacy: true, load: () => import('./sapi.mjs') },
};

export const ENGINE_IDS = Object.keys(ENGINES).filter((k) => !ENGINES[k].legacy);
export const FREE_ENGINE_IDS = ENGINE_IDS.filter((k) => ENGINES[k].free);

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
