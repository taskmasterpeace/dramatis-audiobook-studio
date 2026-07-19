// Hybrid TTS engine — the production default:
//   narration        -> Kokoro (local, free, tireless long-form)
//   dialogue         -> Qwen3-TTS (local designed voices, emotion instruct)
//   hero dialogue    -> ElevenLabs (lines carrying an emotion payload — the
//                       moments worth spending credits on, v3 audio tags)
import { renderLines as kokoro } from './kokoro.mjs';
import { renderLines as elevenlabs } from './elevenlabs.mjs';
import { renderLines as qwen3 } from './qwen3.mjs';
import { log } from '../../src/util.mjs';

export async function renderLines(lines, voices, cacheRoot) {
  const narration = lines.filter((l) => l.kind !== 'dialogue');
  const hero = lines.filter((l) => l.kind === 'dialogue' && l.emotion);
  const dialogue = lines.filter((l) => l.kind === 'dialogue' && !l.emotion);
  log('render:tts', `hybrid: ${narration.length} narration -> kokoro, ` +
    `${dialogue.length} dialogue -> qwen3, ${hero.length} hero -> elevenlabs`);
  const [a, b, c] = await Promise.all([
    kokoro(narration, voices.kokoro, cacheRoot),
    dialogue.length ? qwen3(dialogue, voices.qwen3, cacheRoot) : {},
    hero.length ? elevenlabs(hero, voices.elevenlabs, cacheRoot) : {},
  ]);
  return { ...a, ...b, ...c };
}
