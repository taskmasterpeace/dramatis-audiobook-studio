// Hybrid TTS engine — the production default:
//   narration  -> Kokoro (local, free, tireless long-form)
//   dialogue   -> ElevenLabs (expressive, credits spent only on the acting)
import { renderLines as kokoro } from './kokoro.mjs';
import { renderLines as elevenlabs } from './elevenlabs.mjs';
import { log } from '../../src/util.mjs';

export async function renderLines(lines, voices, cacheRoot) {
  const narration = lines.filter((l) => l.kind !== 'dialogue');
  const dialogue = lines.filter((l) => l.kind === 'dialogue');
  log('render:tts', `hybrid: ${narration.length} narration lines -> kokoro, ${dialogue.length} dialogue lines -> elevenlabs`);
  const [a, b] = await Promise.all([
    kokoro(narration, voices.kokoro, cacheRoot),
    elevenlabs(dialogue, voices.elevenlabs, cacheRoot),
  ]);
  return { ...a, ...b };
}
