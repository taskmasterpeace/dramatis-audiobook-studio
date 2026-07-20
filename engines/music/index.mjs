// Music engine resolver: ElevenLabs Music, the one engine whose commercial
// licence we have actually verified. There is deliberately no fallback — a
// silent route to some other relay could put a book on sale scored by audio
// nobody checked the licence on, and the user would never be told.
import { renderTrack as eleven } from './elevenlabs.mjs';

export async function renderTrack(spec, durSec, cacheRoot) {
  if (!process.env.ELEVENLABS_API_KEY) {
    throw new Error('music: no music engine available. Set ELEVENLABS_API_KEY to score with '
      + 'ElevenLabs Music, or drop the music cue from the chapter.');
  }
  return eleven(spec, durSec, cacheRoot);
}
