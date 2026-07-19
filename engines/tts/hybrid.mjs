// Hybrid TTS engine — the production default:
//   narration        -> Kokoro (local, free, tireless long-form)
//   dialogue         -> Qwen3-TTS (local designed voices, emotion instruct)
//   hero dialogue    -> ElevenLabs (lines carrying an emotion payload — the
//                       moments worth spending credits on, v3 audio tags)
import { log } from '../../src/util.mjs';
import { ENGINE_IDS, getEngine, loadRenderer } from './registry.mjs';

export async function renderLines(lines, voices, cacheRoot) {
  // per-ROLE engine overrides (book.json "casting", injected as voices.__casting)
  // win over kind-based routing — e.g. narrator locked to elevenlabs, liu to qwen3.
  const casting = voices.__casting || {};
  const route = (l) => {
    const forced = casting[l.entity]?.engine;
    if (forced && ENGINE_IDS.includes(forced) && voices[forced]) return forced;
    if (l.kind !== 'dialogue') return 'kokoro';
    return l.emotion ? 'elevenlabs' : 'qwen3';
  };
  const buckets = {};
  for (const l of lines) (buckets[route(l)] ??= []).push(l);
  log('render:tts', 'hybrid: ' + Object.entries(buckets)
    .map(([eng, ls]) => `${ls.length} -> ${eng}`).join(', ') +
    (Object.keys(casting).length ? ` (casting overrides: ${Object.keys(casting).join(',')})` : ''));

  // GPU engines run sequentially (they contend for the same 24GB card); network
  // engines run in parallel. The registry knows which is which.
  const entries = Object.entries(buckets);
  const net = entries.filter(([e]) => !getEngine(e).gpu);
  const gpu = entries.filter(([e]) => getEngine(e).gpu);
  const run = async ([eng, ls]) => (await loadRenderer(eng))(ls, voices[eng], cacheRoot);
  const netParts = await Promise.all(net.map(run));
  const gpuParts = [];
  for (const e of gpu) gpuParts.push(await run(e));
  return Object.assign({}, ...netParts, ...gpuParts);
}
