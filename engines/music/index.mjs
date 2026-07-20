// Music engine resolver: ElevenLabs Music by default (clean commercial license),
// Suno/muapi only by explicit opt-in (DRAMATIS_MUSIC=suno) — its relay license
// is unverified for commercial use.
import { renderTrack as eleven } from './elevenlabs.mjs';
import { renderTrack as suno } from './suno.mjs';

export async function renderTrack(spec, durSec, cacheRoot) {
  // No silent fallback to Suno. Without a key this used to quietly route to a
  // relay whose commercial licence we have never verified — a user could ship a
  // book scored by it without ever being told. Opting in must be deliberate.
  const engine = process.env.DRAMATIS_MUSIC
    || (process.env.ELEVENLABS_API_KEY ? 'elevenlabs' : null);
  if (!engine) {
    throw new Error('music: no music engine available. Set ELEVENLABS_API_KEY, or '
      + 'set DRAMATIS_MUSIC=suno to opt into the Suno/muapi relay — note its licence '
      + 'is UNVERIFIED for commercial use, so do not ship what it produces.');
  }
  return engine === 'suno' ? suno(spec, durSec, cacheRoot) : eleven(spec, durSec, cacheRoot);
}
