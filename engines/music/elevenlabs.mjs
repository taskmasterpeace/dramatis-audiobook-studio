// ElevenLabs Music (Eleven Music) — the underscore engine, and the only one whose
// commercial licence we have verified. Same subscription as the voice work.
// Contract: renderTrack(spec, durSec, cacheRoot).
import { writeFileSync } from 'node:fs';
import { contentKey, cached, ffmpeg, log } from '../../src/util.mjs';

const ENGINE = 'elevenlabs-music@1';
const LICENSE = 'ElevenLabs subscription — commercial use per plan terms';

const apiKey = () => {
  const k = process.env.ELEVENLABS_API_KEY;
  if (!k) throw new Error('ELEVENLABS_API_KEY not set');
  return k;
};

export async function renderTrack(spec, durSec, cacheRoot) {
  const dur = Math.min(300, Math.max(10, Math.round(durSec)));
  const key = contentKey([ENGINE, spec, String(dur)]);
  const { path: out, hit } = cached(cacheRoot, key);
  if (hit) return { file: out, engine: ENGINE, license: LICENSE };

  // Prompting law (measured 2026-07-19): always append instrumental/no-vocals —
  // Eleven Music happily writes LYRICS for an unadorned mood prompt, and sung
  // words under narration break the cast-are-the-only-voices law.
  const prompt = `${spec}. Instrumental only, no vocals, no singing. Cinematic audiobook underscore that sits under narration.`;
  const res = await fetch('https://api.elevenlabs.io/v1/music', {
    method: 'POST',
    headers: { 'xi-api-key': apiKey(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, music_length_ms: dur * 1000 }),
  });
  if (!res.ok) throw new Error(`eleven music ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const mp3 = out.replace(/\.wav$/, '.src.mp3');
  writeFileSync(mp3, Buffer.from(await res.arrayBuffer()));
  await ffmpeg(['-i', mp3, '-ar', '48000', '-ac', '2', out]);
  log('music', `eleven-music track (${dur}s) for "${spec.slice(0, 50)}"`);
  return { file: out, engine: ENGINE, license: LICENSE };
}
