// Mix stage: dialog concat -> scene timing -> ambience beds -> SFX cues ->
// sidechain-ducked 4-stem mix -> Immersive + Clean masters.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { ffmpeg, ffprobeDuration, measureLoudness, ensureDir, log } from './util.mjs';
import { renderBed } from '../engines/ambience/procgen.mjs';
import { renderSfx } from '../engines/sfx/procgen.mjs';

const GAP_LINE = 0.45;       // s between segments
const GAP_SCENE = 2.2;       // s at scene boundaries
const BED_LEAD = 1.5;        // ambience starts before first line of scene
const AMB_GAIN_DB = -16;     // bed level under dialog before ducking
const DUCK = 'sidechaincompress=threshold=0.02:ratio=6:attack=180:release=1100:makeup=1';

export async function mix(script, lineWavs, outDir, cacheRoot) {
  ensureDir(outDir);

  // 1) dialog stem: concat lines with gaps, recording each line's start time
  const timeline = [];
  let t = 1.0; // lead-in silence
  const concatEntries = [`file 'silence_lead.wav'`];
  await makeSilence(path.join(outDir, 'silence_lead.wav'), 1.0);
  await makeSilence(path.join(outDir, 'silence_line.wav'), GAP_LINE);
  await makeSilence(path.join(outDir, 'silence_scene.wav'), GAP_SCENE);

  for (let si = 0; si < script.scenes.length; si++) {
    const scene = script.scenes[si];
    scene._start = t;
    for (const line of scene.lines) {
      const wav = lineWavs[line.id];
      const norm = path.join(outDir, `${line.id}.wav`);
      await ffmpeg(['-i', wav, '-ar', '48000', '-ac', '1', norm]);
      const dur = await ffprobeDuration(norm);
      timeline.push({ id: line.id, start: t, dur });
      concatEntries.push(`file '${line.id}.wav'`);
      concatEntries.push(`file 'silence_line.wav'`);
      t += dur + GAP_LINE;
    }
    scene._end = t;
    if (si < script.scenes.length - 1) {
      concatEntries.push(`file 'silence_scene.wav'`);
      t += GAP_SCENE;
    }
  }
  const total = t + 2.0;
  const listFile = path.join(outDir, 'dialog-concat.txt');
  writeFileSync(listFile, concatEntries.join('\n'));
  const dialogStem = path.join(outDir, 'stem-dialog.wav');
  await ffmpeg(['-f', 'concat', '-safe', '0', '-i', listFile, '-ar', '48000', '-ac', '1',
    '-af', `apad=whole_dur=${total.toFixed(2)}`, dialogStem]);
  log('mix', `dialog stem: ${timeline.length} lines, ${fmt(total)} total`);

  // 2) ambience stem: one bed per scene, offset into a full-length track
  const beds = [];
  for (const scene of script.scenes) {
    const start = Math.max(0, scene._start - BED_LEAD);
    const dur = scene._end - start + BED_LEAD;
    const seed = hashSeed(script.book + scene.id);
    const bed = await renderBed(scene.ambience, dur, seed, cacheRoot);
    beds.push({ file: bed, delayMs: Math.round(start * 1000) });
    log('mix', `bed ${scene.id}: ${scene.ambience.type} i=${scene.ambience.intensity} @${fmt(start)} for ${fmt(dur)}`);
  }
  const ambienceStem = path.join(outDir, 'stem-ambience.wav');
  await overlay(beds, total, ambienceStem);

  // 3) sfx stem: cues anchored to line start times
  const lineStart = Object.fromEntries(timeline.map((l) => [l.id, l.start]));
  const shots = [];
  for (const cue of script.cues) {
    const at = lineStart[cue.at_line] + (cue.offset || 0);
    const seed = hashSeed(script.book + cue.id);
    const wav = await renderSfx(cue.sfx, seed, cacheRoot, cue.dur);
    shots.push({ file: wav, delayMs: Math.round(at * 1000), gainDb: cue.gain_db ?? 0 });
    log('mix', `cue ${cue.id} (${cue.sfx}) @${fmt(at)}`);
  }
  const sfxStem = path.join(outDir, 'stem-sfx.wav');
  await overlay(shots, total, sfxStem);

  // 4) masters
  const immersive = path.join(outDir, 'chapter-immersive.m4b');
  await ffmpeg([
    '-i', dialogStem, '-i', ambienceStem, '-i', sfxStem,
    '-filter_complex',
    `[1:a]volume=${AMB_GAIN_DB}dB[ambq];[ambq][0:a]${DUCK}[ducked];` +
    `[0:a][ducked][2:a]amix=inputs=3:duration=first:normalize=0,` +
    `loudnorm=I=-18:TP=-2:LRA=11[out]`,
    '-map', '[out]', '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
    '-metadata', `title=${script.chapter}`, '-metadata', 'album=DRAMATIS render', immersive,
  ]);
  const clean = path.join(outDir, 'chapter-clean.m4b');
  await ffmpeg([
    '-i', dialogStem, '-af', 'loudnorm=I=-19:TP=-3:LRA=9',
    '-c:a', 'aac', '-b:a', '96k', '-ar', '44100',
    '-metadata', `title=${script.chapter} (clean)`, clean,
  ]);

  // 5) mix QA
  const qa = {
    durationSec: Math.round(total),
    lines: timeline.length,
    immersive: { file: immersive, ...(await measureLoudness(immersive)) },
    clean: { file: clean, ...(await measureLoudness(clean)) },
  };
  writeFileSync(path.join(outDir, 'qa-report.json'), JSON.stringify(qa, null, 2));
  return qa;
}

async function makeSilence(out, dur) {
  await ffmpeg(['-f', 'lavfi', '-i', `anullsrc=r=48000:cl=mono:d=${dur}`, out]);
}

// place clips at offsets on a silent canvas of `total` seconds
async function overlay(clips, total, out) {
  if (!clips.length) { await makeSilence(out, total); return; }
  const args = ['-f', 'lavfi', '-i', `anullsrc=r=48000:cl=mono:d=${total.toFixed(2)}`];
  for (const c of clips) args.push('-i', c.file);
  const chains = clips.map((c, i) =>
    `[${i + 1}:a]${c.gainDb ? `volume=${c.gainDb}dB,` : ''}adelay=${c.delayMs}:all=1[d${i}]`);
  const inputs = '[0:a]' + clips.map((_, i) => `[d${i}]`).join('');
  const graph = chains.join(';') + `;${inputs}amix=inputs=${clips.length + 1}:duration=first:normalize=0[out]`;
  args.push('-filter_complex', graph, '-map', '[out]', '-ar', '48000', '-ac', '1', out);
  await ffmpeg(args);
}

function hashSeed(s) {
  let h = 2166136261;
  for (const ch of s) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return Math.abs(h) % 1000000;
}

function fmt(sec) {
  return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
}
