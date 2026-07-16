// Procedural SFX engine (ffmpeg synthesis, deterministic). Fallback tier for
// the SFX slot; CLAP-retrieval over CC0 libraries plugs in behind the same
// interface later.
import { contentKey, cached, ffmpeg } from '../../src/util.mjs';

const ENGINE = 'sfx-procgen@1';

const RECIPES = {
  // low rolling distant thunder
  'thunder-distant': (seed, dur = 5) =>
    `anoisesrc=color=brown:seed=${seed}:duration=${dur}:sample_rate=48000,lowpass=f=180,tremolo=f=1.7:d=0.5,` +
    `afade=t=in:d=0.4,afade=t=out:st=${dur - 3}:d=3,volume=0.8[out]`,
  // the "weight" — a huge sub impact
  'impact-boom': (seed, dur = 3) =>
    `sine=frequency=44:duration=${dur}:sample_rate=48000,afade=t=out:st=0.1:d=${dur - 0.1},volume=1.0[b];` +
    `anoisesrc=color=brown:seed=${seed}:duration=1.2:sample_rate=48000,lowpass=f=90,afade=t=out:st=0.05:d=1.1,volume=0.9[n];` +
    `[b][n]amix=inputs=2:duration=first,volume=1.2[out]`,
  // "the sky tearing along a seam" — rising whoosh
  'riser-tear': (seed, dur = 4.5) =>
    `anoisesrc=color=white:seed=${seed}:duration=${dur}:sample_rate=48000,highpass=f=300,lowpass=f=5200,` +
    `afade=t=in:d=${dur - 0.4},afade=t=out:st=${dur - 0.4}:d=0.4,volume=0.85[out]`,
  // the Muo spheres — soft harmonic hum, gently breathing
  'sphere-hum': (seed, dur = 60) =>
    `sine=frequency=110:duration=${dur}:sample_rate=48000,volume=0.30[a];` +
    `sine=frequency=165:duration=${dur}:sample_rate=48000,volume=0.20[b];` +
    `sine=frequency=221:duration=${dur}:sample_rate=48000,volume=0.12[c];` +
    `[a][b][c]amix=inputs=3:duration=first,tremolo=f=0.45:d=0.35,` +
    `afade=t=in:d=2.5,afade=t=out:st=${dur - 4}:d=4,volume=0.8[out]`,
  // tentacle strike — sharp wet snap
  'tentacle-snap': (seed, dur = 0.5) =>
    `anoisesrc=color=white:seed=${seed}:duration=0.09:sample_rate=48000,highpass=f=800,afade=t=out:st=0.01:d=0.08,volume=1.0[n];` +
    `sine=frequency=1900:duration=0.03:sample_rate=48000,volume=0.6[k];` +
    `[n][k]amix=inputs=2:duration=longest,apad=whole_dur=${dur}[out]`,
};

export async function renderSfx(name, seed, cacheRoot, dur) {
  const recipe = RECIPES[name];
  if (!recipe) throw new Error(`unknown sfx: ${name}`);
  const key = contentKey([ENGINE, name, String(seed), String(dur ?? 'default')]);
  const { path: out, hit } = cached(cacheRoot, key);
  if (hit) return out;
  const graph = dur ? recipe(seed, dur) : recipe(seed);
  await ffmpeg(['-filter_complex', graph, '-map', '[out]', '-ar', '48000', '-ac', '1', out]);
  return out;
}
