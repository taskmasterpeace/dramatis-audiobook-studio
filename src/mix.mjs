// Mix stage: dialog concat -> scene timing -> ambience beds -> SFX cues ->
// sidechain-ducked 4-stem bus -> premaster on disk -> Immersive + Clean masters.
// The bus stops at the amix; loudness lives entirely in src/master.mjs, because
// a filter that normalizes in one pass is a compressor, not a gain stage.
import { writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { ffmpeg, ffprobeDuration, ensureDir, log, speakable } from './util.mjs';
import { master, IMMERSIVE, CLEAN } from './master.mjs';
import { alignLines } from './align.mjs';
import { renderBeds } from '../engines/ambience/retrieve.mjs';
import { resolveSfx } from '../engines/sfx/retrieve.mjs';
import { renderTrack } from '../engines/music/index.mjs';

const GAP_LINE = 0.45;       // s between segments
const GAP_SCENE = 2.2;       // s at scene boundaries
const BED_LEAD = 1.5;        // ambience starts before first line of scene
const AMB_GAIN_DB = -16;     // bed level under dialog before ducking
const MUS_GAIN_DB = -20;     // music sits lower still; same ducking law as beds
// Robert's ear, 2026-07-28: ruled option 2 ("balanced") out of a four-way A/B
// rendered by scripts/mix-bench.mjs --ear, against the shipped no-duck mix and
// against gentler (trim 0 / ratio 1.5) and firmer (trim -3 / ratio 2) options.
// The trim stays SMALL on purpose: per-cue gain_db in book.json is already set
// by ear (gunshot -7, slam -4), and those rulings were made when this stem had
// no duck at all, so the duck now does the work the trim must not duplicate.
const SFX_GAIN_DB = -2;      // effects trim; see UNDER_DIALOG for the incident
const DUCK = 'sidechaincompress=threshold=0.02:ratio=6:attack=180:release=1100:makeup=1';

// Gentler duck for one-shots. A door slam is SUPPOSED to startle, so it must not
// be flattened into the bed the way ambience and music are; it only has to stop
// short of masking a word. Three parameters differ from DUCK, each measured with
// scripts/mix-bench.mjs on real narration (2026-07-28, dialog RMS -20.7 dBFS):
//   ratio 6 -> 1.5    the depth knob. Reduction is roughly
//                     (1 - 1/ratio) x (dialog dB over threshold), so ratio 1.5
//                     removes a third of the overshoot where ratio 6 removes
//                     5/6. Measured: beds duck 12.2 dB, one-shots 6.3 dB.
//   release 1100 -> 350  measured, and NOT for the reason it looks like. A slam
//                     landing just after a line ends is held down by whatever
//                     the duck has not yet released; the GAP LENGTH turns out to
//                     be irrelevant (a 450 ms line gap and a 2200 ms scene gap
//                     measured identically, both -5.5 dB at release 350). It is
//                     the release constant alone that decides whether that cue
//                     is heard: 1100 -> -7.6 dB, 350 -> -5.5 dB, 150 -> -2.4 dB
//                     relative to dialog RMS. 350 is the compromise -- 150
//                     would let the duck track syllables and make a SUSTAINED
//                     cue (a thunder roll under speech) wobble audibly.
//   attack 180 -> 60  the smallest knob of the three, and it runs BACKWARDS
//                     from the obvious guess: a SLOWER attack lets the slam
//                     through LOUDER (measured, ratio 1.5: 20 ms -> -2.3 dB,
//                     60 -> -1.5, 180 -> -0.6, 400 -> +0.2), because the duck is
//                     still chasing the speech envelope when the transient
//                     arrives. The whole 20-400 ms range spans 2.5 dB, against
//                     the 12 dB that ratio and trim span, so treat it as fine
//                     trim; 60 ms biases the last dB toward protecting the word.
const DUCK_SFX = 'sidechaincompress=threshold=0.02:ratio=1.5:attack=60:release=350:makeup=1';

// Every stem that plays UNDER dialog. Order here is the ffmpeg input order, and
// membership is the whole point: buildImmersiveGraph trims and ducks each entry,
// so a stem cannot reach the mix raw by being forgotten in a hand-written graph.
//
// INCIDENT (2026-07-28, found by audit): the SFX stem was spliced into amix as a
// bare [2:a] -- no trim, no duck -- while ambience and music both got the full
// treatment. Effects are the stem made of loud transients, so it was the one
// stem most able to bury a line, and it was the only one with nothing in its
// way. This violated "dialog is sacred" in the exact place the phrase was
// supposed to be enforced.
//
// MEASURED (scripts/mix-bench.mjs, real narration at -20.7 dBFS RMS): beds
// ducked 12.2 dB and music 11.8 dB under speech, while SFX ducked 0.0 dB. A
// door slam at the book's own -4 dB cue gain peaked 6.9 dB ABOVE the dialog it
// was playing over. That is the top listener complaint about this whole format
// -- "effects drown the dialogue, unusable in a car" -- reproduced on the
// bench. The gate that makes the bare-stem shape unrepresentable is
// test/mix-graph.test.mjs; the bench that puts numbers on any change to these
// profiles is scripts/mix-bench.mjs.
const UNDER_DIALOG = [
  { input: 1, tag: 'amb', gainDb: AMB_GAIN_DB, duck: DUCK },
  { input: 2, tag: 'sfx', gainDb: SFX_GAIN_DB, duck: DUCK_SFX },
  { input: 3, tag: 'mus', gainDb: MUS_GAIN_DB, duck: DUCK },
];

// Input 0 is ALWAYS the dialog stem. It is the only signal that reaches amix
// untouched, and it is the sidechain key for every duck -- that pair of facts
// IS the "dialog is sacred" law, expressed as a graph. The graph ENDS at the
// amix: no loudnorm, no gain. The bus is written to disk as a premaster and
// src/master.mjs measures it before applying a single linear gain, because a
// one-pass loudnorm here would silently compress the dialogue (see master.mjs).
export function buildImmersiveGraph(stems = UNDER_DIALOG) {
  const trims = stems.map((s) => `[${s.input}:a]volume=${s.gainDb}dB[${s.tag}q]`);
  const ducks = stems.map((s) => `[${s.tag}q][0:a]${s.duck}[${s.tag}d]`);
  const into = '[0:a]' + stems.map((s) => `[${s.tag}d]`).join('');
  return `${trims.join(';')};${ducks.join(';')};` +
    `${into}amix=inputs=${stems.length + 1}:duration=first:normalize=0[out]`;
}

export const MIX_PROFILE = { UNDER_DIALOG, DUCK, DUCK_SFX, GAP_LINE };

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

  // 5) masters (per-chapter .m4a; the book binder assembles chaptered .m4b).
  // The 4-stem bus lands on disk UNMASTERED first, because the master stage has
  // to MEASURE what it is about to normalize — see src/master.mjs for why a
  // filter that normalizes in one pass is a compressor, not a gain stage.
  const premaster = path.join(outDir, 'premaster-immersive.wav');
  await ffmpeg([
    // input order must match UNDER_DIALOG[].input: 0 dialog, 1 amb, 2 sfx, 3 mus
    '-i', dialogStem, '-i', ambienceStem, '-i', sfxStem, '-i', musicStem,
    '-filter_complex', buildImmersiveGraph(),
    '-map', '[out]', '-ar', '48000', '-ac', '1', premaster,
  ]);
  const immersive = path.join(outDir, 'immersive.m4a');
  const immersiveMaster = await master(premaster, immersive, IMMERSIVE,
    ['-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-metadata', `title=${script.chapter}`]);
  // the clean master's premaster is the dialog stem itself — already on disk
  const clean = path.join(outDir, 'clean.m4a');
  const cleanMaster = await master(dialogStem, clean, CLEAN,
    ['-c:a', 'aac', '-b:a', '96k', '-ar', '44100', '-metadata', `title=${script.chapter} (clean)`]);

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
    // master() already measured its own output — re-measuring a full chapter
    // twice buys nothing, and a second measurement is a second chance to drift
    immersive: masterQa(immersiveMaster),
    clean: masterQa(cleanMaster),
  };
  writeFileSync(path.join(outDir, 'qa-report.json'), JSON.stringify(qa, null, 2));
  return { qa, files: { immersive, clean }, durationSec: total };
}

// Flatten a master result for the QA report. The measured numbers stay at the
// top level because the CLI summary and the Studio both read
// `qa.immersive.integratedLufs`; the gain and the premaster it was derived
// from go underneath, so a loudness complaint can be traced without a re-render.
function masterQa(m) {
  return {
    file: m.file, ...m.measured,
    master: { gainDb: m.gainDb, peakLimited: m.peakLimited, target: m.target, premaster: m.premaster },
  };
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
