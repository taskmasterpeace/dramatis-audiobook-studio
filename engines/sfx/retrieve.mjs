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

// cues: [{ id, spec, dur, seed, approval? }]
// approval (from book.json, set in the Studio): "rejected" drops the cue,
// { swap: "<corpus wav>" } uses the human-chosen clip, "approved" locks the pick.
// -> { id: { file|null, source: 'retrieval'|'procgen'|'cached'|'swap'|'rejected'|'skipped', score?, caption?, reason? } }
export async function resolveSfx(cues, cacheRoot) {
  const resolved = {};
  const misses = [];
  for (const c of cues) {
    if (c.approval === 'rejected') {
      resolved[c.id] = { file: null, source: 'rejected', reason: 'rejected by user' };
      log('sfx', `cue ${c.id} rejected by user — dropped`);
      continue;
    }
    if (c.approval && typeof c.approval === 'object' && c.approval.swap) {
      const swapSrc = path.resolve(c.approval.swap);
      const key = contentKey(['sfx-swap@1', swapSrc, String(c.dur || 0)]);
      const { path: out, hit } = cached(cacheRoot, key);
      if (!hit) await ffmpeg(['-i', swapSrc, '-ar', '48000', '-ac', '1', '-t', String(c.dur || 15), out]);
      resolved[c.id] = { file: out, source: 'swap', caption: path.basename(swapSrc) };
      log('sfx', `cue ${c.id} using user-swapped clip ${path.basename(swapSrc)}`);
      continue;
    }
    const key = contentKey(['sfx@2', c.spec.toLowerCase(), String(c.dur || 0)]);
    const { path: out, hit } = cached(cacheRoot, key);
    if (hit) resolved[c.id] = { file: out, source: 'cached', approved: c.approval === 'approved' || undefined };
    else misses.push({ ...c, out });
  }

  let hits = {};
  if (misses.length && existsSync(path.join(INDEX, 'embeddings.npy'))) {
    const queries = path.join(cacheRoot, 'clap-queries.json');
    const results = path.join(cacheRoot, 'clap-results.json');
    writeFileSync(queries, JSON.stringify(misses.map((m) => ({ id: m.id, text: m.spec, topk: 3 }))));
    try {
      await pexecFile(pythonExe(), [QUERY_PY, INDEX, queries, results], { maxBuffer: 16 * 1024 * 1024 });
      hits = JSON.parse(readFileSync(results, 'utf8'));
    } catch (e) {
      log('sfx', `clap query failed (${String(e.message).slice(0, 120)}) — cues fall back to procgen`);
    }
  }

  // Never place a clip that is actually human speech/vocals under a non-vocal
  // cue — the cast are the only voices in the mix. (A spec that explicitly asks
  // for vocals bypasses the guard.)
  const VOCAL_CAP = /\b(scream|yell|shout|speech|talk(?:ing)?|voice|whisper|says|sing|choir|vocal|lecture|class(?:room)?|crowd of people speaking)\b/i;
  const VOCAL_SPEC = /\b(voice|yell|shout|scream|speech|talking|whisper|murmur|sing|chant|laugh)\b/i;
  for (const m of misses) {
    const cands = hits[m.id] || [];
    const top = cands.find((c) => VOCAL_SPEC.test(m.spec) || !VOCAL_CAP.test(c.caption || '')) || null;
    if (top && cands[0] && top !== cands[0]) log('sfx', `"${m.spec}": skipped vocal clip "${(cands[0].caption || '').slice(0, 50)}" -> next-best`);
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
