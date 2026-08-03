// Mix stage: levelled dialog concat -> scene timing -> ambience beds -> SFX
// cues -> sidechain-ducked 4-stem mix -> immersive/clean/retail masters
// (src/master.mjs measures and gates each one).
import { writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { ffmpeg, ffprobeDuration, measureLoudness, noiseFloorDb, ensureDir, log, speakable } from './util.mjs';
import { master, acxVerdict, IMMERSIVE, CLEAN, RETAIL } from './master.mjs';
import { alignLines } from './align.mjs';
import { renderBeds } from '../engines/ambience/retrieve.mjs';
import { resolveSfx } from '../engines/sfx/retrieve.mjs';
import { renderTrack } from '../engines/music/index.mjs';

const GAP_LINE = 0.45;       // s between separate sentences
// A dialogue/attribution split ('"Hark at the wind," | said Mr. White.') is ONE
// sentence the compiler had to cut in two so each half could be cast to a
// different voice. It used to get the full GAP_LINE: measured 2026-07-27, 62 of
// 147 gaps in one chapter landed mid-sentence, 66s of a 12-minute runtime spent
// pausing where no reader would. A comma is not a full stop.
const GAP_CLAUSE = 0.12;     // s where the previous line did not end its sentence
const GAP_SCENE = 2.2;       // s at scene boundaries
const BED_LEAD = 1.5;        // ambience starts before first line of scene
const AMB_GAIN_DB = -16;     // bed level under dialog before ducking
const MUS_GAIN_DB = -20;     // music sits lower still; same ducking law as beds
// SFX used to be summed RAW — no gain, no duck — while ambience and music got
// both, so "dialog sacred" was enforced against every stem EXCEPT the loudest
// one. That is the #1 complaint listeners make about produced audio ("every
// emotional beat is drowned out"), and we shipped it as the default.
const SFX_GAIN_DB = -6;
const DUCK = 'sidechaincompress=threshold=0.02:ratio=6:attack=180:release=1100:makeup=1';
// Beds are continuous, so they duck slowly and stay out of the way. A cue is a
// one-shot transient: the same 180ms attack would blunt the very thing that
// makes it read as an event, so cues duck fast and recover fast.
const DUCK_SFX = 'sidechaincompress=threshold=0.03:ratio=4:attack=20:release=350:makeup=1';

// Room tone. Every gap used to be anullsrc — true digital zero — while the TTS
// renders carry their own floor, so the noise floor pumped between roughly -50
// and -inf across a chapter and every boundary was a dropout. ACX also requires
// room tone rather than silence at head and tail, and synthetic zero produces
// audible artefacts at the transitions. Measured 2026-07-27 on this box:
// brown noise through this filter chain sits at -14 dBFS RMS, so -58 dB of
// trim lands it at -73.1 dBFS — continuous, inaudible, and ~13 dB of margin
// under ACX's -60 dB ceiling even after loudnorm's makeup gain.
const ROOM_TONE_DB = -58;
const ROOM_TONE = `highpass=f=40,lowpass=f=2000,volume=${ROOM_TONE_DB}dB`;

// Per-line levelling. Measured across real renders: 12.5 LU / 16.2 dB of spread
// line to line. loudnorm on the master fixes the AVERAGE and leaves that
// completely intact — it is what listeners describe as riding the volume knob,
// and what reviewers hear as "the narrator is much clearer than the cast".
// STATIC GAIN ONLY: a compressor here would flatten the performance, which is
// the one thing the cast is for. Measure, offset, leave the dynamics alone.
const LINE_TARGET_LUFS = -20;
const LINE_MAX_GAIN_DB = 12;      // don't resurrect a near-silent render
const LINE_PEAK_CEILING_DB = -3;  // never push a line's peak past this

// The master targets and their true-peak ceilings live in src/master.mjs, which
// also verifies each rendered master against them and fails the render if one
// misses. The retail ceiling is what makes ACX's "peak less than -3 dB" hold by
// arithmetic rather than a limiter's best effort — loudnorm asked for TP=-3 and
// delivered -2.9 because its limiter overshoots its own target.
//
// NOTE ON THE MEASUREMENT CONVENTION: measureLoudness uses ebur128 WITHOUT
// dualmono, and our files are mono. Verified 2026-07-28 on a real render:
// dualmono=true reads -14.6 LUFS where dualmono=false reads -17.6 — exactly the
// 3.01 dB panlaw. So these LUFS targets are only meaningful against this
// convention. Do not "fix" it in isolation: the targets below were calibrated
// against it and land RMS at -20.6 dBFS, inside ACX's -23..-18 window. Switch
// the convention without re-deriving the targets and the file goes 3 dB quiet
// and fails the RMS floor. The RMS gate is the ground truth; LUFS is the dial.

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
  await makeSilence(path.join(outDir, 'silence_clause.wav'), GAP_CLAUSE);
  await makeSilence(path.join(outDir, 'silence_scene.wav'), GAP_SCENE);
  const gapFile = (name) => path.join(outDir, name).replace(/\\/g, '/');

  const levelled = [];
  for (let si = 0; si < script.scenes.length; si++) {
    const scene = script.scenes[si];
    scene._start = t;
    for (let li = 0; li < scene.lines.length; li++) {
      const line = scene.lines[li];
      const wav = lineWavs[line.id];
      // Levelled 48k copy lives beside the content-addressed render — cached.
      // The suffix is part of the cache key in spirit (law 5): this file used to
      // be '-48k' and held a straight resample. It now holds a LEVELLED
      // resample, so a stale '-48k' would keep promising audio it no longer
      // produces. Renaming it is the bump.
      const norm = wav.replace(/\.wav$/, '-lvl48k.wav');
      if (!existsSync(norm)) levelled.push({ id: line.id, ...(await levelLine(wav, norm)) });
      const dur = await ffprobeDuration(norm);
      timeline.push({ id: line.id, entity: line.entity, start: +t.toFixed(2), dur: +dur.toFixed(2), text: line.text, norm });
      concatEntries.push(`file '${norm.replace(/\\/g, '/')}'`);
      // the gap AFTER this line: short if this line left its sentence unfinished
      // and the next line continues the same paragraph
      const next = scene.lines[li + 1];
      const clause = next && line.para != null && next.para === line.para && !endsSentence(line.text);
      concatEntries.push(`file '${gapFile(clause ? 'silence_clause.wav' : 'silence_line.wav')}'`);
      t += dur + (clause ? GAP_CLAUSE : GAP_LINE);
    }
    scene._end = t;
    if (si < script.scenes.length - 1) {
      concatEntries.push(`file 'silence_scene.wav'`);
      t += GAP_SCENE;
    }
  }
  if (levelled.length) {
    const g = levelled.map((l) => l.gainDb);
    const stuck = levelled.filter((l) => l.clamped);
    log('mix', `levelled ${levelled.length} lines to ${LINE_TARGET_LUFS} LUFS `
      + `(gain ${Math.min(...g).toFixed(1)}..${Math.max(...g).toFixed(1)} dB)`
      + (stuck.length ? ` — WARN ${stuck.length} hit the gain/peak clamp and did NOT reach target: `
        + stuck.slice(0, 5).map((l) => l.id).join(', ') : ''));
  }
  const total = t + 2.0;
  const listFile = path.join(outDir, 'dialog-concat.txt');
  writeFileSync(listFile, concatEntries.join('\n'));
  // One continuous room tone under the WHOLE stem, not a tone clip per gap:
  // a per-gap tone would just move the discontinuity to the edges of each clip.
  // Continuity is the point — there is no seam anywhere to hear.
  const dialogStem = path.join(outDir, 'stem-dialog.wav');
  await ffmpeg([
    '-f', 'concat', '-safe', '0', '-i', listFile,
    '-f', 'lavfi', '-i', `anoisesrc=c=brown:r=48000:d=${total.toFixed(2)}`,
    '-filter_complex',
    `[0:a]apad=whole_dur=${total.toFixed(2)}[dry];[1:a]${ROOM_TONE}[tone];` +
    `[dry][tone]amix=inputs=2:duration=first:normalize=0[out]`,
    '-map', '[out]', '-ar', '48000', '-ac', '1', dialogStem,
  ]);
  log('mix', `dialog stem: ${timeline.length} lines, ${fmt(total)} total, room tone ${ROOM_TONE_DB} dB`);

  // 2) ambience stem: one bed per scene, offset into a full-length track.
  // Retrieval-first (real recordings, consistent per type), procgen fallback — batched
  // so the CLAP model loads once per chapter.
  // A scene with no ambience spec gets NO BED. A continuous bed under everything
  // is the single most-cited complaint listeners make about produced audio
  // ("their need to have one constant sound effect playing in the background at
  // all times... makes the narration harder to hear"), while the praise goes to
  // discrete, event-anchored sound. We shipped the disliked thing as the
  // default. Ambience is opt-in per scene now: something has to ask for it.
  const bedSpecs = script.scenes
    .filter((scene) => scene.ambience?.type && scene.ambience.type !== 'silence')
    .map((scene) => {
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

  // 5) the 4-stem mix, then the masters. The mix is written out UNMASTERED so
  // the master stage can measure a finished programme, which is the only way
  // master() can do its job — and it is the LRA reference the gate compares
  // the finished master against.
  const mixStem = path.join(outDir, 'stem-mix.wav');
  await ffmpeg([
    '-i', dialogStem, '-i', ambienceStem, '-i', sfxStem, '-i', musicStem,
    '-filter_complex',
    `[1:a]volume=${AMB_GAIN_DB}dB[ambq];[2:a]volume=${SFX_GAIN_DB}dB[sfxq];[3:a]volume=${MUS_GAIN_DB}dB[musq];` +
    `[ambq][0:a]${DUCK}[duckedA];[sfxq][0:a]${DUCK_SFX}[duckedS];[musq][0:a]${DUCK}[duckedM];` +
    `[0:a][duckedA][duckedS][duckedM]amix=inputs=4:duration=first:normalize=0[out]`,
    '-map', '[out]', '-ar', '48000', '-ac', '1', mixStem,
  ]);

  const AAC = ['-c:a', 'aac', '-b:a', '128k'];
  const MP3 = ['-c:a', 'libmp3lame', '-b:a', '192k', '-ac', '1'];
  const immersive = path.join(outDir, 'immersive.m4a');
  const clean = path.join(outDir, 'clean.m4a');
  // The retail artifact. Every wide aggregator cloned ACX's spec, which wants
  // MP3 192 kbps CBR at 44.1 kHz one chapter per file — we shipped only AAC, so
  // there was nothing an author could actually submit anywhere (the 96k the
  // clean master used to use was under Google Play's own floor too). It comes
  // off the DIALOGUE stem: a continuous ambience bed makes ACX's -60 dB noise
  // floor impossible by construction, so the immersive mix can never be a
  // retail candidate no matter how good it sounds.
  const retail = path.join(outDir, 'retail.mp3');
  const masters = {
    immersive: await master(mixStem, immersive, IMMERSIVE, AAC, script.chapter),
    clean: await master(dialogStem, clean, CLEAN, AAC, `${script.chapter} (clean)`),
    retail: await master(dialogStem, retail, RETAIL, MP3, script.chapter),
  };

  // 5) read-along timing + per-line QA (dead air / runaway duration)
  const flags = timeline.filter((l) => {
    const wordsPerSec = l.text.split(/\s+/).length / Math.max(l.dur, 0.01);
    return l.dur > 1.5 && (wordsPerSec < 0.6 || wordsPerSec > 6);
  }).map((l) => ({ id: l.id, reason: 'duration-vs-text-mismatch', dur: l.dur }));
  writeFileSync(path.join(outDir, 'timing.json'),
    JSON.stringify({ chapter: script.chapter, lines: timeline }, null, 2));

  // Gate the retail file, not a stem: every threshold is defined on what ships.
  // Law 1 — this is the first audio measurement the mix stage has ever made
  // beyond a duration sanity check. The loudness/peak numbers come from the
  // master stage, which already measured this exact file to verify itself;
  // measuring a 40-minute chapter twice is a second chance to disagree.
  const retailFloor = await noiseFloorDb(retail);
  const acx = acxVerdict(masters.retail.measured, masters.retail.measured.rmsDb, retailFloor);
  log('mix', `retail: ACX thresholds ${acx.pass ? 'met' : `NOT met (${acx.failed.join(', ')})`} — `
    + `rms ${masters.retail.measured.rmsDb} dB, peak ${masters.retail.measured.truePeakDb} dB, `
    + `floor ${retailFloor} dB`);

  const qa = {
    chapter: script.chapter,
    durationSec: Math.round(total),
    lines: timeline.length,
    flaggedLines: flags,
    beds: bedReport,
    cues: cueReport,
    music: musicReport,
    lineLevelling: levelled,
    immersive: masterQa(masters.immersive),
    clean: masterQa(masters.clean),
    retail: { ...masterQa(masters.retail), noiseFloorDb: retailFloor, acx },
  };
  writeFileSync(path.join(outDir, 'qa-report.json'), JSON.stringify(qa, null, 2));
  return { qa, files: { immersive, clean, retail }, durationSec: total };
}

async function makeSilence(out, dur) {
  await ffmpeg(['-f', 'lavfi', '-i', `anullsrc=r=48000:cl=mono:d=${dur}`, out]);
}

// A line finishes its sentence if it ends on terminal punctuation, allowing for
// a closing quote or bracket after it. '"Hark at the wind,"' does not; 'said
// Mr. White.' does. (The 'Mr.' period is mid-string, so the end anchor is what
// makes this safe.)
const SENTENCE_END = /[.!?…]["')”’\]]*\s*$/;
function endsSentence(text) {
  return SENTENCE_END.test(String(text || '').trim());
}

// Level one line onto the common target with STATIC GAIN. Deliberately not
// loudnorm: its dynamic mode would compress the performance, and the whole
// point of casting a line to an actor is the dynamics.
async function levelLine(src, out) {
  const m = await measureLoudness(src);
  let gain = 0;
  // ebur128 gates on ~400 ms blocks with a -70 LUFS absolute floor, so a very
  // short or near-silent render measures as null or absurdly low. Levelling
  // those would just amplify the noise: an unmeasurable line passes through at
  // whatever level it rendered at, exactly as it did before this existed.
  let clamped = false;
  if (Number.isFinite(m.integratedLufs) && m.integratedLufs > -50) {
    const want = LINE_TARGET_LUFS - m.integratedLufs;
    gain = Math.max(-LINE_MAX_GAIN_DB, Math.min(LINE_MAX_GAIN_DB, want));
    if (Number.isFinite(m.truePeakDb)) gain = Math.min(gain, LINE_PEAK_CEILING_DB - m.truePeakDb);
    // A clamped line did NOT reach the target, so it is still an outlier — and
    // a silent near-miss is the failure mode this whole stage exists to end.
    // Say so rather than reporting a levelling that did not happen.
    clamped = Math.abs(gain - want) > 0.05;
  }
  await ffmpeg(['-i', src, '-af', gain ? `volume=${gain.toFixed(2)}dB` : 'anull',
    '-ar', '48000', '-ac', '1', out]);
  return { gainDb: +gain.toFixed(2), clamped };
}

// Flatten a master result for the QA report. The measured numbers stay at the
// top level because the CLI summary and the Studio both read
// `qa.immersive.integratedLufs`; the gain and the premaster it was derived
// from go underneath, so a loudness complaint can be traced without a re-render.
function masterQa(m) {
  return {
    file: m.file, ...m.measured,
    master: {
      gainDb: m.gainDb, peakLimited: m.peakLimited, target: m.target,
      premaster: m.premaster, ...(m.warnings && { warnings: m.warnings }),
    },
  };
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
