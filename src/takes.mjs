// Surgical regeneration: re-render ONE line of a produced chapter as a new
// TAKE, retained beside every previous take. This is the Directors Desktop
// contract (docs in directors-desktop: docs/plans/2026-08-06-production-
// pipeline-manifest-takes.md): DD asks "Scene 14, Maya's third line, with more
// anger"; dramatis renders it through the SAME engines, voices and cache laws
// as produce; nothing is overwritten and the old take never disappears.
//
// Filesystem-is-the-database placement:
//   audio            -> out/cache/ (content-addressed, dedupes across takes)
//   take index       -> out/<book>/ch-NN/takes.json   (derived, atomic writes)
//   chosen take      -> book.json chapters[n].takes   (a DECISION — and because
//                       chapterConfigHash hashes the whole chapter config, a
//                       selection marks the chapter stale exactly like a cue
//                       approval does, and compile threads it into the line)
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { ffprobeDuration } from './util.mjs';
import { levelLine } from './mix.mjs';
import { chapterConfigHash } from './compile.mjs';
import { buildVoices, routeEngine } from './voices-map.mjs';
import { ENGINE_IDS, availableEngines, loadRenderer } from '../engines/tts/registry.mjs';

const chDirName = (n) => `ch-${String(n).padStart(2, '0')}`;

function atomicWriteJson(file, obj) {
  JSON.parse(JSON.stringify(obj)); // must be serializable
  const tmp = file + '.tmp';
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  renameSync(tmp, file);
}

export function takesPath(outRoot, bookId, chapter) {
  return path.join(outRoot, bookId, chDirName(chapter), 'takes.json');
}

export function loadTakes(outRoot, bookId, chapter) {
  const p = takesPath(outRoot, bookId, chapter);
  if (!existsSync(p)) return { configHash: null, lines: {} };
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return { configHash: null, lines: {} }; }
}

function findLine(script, lineId) {
  for (const s of script.scenes) {
    const l = s.lines.find((x) => x.id === lineId);
    if (l) return { line: l, sceneId: s.id };
  }
  return null;
}

/** Which engine performs this take. Explicit ask wins; a director note must
 *  land on an engine that can actually PERFORM it (qwen3 instruct locally for
 *  free, gemini prompt when a key exists) — kokoro cannot be directed and is
 *  deterministic, so a note or re-roll routes away from it rather than
 *  re-rendering identical audio. ElevenLabs accepts re-rolls but not free-text
 *  notes (v3 wants [tags]; prose would be spoken or silently ignored). */
export function chooseTakeEngine({ line, voices, note, engine, available }) {
  if (engine) {
    if (!ENGINE_IDS.includes(engine)) throw new Error(`unknown engine '${engine}'`);
    if (!available[engine]) throw new Error(`engine '${engine}' is not available (missing key?)`);
    if (note && engine === 'kokoro') throw new Error('kokoro cannot perform a director note — pick qwen3 or gemini');
    if (note && engine === 'elevenlabs') throw new Error('elevenlabs takes re-roll but not free-text notes (v3 uses [tags]) — pick qwen3 or gemini for a note');
    return engine;
  }
  const original = routeEngine(line, voices, ENGINE_IDS);
  if (!note) {
    // plain re-roll: same engine unless it is deterministic
    if (original !== 'kokoro') return original;
  }
  // noted take, or re-roll of a deterministic engine: the directed engines,
  // free one first (law 4: premium is routed, not sprayed)
  for (const e of ['qwen3', 'gemini']) if (available[e]) return e;
  throw new Error('no directed engine available for this take (need qwen3 locally or a REPLICATE_API_TOKEN for gemini)');
}

/**
 * Render one line as a new take. Returns the take record (also appended to
 * takes.json). Idempotent by cache key: asking for the same note twice returns
 * the existing record instead of a duplicate.
 */
export async function renderLineTake({ root, bookId, chapter, lineId, note = '', engine = null }) {
  const bookFile = path.join(root, 'books', bookId, 'book.json');
  if (!/^[a-z0-9-]+$/.test(bookId) || !existsSync(bookFile)) throw new Error(`unknown book '${bookId}'`);
  const book = JSON.parse(readFileSync(bookFile, 'utf8'));
  const n = Number(chapter);
  const chapterCfg = book.chapters?.[n - 1];
  if (!chapterCfg) throw new Error(`book '${bookId}' has no chapter ${chapter}`);

  const outRoot = path.join(root, 'out');
  const scriptFile = path.join(outRoot, bookId, chDirName(n), 'production-script.json');
  if (!existsSync(scriptFile)) {
    const err = new Error(`chapter ${n} has not been produced yet — render it first`);
    err.code = 'NOT_PRODUCED';
    throw err;
  }
  const script = JSON.parse(readFileSync(scriptFile, 'utf8'));

  // Line ids are POSITIONAL (lin_0007 is "the 7th line"), so a request against
  // an edited chapter would regenerate the wrong line with full confidence.
  // The sans-takes fingerprint is the guard — take SELECTIONS never move lines,
  // so selecting one must not lock this API out until a full re-produce.
  const currentHash = chapterConfigHash(book, { ...chapterCfg, takes: undefined });
  const scriptHash = script.configHashSansTakes || script.configHash;
  if (scriptHash && scriptHash !== currentHash) {
    const err = new Error('chapter configuration changed since it was produced — re-render before requesting takes');
    err.code = 'STALE';
    throw err;
  }

  const found = findLine(script, lineId);
  if (!found) throw new Error(`line '${lineId}' not found in ${bookId} ch-${n}`);
  const { line } = found;

  // Per-engine voice maps, whatever the book's layout: a hybrid book nests
  // them (buildVoices expands the @refs), a single-engine book keys them at
  // the top. Routing sees them all so voices[engine] presence checks work.
  const engineMaps = {};
  let casting = book.casting || null;
  if (book.voices?.hybrid) {
    const all = buildVoices(book, 'hybrid');
    for (const e of ENGINE_IDS) if (all[e]) engineMaps[e] = all[e];
    if (all.__casting) casting = all.__casting;
  } else {
    for (const e of ENGINE_IDS) if (book.voices?.[e]) engineMaps[e] = buildVoices(book, e);
  }
  const routingView = { ...engineMaps, ...(casting ? { __casting: casting } : {}) };
  const available = availableEngines();
  const cleanNote = String(note || '').trim();
  const eng = chooseTakeEngine({ line, voices: routingView, note: cleanNote, engine, available });
  const engineVoices = engineMaps[eng];
  if (!engineVoices) throw new Error(`book '${bookId}' has no ${eng} voice map — cast it in the Studio first`);

  const store = loadTakes(outRoot, bookId, n);
  const prior = store.lines[lineId] || [];

  // A re-roll (no note, or a note we've already rendered) needs a nonce to
  // reach a new cache key; a FIRST noted take does not (the note itself is in
  // the key). Probe with the real render below — if the key collides with a
  // recorded take, bump `take` and render again with the nonce.
  const render = await loadRenderer(eng);
  const cacheRoot = outRoot;

  const attempt = async (takeNonce) => {
    const meta = {};
    const l = { ...line, note: cleanNote || undefined, take: takeNonce ?? undefined };
    const wavs = await render([l], engineVoices, cacheRoot, meta);
    return { wav: wavs[lineId], meta: meta[lineId] };
  };

  let takeNonce = null;
  let { wav, meta } = await attempt(null);
  const existing = prior.find((t) => t.key === meta.key);
  if (existing) {
    if (!cleanNote) {
      // plain re-roll of an already-recorded key: nonce until the key is new.
      // kokoro is deterministic AND ignores line.take, so a re-roll there can
      // only reproduce the identical file — say so instead of failing weirdly.
      if (eng === 'kokoro') throw new Error('kokoro is deterministic — a re-roll reproduces the same audio; add a note (routes to a directed engine) or pick another engine');
      takeNonce = Math.max(0, ...prior.map((t) => t.take)) + 1;
      ({ wav, meta } = await attempt(takeNonce));
      if (prior.find((t) => t.key === meta.key)) throw new Error('take nonce failed to produce a new key (engine ignores line.take?)');
    } else {
      return { ...existing, existing: true };
    }
  }

  // The take must be a drop-in timeline clip, so it gets the same levelled
  // 48k sibling every produced line has (levelLine is the mix's own leveller).
  const lvl = wav.replace(/\.wav$/, '-lvl48k.wav');
  let lvlOk = true;
  if (!existsSync(lvl)) {
    try { await levelLine(wav, lvl); } catch { lvlOk = false; }
  }
  const dur = await ffprobeDuration(lvlOk ? lvl : wav);

  const record = {
    lineId,
    take: (prior.length ? Math.max(...prior.map((t) => t.take)) : 0) + 1,
    key: meta.key,
    // The key's reproduction inputs, kept SEPARATE from the display ordinal
    // above: nonce is what entered the cache key (null on a first noted take),
    // and produce needs exactly {note, nonce, engine} to cache-hit this take.
    nonce: takeNonce,
    engine: meta.engine,
    voiceKey: meta.voiceKey,
    direction: meta.direction || null,
    note: cleanNote || null,
    text: line.text,
    entity: line.entity,
    wav: path.resolve(wav),
    lvlWav: lvlOk ? path.resolve(lvl) : null,
    dur: +dur.toFixed(2),
    renderedAt: new Date().toISOString(),
    configHash: currentHash,
  };
  store.configHash = currentHash;
  (store.lines[lineId] ??= []).push(record);
  atomicWriteJson(takesPath(outRoot, bookId, n), store);
  return record;
}

/** Record the CHOSEN take on the chapter config (book.json) — a decision, so
 *  it flows into chapterConfigHash: the chapter goes honestly stale and the
 *  next produce threads {note, take} into the line and renders the selection
 *  (cache-hit — the audio already exists). Passing key: null clears it. */
export function selectTake({ root, bookId, chapter, lineId, key }) {
  const bookFile = path.join(root, 'books', bookId, 'book.json');
  if (!/^[a-z0-9-]+$/.test(bookId) || !existsSync(bookFile)) throw new Error(`unknown book '${bookId}'`);
  const book = JSON.parse(readFileSync(bookFile, 'utf8'));
  const n = Number(chapter);
  const chapterCfg = book.chapters?.[n - 1];
  if (!chapterCfg) throw new Error(`book '${bookId}' has no chapter ${chapter}`);

  if (key == null) {
    if (chapterCfg.takes) { delete chapterCfg.takes[lineId]; if (!Object.keys(chapterCfg.takes).length) delete chapterCfg.takes; }
  } else {
    const store = loadTakes(path.join(root, 'out'), bookId, n);
    const rec = (store.lines[lineId] || []).find((t) => t.key === key);
    if (!rec) throw new Error(`no recorded take with key '${key}' for ${lineId}`);
    chapterCfg.takes ??= {};
    // note + nonce + engine reproduce the take's cache key at the next produce
    // (compile threads them into the line; routing honors the engine pin)
    chapterCfg.takes[lineId] = { key: rec.key, note: rec.note, nonce: rec.nonce, engine: rec.engine, take: rec.take };
  }
  atomicWriteJson(bookFile, book);
  return { bookId, chapter: n, lineId, selected: key };
}
