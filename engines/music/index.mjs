// Music engine resolver. Two verified-licence lanes and NOTHING else — a silent
// fallback to some unvetted relay could put a book on sale scored by audio
// nobody checked the rights on, and the user would never be told.
//
//   DRAMATIS_MUSIC=acestep | elevenlabs   force a lane explicitly
//   otherwise: ACE-Step if it's installed, else ElevenLabs if its key is set
//
// FREE FIRST, by ear ruling (Robert, 2026-07-20): the ACE-Step beds were judged
// "worth keeping", so score does not need to cost money. Same law as the voice
// routing — the local tier is the default and the paid tier is where a specific
// job demands it, not the other way round. Force premium per book with
// DRAMATIS_MUSIC=elevenlabs.
//
// ACE-Step 1.5 is the free/local lane (MIT code AND weights — both licence
// files read 2026-07-20). ElevenLabs Music is the paid lane (commercial use per
// subscription). Every result carries its licence string into the QA report.
import { renderTrack as eleven } from './elevenlabs.mjs';
import { renderTrack as acestep } from './acestep.mjs';

export async function renderTrack(spec, durSec, cacheRoot) {
  const forced = process.env.DRAMATIS_MUSIC;
  if (forced === 'acestep') return acestep(spec, durSec, cacheRoot);
  if (forced === 'elevenlabs') return eleven(spec, durSec, cacheRoot);
  if (forced) throw new Error(`music: unknown DRAMATIS_MUSIC='${forced}' (acestep | elevenlabs)`);

  if (process.env.ACESTEP_DIR || process.env.ACESTEP_URL) return acestep(spec, durSec, cacheRoot);
  if (process.env.ELEVENLABS_API_KEY) return eleven(spec, durSec, cacheRoot);
  throw new Error('music: no music engine available. Set ELEVENLABS_API_KEY (paid, ElevenLabs '
    + 'Music), or install ACE-Step 1.5 locally (free) and set ACESTEP_DIR to the checkout — '
    + 'or drop the music cue from the chapter.');
}
