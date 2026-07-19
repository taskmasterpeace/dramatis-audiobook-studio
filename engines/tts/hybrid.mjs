// Hybrid TTS engine — the production default:
//   narration        -> Kokoro (local, free, tireless long-form)
//   dialogue         -> Qwen3-TTS (local designed voices, emotion instruct)
//   hero dialogue    -> ElevenLabs (lines carrying an emotion payload — the
//                       moments worth spending credits on, v3 audio tags)
import { renderLines as kokoro } from './kokoro.mjs';
import { renderLines as elevenlabs } from './elevenlabs.mjs';
import { renderLines as qwen3 } from './qwen3.mjs';
import { renderLines as gemini } from './gemini.mjs';
import { log } from '../../src/util.mjs';

const ENGINES = { kokoro, qwen3, elevenlabs, gemini };

export async function renderLines(lines, voices, cacheRoot) {
  // per-ROLE engine overrides (book.json "casting", injected as voices.__casting)
  // win over kind-based routing — e.g. narrator locked to elevenlabs, liu to qwen3.
  const casting = voices.__casting || {};
  const route = (l) => {
    const forced = casting[l.entity]?.engine;
    if (forced && ENGINES[forced] && voices[forced]) return forced;
    if (l.kind !== 'dialogue') return 'kokoro';
    return l.emotion ? 'elevenlabs' : 'qwen3';
  };
  const buckets = {};
  for (const l of lines) (buckets[route(l)] ??= []).push(l);
  log('render:tts', 'hybrid: ' + Object.entries(buckets)
    .map(([eng, ls]) => `${ls.length} -> ${eng}`).join(', ') +
    (Object.keys(casting).length ? ` (casting overrides: ${Object.keys(casting).join(',')})` : ''));
  const parts = await Promise.all(Object.entries(buckets).map(([eng, ls]) =>
    ENGINES[eng](ls, voices[eng], cacheRoot)));
  return Object.assign({}, ...parts);
}
