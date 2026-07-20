// Text -> SFX via ElevenLabs sound-generation. Every generated clip is saved
// into the HOUSE FOLEY LIBRARY (corpus/house/) with a caption, so the library
// grows with production: generate once, retrieve forever. Re-index the house
// after adding clips: node engines/sfx/house-index.mjs
import path from 'node:path';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { ffmpeg, log } from '../../src/util.mjs';

const HOUSE = path.resolve('corpus/house');
const MANIFEST = path.join(HOUSE, 'house-manifest.json');

const apiKey = () => {
  const k = process.env.ELEVENLABS_API_KEY;
  if (!k) throw new Error('ELEVENLABS_API_KEY not set');
  return k;
};

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);

// generateSfx("single solid boxing punch impact", { dur: 1.5 })
// -> { file, caption } saved under corpus/house/
export async function generateSfx(text, { dur = 3, influence = 0.55, variant = '' } = {}) {
  mkdirSync(HOUSE, { recursive: true });
  const name = slug(text) + (variant ? `-${variant}` : '');
  const wav = path.join(HOUSE, `${name}.wav`);
  if (!existsSync(wav)) {
    const res = await fetch('https://api.elevenlabs.io/v1/sound-generation', {
      method: 'POST',
      headers: { 'xi-api-key': apiKey(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, duration_seconds: dur, prompt_influence: influence }),
    });
    if (!res.ok) throw new Error(`sound-generation ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const mp3 = wav.replace(/\.wav$/, '.src.mp3');
    writeFileSync(mp3, Buffer.from(await res.arrayBuffer()));
    await ffmpeg(['-i', mp3, '-ar', '48000', '-ac', '1', wav]);
    log('sfx-gen', `generated "${text}" -> house/${name}.wav`);
  }
  const manifest = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : {};
  manifest[name] = { caption: `${name}.wav — ${text} (house foley, ElevenLabs-generated, commercial-ok)`, text };
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
  return { file: wav, caption: manifest[name].caption };
}
