// Music engine resolver: ElevenLabs Music by default (clean commercial license),
// Suno/muapi only by explicit opt-in (DRAMATIS_MUSIC=suno) — its relay license
// is unverified for commercial use.
import { renderTrack as eleven } from './elevenlabs.mjs';
import { renderTrack as suno } from './suno.mjs';

export async function renderTrack(spec, durSec, cacheRoot) {
  const engine = process.env.DRAMATIS_MUSIC || (process.env.ELEVENLABS_API_KEY ? 'elevenlabs' : 'suno');
  return engine === 'suno' ? suno(spec, durSec, cacheRoot) : eleven(spec, durSec, cacheRoot);
}
