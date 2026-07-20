// Mix stage: dialog concat -> scene timing -> ambience beds -> SFX cues ->
// sidechain-ducked 4-stem mix -> Immersive + Clean masters.
import { writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { ffmpeg, ffprobeDuration, measureLoudness, ensureDir, log, speakable } from './util.mjs';
import { alignLines } from './align.mjs';
import { renderBeds } from '../engines/ambience/retrieve.mjs';
import { resolveSfx } from '../engines/sfx/retrieve.mjs';
import { renderTrack } from '../engines/music/index.mjs';

const GAP_LINE = 0.45;       // s between segments
const GAP_SCENE = 2.2;       // s at scene boundaries
const BED_LEAD = 1.5;        // ambience starts before first line of scene
const AMB_GAIN_DB = -16;     // bed level under dialog before ducking
const MUS_GAIN_DB = -20;     // music sits lower still; same ducking law as beds
const DUCK = 'sidechaincompress=threshold=0.02:ratio=6:attack=180:release=1100:makeup=1';

// words that never anchor a sound cue
const STOPWORDS = new Set(('instead,before,after,there,their,about,would,could,should,then,than,when,while,' +
  'with,from,this,that,these,those,them,they,what,where,which,whose,into,onto,upon').split(','));

// Place a cue at the onset of its anchor word + 100 ms (film-sync convention:
// a transient slightly after the word reads as simultaneous). Falls back to
// line start + manual offset. Confidence blends: word-anchor hit, alignment
// coverage, and sound-source quality (CLAP sim / deterministic recipe).
function placeCue(cue, line, words, lastCueAt, r) {
  let at = line.start + (cue.offset || 0);
  let method = 'line-fallback';
  let wordMatched = false;
  if (words.length && cue.anchor) {
    const cand = cue.anchor.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
      .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
    const target = cand[0] || cue.anchor.toLowerCase().split(/\s+/).at(-1);
    if (target) {
      const hit = words.find((w) => {
        const ww = w.word.toLowerCase().replace(/[^a-z0-9]/g, '');
        return ww && (ww.startsWith(target.slice(0, 5)) || target.startsWith(ww.slice(0, 5)));
      });
      if (hit) { at = line.start + hit.start + 0.1; method = 'word-align'; wordMatched = true; }
    }
  }
  if (at < lastCueAt + 0.5) at = lastCueAt + 0.5; // one-shot separation
  at = Math.min(at, line.start + line.dur + 0.3);
  const coverage = words.length ? Math.min(1, words.length / Math.max(1, line.text.split(/\s+/).length)) : 0;
  const retrieval01 = r.source === 'retrieval' ? Math.min(1, (r.score || 0) / 0.35)
    : r.source === 'procgen' ? 0.5 : 0.8;
  const confidence = +(0.4 * (wordMatched ? 1 : 0) + 0.3 * coverage + 0.3 * retrieval01).toFixed(2);
  return { at, method, wordMatched, confidence };
}

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
      // normalized 48k copy lives beside the content-addressed render — cached
      const norm = wav.replace(/\.wav$/, '-48k.wav');
      if (!existsSync(norm)) await ffmpeg(['-i', wav, '-ar', '48000', '-ac', '1', norm]);
      const dur = await ffprobeDuration(norm);
      timeline.push({ id: line.id, entity: line.entity, start: +t.toFixed(2), dur: +dur.toFixed(2), text: line.text, norm });
      concatEntries.push(`file '${norm.replace(/\\/g, '/')}'`);
      concatEntries.push(`file '${path.join(outDir, 'silence_line.wav').replace(/\\/g, '/')}'`);
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

  // 2) ambience stem: one bed per scene, offset into a full-length track.
  // Retrieval-first (real recordings, consistent per type), procgen fallback — batched
  // so the CLAP model loads once per chapter.
  const bedSpecs = script.scenes.map((scene) => {
    const start = Math.max(0, scene._start - BED_LEAD);
    return {
      id: scene.id, spec: scene.ambience, start,
      dur: scene._end - start + BED_LEAD,
      seed: hashSeed(script.book + scene.id),
    };
  });
  const bedFiles = await renderBeds(bedSpecs, cacheRoot);
  const beds = [];
  const bedReport = [];
  bedSpecs.forEach((b, idx) => {
    beds.push({ file: bedFiles[idx].file, delayMs: Math.round(b.start * 1000) });
    bedReport.push({ id: b.id, type: b.spec.type, source: bedFiles[idx].source, sim: bedFiles[idx].sim });
    log('mix', `bed ${b.id}: ${b.spec.type} i=${b.spec.intensity} @${fmt(b.start)} for ${fmt(b.dur)} [${bedFiles[idx].source || 'procgen'}]`);
  });
  const ambienceStem = path.join(outDir, 'stem-ambience.wav');
  await overlay(beds, total, ambienceStem);

  // 3) sfx stem: retrieval-first sounds, placed at aligned word onsets
  const normById = Object.fromEntries(timeline.map((l) => [l.id, l.norm]));
  // hand the aligner the SAME normalized text the audio was synthesized from —
  // it used to get the raw line, so em-dashes/ellipses made it align against
  // words that were never spoken, quietly degrading every cue's word onset
  const alignment = script.cues.length
    ? await alignLines(timeline.map((l) => ({ id: l.id, text: speakable(l.text) })), normById, cacheRoot)
    : {};
  const resolved = await resolveSfx(
    script.cues.map((c) => ({ id: c.id, spec: c.sfx, dur: c.dur, seed: hashSeed(script.book + c.id), approval: c.approval })),
    cacheRoot);
  const cueReport = [];
  const shots = [];
  let lastCueAt = -Infinity;
  for (const cue of script.cues) {
    const r = resolved[cue.id];
    if (!r?.file) {
      cueReport.push({ id: cue.id, sfx: cue.sfx, skipped: r?.reason || 'unresolved' });
      continue;
    }
    const line = timeline.find((l) => l.id === cue.at_line);
    if (!line) { // anchored to a line that never made it into the mix
      cueReport.push({ id: cue.id, spec: cue.sfx, skipped: `anchor line ${cue.at_line} not in timeline` });
      log('mix', `cue ${cue.id} skipped: anchor line not in the rendered timeline`);
      continue;
    }
    const p = placeCue(cue, line, alignment[line.id] || [], lastCueAt, r);
    lastCueAt = p.at;
    shots.push({ file: r.file, delayMs: Math.round(p.at * 1000), gainDb: cue.gain_db ?? 0 });
    cueReport.push({
      id: cue.id, sfx: cue.sfx, at: +p.at.toFixed(2), method: p.method, confidence: p.confidence,
      source: r.source, ...(r.score != null && { sim: r.score }), ...(r.caption && { caption: r.caption }),
    });
    log('mix', `cue ${cue.id} (${cue.sfx}) @${fmt(p.at)} [${r.source}/${p.method} conf=${p.confidence}]`);
  }
  const sfxStem = path.join(outDir, 'stem-sfx.wav');
  await overlay(shots, total, sfxStem);

  // 4) music stem: chapter cues/beds on their own stem, ducked like ambience
  const musicReport = [];
  const musicShots = [];
  for (const mc of script.music || []) {
    const line = timeline.find((l) => l.id === mc.at_line);
    const at = line.start + (mc.offset || 0);
    try {
      const t = await renderTrack(mc.spec, mc.dur, cacheRoot);
      musicShots.push({ file: t.file, delayMs: Math.round(at * 1000), gainDb: mc.gain_db ?? 0 });
      musicReport.push({ id: mc.id, spec: mc.spec, at: +at.toFixed(2), engine: t.engine, license: t.license });
      log('mix', `music ${mc.id} @${fmt(at)} (${t.engine})`);
    } catch (e) {
      musicReport.push({ id: mc.id, spec: mc.spec, skipped: String(e.message).slice(0, 140) });
      log('mix', `music ${mc.id} skipped: ${String(e.message).slice(0, 140)}`);
    }
  }
  const musicStem = path.join(outDir, 'stem-music.wav');
  await overlay(musicShots, total, musicStem);

  // 5) masters (per-chapter .m4a; the book binder assembles chaptered .m4b)
  const immersive = path.join(outDir, 'immersive.m4a');
  await ffmpeg([
    '-i', dialogStem, '-i', ambienceStem, '-i', sfxStem, '-i', musicStem,
    '-filter_complex',
    `[1:a]volume=${AMB_GAIN_DB}dB[ambq];[3:a]volume=${MUS_GAIN_DB}dB[musq];` +
    `[ambq][0:a]${DUCK}[duckedA];[musq][0:a]${DUCK}[duckedM];` +
    `[0:a][duckedA][2:a][duckedM]amix=inputs=4:duration=first:normalize=0,` +
    `loudnorm=I=-18:TP=-2:LRA=11[out]`,
    '-map', '[out]', '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
    '-metadata', `title=${script.chapter}`, immersive,
  ]);
  const clean = path.join(outDir, 'clean.m4a');
  await ffmpeg([
    '-i', dialogStem, '-af', 'loudnorm=I=-19:TP=-3:LRA=9',
    '-c:a', 'aac', '-b:a', '96k', '-ar', '44100',
    '-metadata', `title=${script.chapter} (clean)`, clean,
  ]);

  // 5) read-along timing + per-line QA (dead air / runaway duration)
  const flags = timeline.filter((l) => {
    const wordsPerSec = l.text.split(/\s+/).length / Math.max(l.dur, 0.01);
    return l.dur > 1.5 && (wordsPerSec < 0.6 || wordsPerSec > 6);
  }).map((l) => ({ id: l.id, reason: 'duration-vs-text-mismatch', dur: l.dur }));
  writeFileSync(path.join(outDir, 'timing.json'),
    JSON.stringify({ chapter: script.chapter, lines: timeline }, null, 2));

  const qa = {
    chapter: script.chapter,
    durationSec: Math.round(total),
    lines: timeline.length,
    flaggedLines: flags,
    beds: bedReport,
    cues: cueReport,
    music: musicReport,
    immersive: { file: immersive, ...(await measureLoudness(immersive)) },
    clean: { file: clean, ...(await measureLoudness(clean)) },
  };
  writeFileSync(path.join(outDir, 'qa-report.json'), JSON.stringify(qa, null, 2));
  return { qa, files: { immersive, clean }, durationSec: total };
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
