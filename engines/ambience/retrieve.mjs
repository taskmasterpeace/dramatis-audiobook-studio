// Retrieval-first ambience beds: real CC0 recordings from the corpus where the
// CLAP match is strong; seeded procgen synthesis where it isn't. Same query ->
// same source clip every render, so a book's rain always sounds like ITS rain
// (Robert: "consistent ambient sounds where it makes sense").
import path from 'node:path';
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { contentKey, cached, cachePath, ensureDir, ffmpeg, ffprobeDuration, pythonExe, pexecFile, log } from '../../src/util.mjs';
import { renderBed as procgenBed } from './procgen.mjs';

const ENGINE = 'amb-retrieve@1';
const SIM_THRESHOLD = 0.35;   // beds are long-exposure; higher bar than one-shot SFX
const INDEX_DIR = path.resolve('corpus/fsd50k/index');

// ambience type -> what to ask the sound library for
const QUERIES = {
  'rain':             'steady rain falling ambience',
  'roomtone-morning': 'quiet room tone with morning birds outside',
  'room-hum':         'quiet interior room tone low hum',
  'crowd':            'crowd of people murmuring ambience',
  'city-night':       'night wind blowing ambience',
  'lab-cold':         'electrical hum machine room',
  'battle':           'distant explosions battle rumble',
};

// one CLAP query per unique ambience type, cached forever
async function clapLookup(types, cacheRoot) {
  const results = {};
  const misses = [];
  for (const t of types) {
    const key = contentKey(['amb-query@1', QUERIES[t] || t]);
    const p = cachePath(cacheRoot, key, '.json');
    if (existsSync(p)) results[t] = JSON.parse(readFileSync(p, 'utf8'));
    else misses.push({ t, key, p });
  }
  if (misses.length && existsSync(INDEX_DIR)) {
    const qFile = cachePath(cacheRoot, contentKey(['amb-batch', Date.now ? misses.map(m => m.t).join(',') : '']), '.json');
    writeFileSync(qFile, JSON.stringify(misses.map((m) => ({ id: m.t, text: QUERIES[m.t] || m.t, topk: 3 }))));
    const outFile = qFile.replace(/\.json$/, '-res.json');
    await pexecFile(pythonExe(), ['engines/sfx/clap-query.py', INDEX_DIR, qFile, outFile]);
    const res = JSON.parse(readFileSync(outFile, 'utf8'));
    for (const m of misses) {
      // prefer the longest clip among strong matches — beds loop better from length
      const cands = (res[m.t] || []).filter((c) => c.score >= SIM_THRESHOLD);
      for (const c of cands) c.dur = await ffprobeDuration(c.file).catch(() => 0);
      cands.sort((a, b) => (b.dur >= 6 ? b.score : b.score - 0.1) - (a.dur >= 6 ? a.score : a.score - 0.1) || b.dur - a.dur);
      const top = cands.find((c) => c.dur >= 4) || cands[0] || null;
      results[m.t] = top;
      writeFileSync(m.p, JSON.stringify(top));
    }
  }
  return results;
}

// same signature family as procgen.renderBed, but batched per chapter
export async function renderBeds(sceneSpecs, cacheRoot) {
  const types = [...new Set(sceneSpecs.map((s) => s.spec.type))].filter((t) => QUERIES[t]);
  const picks = existsSync(INDEX_DIR) ? await clapLookup(types, cacheRoot) : {};
  const out = [];
  for (const s of sceneSpecs) {
    // scene-level override: ambience {"source":"procgen"} forces the seeded
    // synth bed — the escape hatch when a retrieved recording carries the wrong
    // content (a "city-night" clip that reads as a helicopter, 2026-07-19)
    if (s.spec.source === 'procgen') {
      out.push({ file: await procgenBed(s.spec, s.dur, s.seed, cacheRoot), source: 'procgen-forced' });
      continue;
    }
    const pick = picks[s.spec.type];
    if (pick && pick.file && existsSync(pick.file)) {
      out.push(await loopClip(pick, s.spec, s.dur, cacheRoot, s.id));
    } else {
      out.push({ file: await procgenBed(s.spec, s.dur, s.seed, cacheRoot), source: 'procgen' });
    }
  }
  return out;
}

async function loopClip(pick, spec, durationSec, cacheRoot, sceneId) {
  const dur = Math.ceil(durationSec * 10) / 10;
  const i = spec.intensity ?? 0.5;
  const clipId = path.basename(pick.file, '.wav');
  const key = contentKey([ENGINE, clipId, String(dur), i.toFixed(2)]);
  const { path: outPath, hit } = cached(cacheRoot, key);
  if (hit) return { file: outPath, source: `retrieval:${clipId}`, sim: pick.score };
  const vol = (0.4 + 0.6 * i).toFixed(2);
  const fade = Math.min(1.5, dur / 4).toFixed(2);
  // loop the source clip to length; gentle edge fades hide the seam and the cut
  await ffmpeg([
    '-stream_loop', '-1', '-i', pick.file, '-t', String(dur),
    '-af', `afade=t=in:d=${fade},afade=t=out:st=${Math.max(0, dur - fade)}:d=${fade},volume=${vol},aresample=48000`,
    '-ac', '1', outPath,
  ]);
  log('ambience', `retrieved bed ${sceneId}: ${spec.type} <- ${clipId}.wav (sim ${pick.score.toFixed(2)}, ${Math.round(pick.dur || 0)}s source)`);
  return { file: outPath, source: `retrieval:${clipId}`, sim: pick.score };
}
