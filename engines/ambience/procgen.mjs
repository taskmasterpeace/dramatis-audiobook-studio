// Procedural ambience engine (ffmpeg synthesis, fully offline, deterministic
// via seeds). Fallback tier for the generative engine slot (Stable Audio Open
// plugs in behind the same interface later).
import { contentKey, cached, ffmpeg } from '../../src/util.mjs';

const ENGINE = 'amb-procgen@2';

// spec: { type: 'rain'|'roomtone-morning', intensity, drone }
export async function renderBed(spec, durationSec, seed, cacheRoot) {
  const dur = Math.ceil(durationSec * 10) / 10;
  const key = contentKey([ENGINE, JSON.stringify(spec), String(dur), String(seed)]);
  const { path: out, hit } = cached(cacheRoot, key);
  if (hit) return out;

  const i = spec.intensity ?? 0.5;
  const layers = []; // [label, filterchain]
  if (spec.type === 'rain') {
    layers.push(['rain', `anoisesrc=color=pink:seed=${seed}:duration=${dur}:sample_rate=48000,highpass=f=350,lowpass=f=${Math.round(3500 + 3500 * i)},tremolo=f=0.35:d=0.25,volume=${(0.5 + 0.5 * i).toFixed(2)}`]);
    layers.push(['rumble', `anoisesrc=color=brown:seed=${seed + 1}:duration=${dur}:sample_rate=48000,lowpass=f=120,volume=${(0.25 + 0.35 * i).toFixed(2)}`]);
  } else if (spec.type === 'roomtone-morning') {
    layers.push(['air', `anoisesrc=color=brown:seed=${seed}:duration=${dur}:sample_rate=48000,lowpass=f=250,volume=0.30`]);
    layers.push(['shimmer', `anoisesrc=color=pink:seed=${seed + 1}:duration=${dur}:sample_rate=48000,highpass=f=2500,lowpass=f=9000,tremolo=f=0.12:d=0.5,volume=0.06`]);
    layers.push(['murmur', `anoisesrc=color=pink:seed=${seed + 2}:duration=${dur}:sample_rate=48000,bandpass=f=500:w=400,tremolo=f=3.7:d=0.7,volume=${(0.05 + 0.1 * i).toFixed(2)}`]);
  } else {
    throw new Error(`unknown ambience type: ${spec.type}`);
  }
  if (spec.drone) {
    layers.push(['drone', `sine=frequency=52:duration=${dur}:sample_rate=48000,tremolo=f=0.2:d=0.4,volume=0.22`]);
  }

  const chains = layers.map(([label, chain]) => `${chain}[${label}]`);
  const inputs = layers.map(([label]) => `[${label}]`).join('');
  const graph = chains.join(';')
    + `;${inputs}amix=inputs=${layers.length}:duration=first,volume=0.9,`
    + `afade=t=in:d=1.5,afade=t=out:st=${Math.max(0, dur - 2)}:d=2[out]`;
  await ffmpeg(['-filter_complex', graph, '-map', '[out]', '-ar', '48000', '-ac', '1', out]);
  return out;
}
