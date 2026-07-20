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
  } else if (spec.type === 'room-hum') {
    // interior: air handling + faint mains hum + fluorescent flicker
    layers.push(['air', `anoisesrc=color=brown:seed=${seed}:duration=${dur}:sample_rate=48000,lowpass=f=200,volume=${(0.20 + 0.2 * i).toFixed(2)}`]);
    layers.push(['mains', `sine=frequency=120:duration=${dur}:sample_rate=48000,volume=${(0.02 + 0.04 * i).toFixed(3)}`]);
    layers.push(['flicker', `anoisesrc=color=pink:seed=${seed + 1}:duration=${dur}:sample_rate=48000,highpass=f=6000,tremolo=f=11:d=0.8,volume=${(0.01 + 0.03 * i).toFixed(3)}`]);
  } else if (spec.type === 'crowd') {
    // murmuring crowd -> roaring plaza as intensity rises
    layers.push(['murmur', `anoisesrc=color=pink:seed=${seed}:duration=${dur}:sample_rate=48000,bandpass=f=450:w=450,tremolo=f=4.1:d=0.7,volume=${(0.10 + 0.35 * i).toFixed(2)}`]);
    layers.push(['wash', `anoisesrc=color=pink:seed=${seed + 1}:duration=${dur}:sample_rate=48000,bandpass=f=900:w=700,tremolo=f=0.6:d=0.4,volume=${(0.06 + 0.30 * i).toFixed(2)}`]);
    layers.push(['body', `anoisesrc=color=brown:seed=${seed + 2}:duration=${dur}:sample_rate=48000,lowpass=f=300,volume=${(0.10 + 0.25 * i).toFixed(2)}`]);
  } else if (spec.type === 'city-night') {
    // distant traffic wash far below a high terrace
    layers.push(['traffic', `anoisesrc=color=brown:seed=${seed}:duration=${dur}:sample_rate=48000,lowpass=f=400,tremolo=f=0.18:d=0.35,volume=${(0.18 + 0.22 * i).toFixed(2)}`]);
    layers.push(['wind', `anoisesrc=color=pink:seed=${seed + 1}:duration=${dur}:sample_rate=48000,bandpass=f=1200:w=900,tremolo=f=0.12:d=0.6,volume=${(0.04 + 0.08 * i).toFixed(2)}`]);
  } else if (spec.type === 'lab-cold') {
    // white facility: cold drone + hiss + slow pulse
    layers.push(['drone', `sine=frequency=58:duration=${dur}:sample_rate=48000,tremolo=f=0.15:d=0.3,volume=${(0.10 + 0.12 * i).toFixed(2)}`]);
    layers.push(['hiss', `anoisesrc=color=white:seed=${seed}:duration=${dur}:sample_rate=48000,highpass=f=7000,volume=${(0.008 + 0.02 * i).toFixed(3)}`]);
    layers.push(['vents', `anoisesrc=color=brown:seed=${seed + 1}:duration=${dur}:sample_rate=48000,lowpass=f=160,volume=${(0.12 + 0.12 * i).toFixed(2)}`]);
  } else if (spec.type === 'battle') {
    // smoke and fire: crackle + deep rumble + distant chaos
    layers.push(['rumble', `anoisesrc=color=brown:seed=${seed}:duration=${dur}:sample_rate=48000,lowpass=f=140,tremolo=f=0.9:d=0.5,volume=${(0.25 + 0.35 * i).toFixed(2)}`]);
    layers.push(['crackle', `anoisesrc=color=white:seed=${seed + 1}:duration=${dur}:sample_rate=48000,highpass=f=2500,lowpass=f=8000,tremolo=f=7.3:d=0.85,volume=${(0.03 + 0.06 * i).toFixed(3)}`]);
    layers.push(['chaos', `anoisesrc=color=pink:seed=${seed + 2}:duration=${dur}:sample_rate=48000,bandpass=f=700:w=600,tremolo=f=2.2:d=0.6,volume=${(0.06 + 0.14 * i).toFixed(2)}`]);
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
