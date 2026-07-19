// Retrieval-first SFX engine. One-shots are fetched from a local CC0 corpus
// by CLAP text-audio similarity (real recordings beat synthesis for common
// sounds); below the similarity threshold the procedural recipes cover the
// gap; unknown free-text specs with weak matches are skipped and reported
// rather than silently playing the wrong sound.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentKey, cached, ffmpeg, pexecFile, pythonExe, log } from '../../src/util.mjs';
import { renderSfx as procgen } from './procgen.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const QUERY_PY = path.join(here, 'clap-query.py');
const INDEX = path.join(root, 'corpus', 'fsd50k', 'index');
const SIM_THRESHOLD = 0.25; // CLAP cosine; below this we do not trust the match

// cues: [{ id, spec, dur, seed }]
// -> { id: { file|null, source: 'retrieval'|'procgen'|'cached'|'skipped', score?, caption?, reason? } }
export async function resolveSfx(cues, cacheRoot) {
  const resolved = {};
  const misses = [];
  for (const c of cues) {
    const key = contentKey(['sfx@2', c.spec.toLowerCase(), String(c.dur || 0)]);
    const { path: out, hit } = cached(cacheRoot, key);
    if (hit) resolved[c.id] = { file: out, source: 'cached' };
    else misses.push({ ...c, out });
  }

  let hits = {};
  if (misses.length && existsSync(path.join(INDEX, 'embeddings.npy'))) {
    const queries = path.join(cacheRoot, 'clap-queries.json');
    const results = path.join(cacheRoot, 'clap-results.json');
    writeFileSync(queries, JSON.stringify(misses.map((m) => ({ id: m.id, text: m.spec, topk: 1 }))));
    try {
      await pexecFile(pythonExe(), [QUERY_PY, INDEX, queries, results], { maxBuffer: 16 * 1024 * 1024 });
      hits = JSON.parse(readFileSync(results, 'utf8'));
    } catch (e) {
      log('sfx', `clap query failed (${String(e.message).slice(0, 120)}) — cues fall back to procgen`);
    }
  }

  for (const m of misses) {
    const top = hits[m.id]?.[0];
    if (top && top.score >= SIM_THRESHOLD) {
      await ffmpeg(['-i', top.file, '-ar', '48000', '-ac', '1', '-t', String(m.dur || 15), m.out]);
      resolved[m.id] = { file: m.out, source: 'retrieval', score: +top.score.toFixed(3), caption: top.caption.slice(0, 80) };
      log('sfx', `retrieved "${m.spec}" <- ${path.basename(top.file)} (sim ${top.score.toFixed(2)})`);
    } else {
      try {
        const p = await procgen(m.spec, m.seed, cacheRoot, m.dur);
        resolved[m.id] = { file: p, source: 'procgen', score: top ? +top.score.toFixed(3) : null };
        if (top) log('sfx', `procgen "${m.spec}" (best sim ${top.score.toFixed(2)} < ${SIM_THRESHOLD})`);
      } catch {
        resolved[m.id] = { file: null, source: 'skipped', reason: 'no procgen recipe and retrieval below threshold' };
        log('sfx', `skipped "${m.spec}" — unknown recipe, retrieval below threshold`);
      }
    }
  }
  return resolved;
}
