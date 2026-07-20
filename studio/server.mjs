#!/usr/bin/env node
// DRAMATIS Studio — local cockpit server. Zero dependencies, localhost only.
//   node studio/server.mjs [--port 4600]
// Filesystem is the database: books/ + out/ are read per request; mutations
// write book.json atomically. Renders spawn bin/dramatis.mjs (one at a time).
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  readFileSync, writeFileSync, renameSync, existsSync, readdirSync, statSync,
  createReadStream, mkdirSync, unlinkSync, rmSync,
} from 'node:fs';
import { compile, chapterConfigHash } from '../src/compile.mjs';
import { loadKeys } from '../src/keys.mjs';
import { ENGINE_IDS, loadRenderer, availableEngines } from '../engines/tts/registry.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(root, 'studio', 'app');
const OUT = path.join(root, 'out');
const BOOKS = path.join(root, 'books');
const PORT = (() => { const i = process.argv.indexOf('--port'); return i > 0 ? +process.argv[i + 1] : 4600; })();

// keys: shared with the CLI so both entry points read the same .env chain
loadKeys();

// ── helpers ─────────────────────────────────────────────────────────────────
const json = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
};
const readBody = (req) => new Promise((resolve, reject) => {
  // 25 MB: voice uploads arrive as base64 JSON, and 30 s of 44.1 kHz stereo wav
  // is ~7 MB of base64. Localhost-only cockpit, so the generous cap is safe.
  let b = ''; req.on('data', (c) => { b += c; if (b.length > 25e6) reject(new Error('body too large')); });
  req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
});
function atomicWriteJson(file, obj) {
  JSON.parse(JSON.stringify(obj)); // must be serializable
  const tmp = file + '.tmp';
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  renameSync(tmp, file);
}
const bookPath = (id) => path.join(BOOKS, id, 'book.json');
function loadBook(id) {
  const p = bookPath(id);
  if (!/^[a-z0-9-]+$/.test(id) || !existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}
const mtime = (p) => (existsSync(p) ? statSync(p).mtimeMs : 0);

// ── book status rollup ──────────────────────────────────────────────────────
function chapterStatus(book) {
  return book.chapters.map((ch, i) => {
    const dir = path.join(OUT, book.id, `ch-${String(i + 1).padStart(2, '0')}`);
    const script = path.join(dir, 'production-script.json');
    const master = path.join(dir, 'immersive.m4a');
    const qaFile = path.join(dir, 'qa-report.json');
    let qa = null;
    if (existsSync(qaFile)) { try { qa = JSON.parse(readFileSync(qaFile, 'utf8')); } catch { /* mid-write */ } }
    return {
      n: i + 1,
      heading: ch.heading,
      compiled: existsSync(script),
      mastered: existsSync(master),
      // precise: only THIS chapter's own config (its scenes/cues + the cast) —
      // whole-book mtime marked every chapter stale when one cue was approved
      stale: existsSync(script) && (() => {
        try {
          const s = JSON.parse(readFileSync(script, 'utf8'));
          return s.configHash ? s.configHash !== chapterConfigHash(book, ch) : mtime(bookPath(book.id)) > mtime(script);
        } catch { return false; }
      })(),
      minutes: qa ? +(qa.durationSec / 60).toFixed(1) : null,
      lufs: qa?.immersive?.integratedLufs ?? null,
      flags: qa ? qa.flaggedLines.length : null,
      flagged: qa?.flaggedLines?.slice(0, 25) || [],   // the detail was read and thrown away
      beds: qa?.beds || [],
      cues: qa?.cues || [],
      cueCount: qa?.cues?.length ?? null,
      media: existsSync(master) ? `/media/${book.id}/ch-${String(i + 1).padStart(2, '0')}/immersive.m4a` : null,
    };
  });
}

function spendRollup(bookId) {
  const ledger = path.join(OUT, bookId, 'llm-ledger.jsonl');
  let llm = 0;
  if (existsSync(ledger)) {
    for (const line of readFileSync(ledger, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { llm += JSON.parse(line).cost_usd || 0; } catch { /* skip */ }
    }
  }
  return { llmUsd: +llm.toFixed(4) };
}

// hero-line estimate straight from the compiler (pure, no side effects).
// Memoized on (book.json mtime + manuscript mtime): this compiles EVERY chapter,
// and it used to re-run on every single page load.
const preflightCache = new Map();
function preflight(book) {
  const manuscriptPath = path.resolve(path.dirname(bookPath(book.id)), book.manuscript);
  const stamp = `${mtime(bookPath(book.id))}:${mtime(manuscriptPath)}`;
  const hit = preflightCache.get(book.id);
  if (hit && hit.stamp === stamp) return hit.value;
  const value = computePreflight(book, manuscriptPath);
  preflightCache.set(book.id, { stamp, value });
  return value;
}
function computePreflight(book, manuscriptArg) {
  const manuscript = manuscriptArg || path.resolve(path.dirname(bookPath(book.id)), book.manuscript);
  let narr = 0, dial = 0, hero = 0, heroChars = 0;
  const perChapter = [];
  for (const ch of book.chapters) {
    try {
      const script = compile(book, ch, manuscript);
      let c = { narration: 0, dialogue: 0, hero: 0, heroChars: 0 };
      for (const sc of script.scenes) for (const l of sc.lines) {
        if (l.kind !== 'dialogue') c.narration++;
        else if (l.emotion) { c.hero++; c.heroChars += l.text.length; }
        else c.dialogue++;
      }
      perChapter.push({ heading: ch.heading, ...c });
      narr += c.narration; dial += c.dialogue; hero += c.hero; heroChars += c.heroChars;
    } catch (e) {
      perChapter.push({ heading: ch.heading, error: String(e.message).slice(0, 120) });
    }
  }
  return {
    narration: narr, dialogue: dial, hero, heroChars,
    heroUsdEstimate: +(heroChars * 0.00022).toFixed(2),
    perChapter,
  };
}

// ── render job (one at a time — one GPU) ────────────────────────────────────
let job = null; // { id, book, chapter, tts, status, startedAt, log: [], child }
const sseClients = new Set();
function sseSend(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(msg);
}
function startRender({ book, chapter, tts }) {
  const args = [path.join(root, 'bin', 'dramatis.mjs'), 'produce', bookPath(book)];
  if (chapter) args.push('--chapter', String(chapter));
  args.push('--tts', tts || 'hybrid');
  const child = spawn(process.execPath, args, { cwd: root, env: process.env });
  job = {
    id: `r${Date.now().toString(36)}`, book, chapter: chapter || null, tts: tts || 'hybrid',
    status: 'running', startedAt: Date.now(), log: [], child,
  };
  // buffer partial chunks: a data event can split mid-line and used to garble
  // the console (and any [n/total] progress marker we parse out of it)
  let carry = '';
  const onLine = (buf) => {
    const parts = (carry + buf.toString()).split('\n');
    carry = parts.pop() ?? '';
    for (const line of parts) {
      if (!line.trim()) continue;
      job.log.push(line);
      if (job.log.length > 500) job.log.shift();
      const m = /(\d+)\s*\/\s*(\d+)/.exec(line);            // "synth 24/59" -> real progress
      if (m && /synth|lines|chunks/i.test(line)) job.progress = { done: +m[1], total: +m[2] };
      sseSend('log', { line });
    }
  };
  child.stdout.on('data', onLine);
  child.stderr.on('data', onLine);
  // without this handler a spawn failure is an uncaught exception that kills the server
  child.on('error', (err) => {
    job.status = 'failed';
    job.error = String(err.message).slice(0, 300);
    job.log.push(`[studio] render failed to start: ${job.error}`);
    sseSend('status', jobPublic());
  });
  child.on('exit', (code, signal) => {
    if (job.status !== 'cancelled') job.status = code === 0 ? 'done' : 'failed';
    job.exitCode = code;
    if (signal) job.log.push(`[studio] render ${job.status} (signal ${signal})`);
    sseSend('status', jobPublic());
  });
  sseSend('status', jobPublic());
  return job;
}
const jobPublic = () => job && {
  id: job.id, book: job.book, chapter: job.chapter, tts: job.tts,
  status: job.status, startedAt: job.startedAt, elapsedSec: Math.round((Date.now() - job.startedAt) / 1000),
  progress: job.progress || null, error: job.error || null,
  tail: job.log.slice(-200),
};

// ── audition: render ONE line for one entity through one engine ─────────────
async function audition({ book: bookId, entity, engine, lineText }) {
  const book = loadBook(bookId);
  if (!book) throw new Error('unknown book');
  if (!ENGINE_IDS.includes(engine)) throw new Error(`unknown engine: ${engine} (known: ${ENGINE_IDS.join(', ')})`);
  let voices = book.voices[engine];
  if (!voices) throw new Error(`book has no ${engine} voice map`);
  // pick the entity's longest dialogue line from any compiled chapter (or caller-supplied text)
  let text = lineText;
  if (!text) {
    let best = '';
    for (let n = 1; n <= book.chapters.length; n++) {
      const p = path.join(OUT, bookId, `ch-${String(n).padStart(2, '0')}`, 'production-script.json');
      if (!existsSync(p)) continue;
      const s = JSON.parse(readFileSync(p, 'utf8'));
      for (const sc of s.scenes) for (const l of sc.lines) {
        const mine = entity === 'narrator' ? l.kind !== 'dialogue' : (l.entity === entity && l.kind === 'dialogue');
        if (mine && l.text.length > best.length && l.text.length < 260) best = l.text;
      }
    }
    text = best || 'The quick brown fox jumps over the lazy dog, and the evening settles quietly over the town.';
  }
  const renderLines = await loadRenderer(engine);
  const line = { id: `aud_${entity}_${engine}`, kind: entity === 'narrator' ? 'narration' : 'dialogue', entity, text };
  const t0 = Date.now();
  const wavs = await renderLines([line], voices, OUT);
  const wav = wavs[line.id];
  if (!wav) throw new Error('engine returned no audio');
  const rel = path.relative(OUT, wav).split(path.sep).join('/');
  return { media: `/media/${rel}`, text, engine, entity, ms: Date.now() - t0, chars: text.length };
}

// ── media with Range support ────────────────────────────────────────────────
function serveMedia(req, res, urlPath) {
  const rel = decodeURIComponent(urlPath.replace(/^\/media\//, ''));
  const file = path.resolve(OUT, rel);
  if (!file.startsWith(OUT) || !existsSync(file) || !statSync(file).isFile()) return json(res, 404, { error: 'not found' });
  const size = statSync(file).size;
  const types = { '.m4a': 'audio/mp4', '.m4b': 'audio/mp4', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json' };
  const type = types[path.extname(file)] || 'application/octet-stream';
  const range = req.headers.range && req.headers.range.match(/bytes=(\d*)-(\d*)/);
  if (range) {
    const start = range[1] ? +range[1] : 0;
    const end = range[2] ? +range[2] : size - 1;
    res.writeHead(206, {
      'Content-Type': type, 'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1,
    });
    createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
    createReadStream(file).pipe(res);
  }
}

// ── static app ──────────────────────────────────────────────────────────────
function serveStatic(res, urlPath) {
  const file = path.resolve(APP, urlPath === '/' ? 'index.html' : '.' + urlPath);
  if (!file.startsWith(APP) || !existsSync(file)) return json(res, 404, { error: 'not found' });
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'text/plain' });
  res.end(readFileSync(file));
}

// ── router ──────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;
  try {
    // media + static
    if (p.startsWith('/media/')) return serveMedia(req, res, p);
    if (p.startsWith('/bookart/')) { // per-character portraits: /bookart/<book>/<file>
      const rel = decodeURIComponent(p.replace(/^\/bookart\//, ''));
      const m2 = /^([a-z0-9-]+)\/([a-z0-9_.-]+)$/.exec(rel);
      const file = m2 ? path.resolve(BOOKS, m2[1], 'art', m2[2]) : '';
      if (!m2 || !file.startsWith(BOOKS) || !existsSync(file)) return json(res, 404, { error: 'not found' });
      const types = { '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' };
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Content-Length': statSync(file).size });
      return createReadStream(file).pipe(res);
    }
    if (p.startsWith('/actors/')) { // company seeds + portraits
      const rel = decodeURIComponent(p.replace(/^\/actors\//, ''));
      const file = path.resolve(root, 'actors', rel);
      if (!file.startsWith(path.join(root, 'actors')) || !existsSync(file)) return json(res, 404, { error: 'not found' });
      const types = { '.wav': 'audio/wav', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.txt': 'text/plain', '.json': 'application/json' };
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Content-Length': statSync(file).size });
      return createReadStream(file).pipe(res);
    }
    if (p.startsWith('/corpus/')) { // read-only library clips for swap auditions
      const rel = decodeURIComponent(p.replace(/^\/corpus\//, ''));
      const file = path.resolve(root, 'corpus', rel);
      if (!file.startsWith(path.join(root, 'corpus')) || !existsSync(file)) return json(res, 404, { error: 'not found' });
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': statSync(file).size, 'Accept-Ranges': 'bytes' });
      return createReadStream(file).pipe(res);
    }
    if (req.method === 'GET' && !p.startsWith('/api/')) return serveStatic(res, p);

    // ---- books ----
    if (req.method === 'GET' && p === '/api/books') {
      const ids = readdirSync(BOOKS).filter((d) => existsSync(bookPath(d)));
      const books = ids.map((id) => {
        const b = loadBook(id);
        const chapters = chapterStatus(b);
        const done = chapters.filter((c) => c.mastered && !c.stale).length;
        const warnings = [];
        if (chapters.some((c) => c.stale)) warnings.push(`${chapters.filter((c) => c.stale).length} chapter(s) stale — book.json changed since render`);
        const manuscript = path.resolve(path.dirname(bookPath(id)), b.manuscript);
        // Does the manuscript actually END mid-sentence? The old check was a
        // substring search for "truncat" anywhere in the PROSE, so a story whose
        // character said "the call was truncated" got flagged — and the warning
        // read "manuscript has a truncation marker", which means nothing to
        // anyone. Look at the real evidence instead: the last line of text not
        // closing with terminal punctuation is what a cut-off paste looks like.
        if (existsSync(manuscript)) {
          // strip HTML comments first: a note ABOUT the manuscript is not the
          // manuscript, and quoting one back at the user explains nothing
          const txt = readFileSync(manuscript, 'utf8').replace(/<!--[\s\S]*?-->/g, '').trimEnd();
          const lastLine = txt.split('\n').filter((l) => l.trim()).pop() || '';
          const endsClean = /[.!?…"'”’)\]]\s*$/.test(lastLine) || /^#{1,6}\s/.test(lastLine.trim());
          if (!endsClean) {
            warnings.push(`the last sentence is unfinished — this manuscript looks cut off: "…${lastLine.trim().slice(-50)}"`);
          }
        }
        return {
          id, title: b.title, author: b.author || '', chapters: chapters.length, done,
          minutes: +chapters.reduce((a, c) => a + (c.minutes || 0), 0).toFixed(1),
          flags: chapters.reduce((a, c) => a + (c.flags || 0), 0),
          spend: spendRollup(id), style: b.style?.name || null, warnings,
        };
      });
      return json(res, 200, { books, job: jobPublic() });
    }
    const bookMatch = p.match(/^\/api\/books\/([a-z0-9-]+)$/);
    if (req.method === 'GET' && bookMatch) {
      const b = loadBook(bookMatch[1]);
      if (!b) return json(res, 404, { error: 'unknown book' });
      // the bound book is the actual deliverable — it existed on disk but nothing linked it
      const bound = {};
      for (const m of ['immersive', 'clean']) {
        const f = path.join(OUT, b.id, `book-${m}.m4b`);
        if (existsSync(f)) bound[m] = { media: `/media/${b.id}/book-${m}.m4b`, mb: +(statSync(f).size / 1048576).toFixed(1) };
      }
      // casting suggestions from the book's own descriptions (src/casting.mjs)
      const { castingRecipe } = await import('../src/casting.mjs');
      const suggestions = {};
      for (const ent of b.entities || []) {
        if (ent.kind === 'narrator') continue;
        try { suggestions[ent.id] = castingRecipe(ent); } catch { /* skip */ }
      }
      const { validateBook } = await import('../src/validate.mjs');
      return json(res, 200, {
        book: b, chapters: chapterStatus(b), preflight: preflight(b), spend: spendRollup(b.id),
        bound, suggestions, validation: validateBook(b),
        keys: availableEngines(),
      });
    }

    // ---- entity edit ----
    const entMatch = p.match(/^\/api\/books\/([a-z0-9-]+)\/entity\/([a-z0-9_]+)$/);
    if (req.method === 'PUT' && entMatch) {
      const [, id, eid] = entMatch;
      const b = loadBook(id);
      if (!b) return json(res, 404, { error: 'unknown book' });
      const body = await readBody(req);
      const ent = b.entities.find((e) => e.id === eid);
      if (!ent) return json(res, 404, { error: 'unknown entity' });
      if (typeof body.visual === 'string') ent.visual = body.visual;
      // role notes: direction for THIS book's performance only — never leaks to
      // other productions (actor-level craft notes live in actors/<name>/notes.md)
      if (typeof body.notes === 'string') { if (body.notes.trim()) ent.notes = body.notes; else delete ent.notes; }
      if (typeof body.actor === 'string') { if (body.actor) ent.actor = body.actor; else delete ent.actor; }
      // the casting sheet: explicit fields Robert fills out — they OVERRIDE all
      // description inference in castingRecipe (gender/age/ethnicity/accent)
      for (const f of ['gender', 'age', 'ethnicity', 'accent']) {
        if (typeof body[f] === 'string') { if (body[f].trim()) ent[f] = body[f].trim(); else delete ent[f]; }
      }
      // per-character portrait (pasted image -> books/<id>/art/<eid>.png)
      if (typeof body.portraitDataUrl === 'string') {
        const pm = /^data:image\/(png|jpe?g|webp);base64,(.+)$/s.exec(body.portraitDataUrl);
        if (!pm) return json(res, 422, { error: 'portrait must be a pasted PNG/JPG/WEBP' });
        const artDir = path.join(BOOKS, id, 'art');
        mkdirSync(artDir, { recursive: true });
        const ext = pm[1] === 'jpeg' ? 'jpg' : pm[1];
        for (const old of ['png', 'jpg', 'webp']) {
          const f = path.join(artDir, `${eid}.${old}`);
          if (existsSync(f)) unlinkSync(f);
        }
        writeFileSync(path.join(artDir, `${eid}.${ext}`), Buffer.from(pm[2], 'base64'));
        ent.portrait = `art/${eid}.${ext}`;
      }
      if (body.voices) for (const [eng, v] of Object.entries(body.voices)) {
        if (typeof b.voices[eng] === 'string') continue; // never clobber an @ref
        if (!b.voices[eng]) { // first edit on a new engine (e.g. gemini) creates its map
          b.voices[eng] = {};
          if (b.voices.hybrid && !b.voices.hybrid[eng]) b.voices.hybrid[eng] = `@${eng}`;
        }
        b.voices[eng][eid] = v;
      }
      if (body.engine !== undefined) { // per-role engine override, consumed by hybrid
        b.casting = b.casting || {};
        if (body.engine) b.casting[eid] = { engine: body.engine, locked: !!body.locked };
        else delete b.casting[eid];
      }
      atomicWriteJson(bookPath(id), b);
      return json(res, 200, { ok: true, entity: ent, casting: b.casting?.[eid] || null });
    }

    // ---- hints ----
    const hintMatch = p.match(/^\/api\/books\/([a-z0-9-]+)\/hints$/);
    if (req.method === 'POST' && hintMatch) {
      const b = loadBook(hintMatch[1]);
      if (!b) return json(res, 404, { error: 'unknown book' });
      const { match, entity, emotion } = await readBody(req);
      if (!match || typeof match !== 'string') return json(res, 422, { error: 'match required' });
      b.hints = b.hints || [];
      const existing = b.hints.findIndex((h) => h.match === match);
      const hint = { match, ...(entity ? { entity } : {}), ...(emotion ? { emotion } : {}) };
      if (existing >= 0) b.hints[existing] = hint; else b.hints.push(hint);
      atomicWriteJson(bookPath(b.id), b);
      return json(res, 200, { ok: true, hint, hints: b.hints.length });
    }

    // ---- cue approval ----
    const cueMatch = p.match(/^\/api\/books\/([a-z0-9-]+)\/cues\/([a-z0-9-]+)$/);
    if (req.method === 'POST' && cueMatch) {
      const b = loadBook(cueMatch[1]);
      if (!b) return json(res, 404, { error: 'unknown book' });
      const { approval } = await readBody(req); // "approved" | "rejected" | {swap: file} | null
      let found = null;
      for (const ch of b.chapters) for (const c of ch.cues || []) if (c.id === cueMatch[2]) found = c;
      if (!found) return json(res, 404, { error: 'unknown cue' });
      if (approval === null) delete found.approval; else found.approval = approval;
      atomicWriteJson(bookPath(b.id), b);
      return json(res, 200, { ok: true, cue: found });
    }

    // ---- create book (paste intake) ----
    if (req.method === 'POST' && p === '/api/books') {
      const body = await readBody(req);
      const { createBook } = await import('../src/scaffold.mjs');
      const result = await createBook(body, { root, analyze: !!body.analyze });
      return json(res, 201, result);
    }

    // ---- render ----
    if (req.method === 'POST' && p === '/api/render') {
      if (job && job.status === 'running') return json(res, 409, { error: 'render busy', job: jobPublic() });
      const body = await readBody(req);
      if (!loadBook(body.book)) return json(res, 404, { error: 'unknown book' });
      startRender(body);
      return json(res, 202, { job: jobPublic() });
    }
    if (req.method === 'GET' && p === '/api/render/status') return json(res, 200, { job: jobPublic() });
    if (req.method === 'POST' && p === '/api/render/cancel') {
      if (!job || job.status !== 'running') return json(res, 409, { error: 'nothing is rendering' });
      job.status = 'cancelled';
      job.log.push('[studio] cancelled by user — cached work is kept, re-running is cheap');
      job.child.kill();
      sseSend('status', jobPublic());
      return json(res, 200, { ok: true, job: jobPublic() });
    }
    if (req.method === 'GET' && p === '/api/render/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('retry: 2000\n\n');
      if (job) res.write(`event: status\ndata: ${JSON.stringify(jobPublic())}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    // ---- quick narrate: text -> mp3, ANY engine, with a persisted history so
    // we learn how long various lengths take per engine (Robert's ask) ----
    // ---- the model report card: static facts + live measurements ----
    if (req.method === 'GET' && p === '/api/models') {
      const { MODEL_FACTS, GRADE_RANK } = await import('../src/model-facts.mjs');
      // live speed from Quick Narrate history (chars/sec per engine, rolling)
      const histFile = path.join(OUT, 'say', 'history.jsonl');
      const live = {};
      if (existsSync(histFile)) {
        const rows = readFileSync(histFile, 'utf8').trim().split('\n').filter(Boolean)
          .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).slice(-80);
        const acc = {};
        for (const r of rows) {
          if (!r.ms || !r.chars) continue;
          (acc[r.engine] ??= []).push({ rate: r.chars / (r.ms / 1000), audioSec: r.audioSec, ms: r.ms });
        }
        for (const [eng, v] of Object.entries(acc)) {
          live[eng] = {
            samples: v.length,
            charsPerSec: +(v.reduce((a, b) => a + b.rate, 0) / v.length).toFixed(1),
          };
        }
      }
      // benchmark artifacts, when the standing batteries have been run
      const bench = {};
      for (const [id, file] of [['clap', 'retrieval-bench-clap.json'], ['glap', 'retrieval-bench-glap.json']]) {
        const f = path.join(OUT, file);
        if (existsSync(f)) {
          try {
            const b = JSON.parse(readFileSync(f, 'utf8'));
            bench[id] = { 'R@1': b['R@1'], 'R@3': b['R@3'], 'R@10': b['R@10'], MRR: b.MRR, classes: b.classes };
          } catch { /* mid-write */ }
        }
      }
      const models = MODEL_FACTS.map((m) => ({
        ...m,
        gradeRank: GRADE_RANK[m.grade] ?? 0,
        live: live[m.id] || null,
        bench: bench[m.id] || null,
      }));
      return json(res, 200, { models, generated: new Date().toISOString() });
    }

    const SAY_HISTORY = path.join(OUT, 'say', 'history.jsonl');
    if (req.method === 'GET' && p === '/api/say/history') {
      const rows = existsSync(SAY_HISTORY)
        ? readFileSync(SAY_HISTORY, 'utf8').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
        : [];
      // rolling chars/sec per engine -> the UI predicts render time before you click
      const rates = {};
      for (const r of rows.slice(-60)) {
        if (!r.ms || !r.chars) continue;
        (rates[r.engine] ??= []).push(r.chars / (r.ms / 1000));
      }
      const speed = Object.fromEntries(Object.entries(rates).map(([e, v]) => [e, +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(1)]));
      return json(res, 200, { history: rows.slice(-40).reverse(), speed });
    }
    if (req.method === 'POST' && p === '/api/say') {
      const { text, engine = 'kokoro', voice, design, prompt } = await readBody(req);
      if (!text || !text.trim()) return json(res, 422, { error: 'text required' });
      if (!ENGINE_IDS.includes(engine)) return json(res, 422, { error: `engine must be one of: ${ENGINE_IDS.join(', ')}` });
      // enforce the registry's declared limits: chunked engines take any length,
      // the rest get a clear refusal instead of a truncation or API error
      const { ENGINES } = await import('../engines/tts/registry.mjs');
      const lim = ENGINES[engine].limits;
      if (lim && !lim.chunked && text.trim().length > lim.perCall) {
        return json(res, 422, {
          error: `${engine} caps at ~${lim.perCall} chars per request (you sent ${text.trim().length}). ` +
            (lim.note || '') + ' Use kokoro or gemini for long text — they chunk automatically.',
        });
      }
      const renderLines = await loadRenderer(engine);
      const voices = {
        kokoro: { narrator: { voice: voice || 'bm_george', speed: 1 } },
        qwen3: { narrator: { design: design || 'Clear natural narrator voice.' } },
        elevenlabs: { narrator: { candidates: [voice || 'Battlerap Algorithm', 'George'], stability: 0.5, style: 0.25 } },
        gemini: { narrator: { voice: voice || 'Charon', prompt: prompt || 'A natural, engaging narrator reading aloud.' } },
      }[engine];
      const t0 = Date.now();
      const wavs = await renderLines([{ id: 'say', kind: 'narration', entity: 'narrator', text: text.trim() }], voices, OUT);
      const ms = Date.now() - t0;
      const rel = path.relative(OUT, wavs.say).split(path.sep).join('/');
      let audioSec = null;
      try {
        const { ffprobeDuration } = await import('../src/util.mjs');
        audioSec = +(await ffprobeDuration(wavs.say)).toFixed(1);
      } catch { /* non-fatal */ }
      const entry = {
        ts: new Date().toISOString(), engine, voice: voice || design?.slice(0, 40) || null,
        chars: text.trim().length, ms, audioSec,
        preview: text.trim().slice(0, 80), media: `/media/${rel}`,
      };
      mkdirSync(path.dirname(SAY_HISTORY), { recursive: true });
      writeFileSync(SAY_HISTORY, (existsSync(SAY_HISTORY) ? readFileSync(SAY_HISTORY, 'utf8') : '') + JSON.stringify(entry) + '\n');
      return json(res, 200, entry);
    }

    // ---- audition ----
    if (req.method === 'POST' && p === '/api/audition') {
      const body = await readBody(req);
      const result = await audition(body);
      return json(res, 200, result);
    }

    // ---- wrap report: joins the files the renderer already writes ----
    const wrapMatch = p.match(/^\/api\/wrap\/([a-z0-9-]+)$/);
    if (req.method === 'GET' && wrapMatch) {
      const b = loadBook(wrapMatch[1]);
      if (!b) return json(res, 404, { error: 'unknown book' });
      const chs = chapterStatus(b).filter((c) => c.mastered);
      const castCount = {};
      let lines = 0, cues = 0, cuesOnWord = 0, flags = 0;
      for (const c of chs) {
        flags += c.flags || 0;
        for (const cue of c.cues || []) { cues++; if ((cue.confidence ?? 0) >= 0.9) cuesOnWord++; }
        const sp = path.join(OUT, b.id, `ch-${String(c.n).padStart(2, '0')}`, 'production-script.json');
        if (!existsSync(sp)) continue;
        try {
          const s = JSON.parse(readFileSync(sp, 'utf8'));
          for (const sc of s.scenes) for (const l of sc.lines) { lines++; castCount[l.entity || 'narrator'] = (castCount[l.entity || 'narrator'] || 0) + 1; }
        } catch { /* mid-write */ }
      }
      const minutes = +chs.reduce((a, c) => a + (c.minutes || 0), 0).toFixed(1);
      // 11L chars this book actually spent (hero lines) + ledgered LLM cost
      const pf = preflight(b);
      const usd = +(spendRollup(b.id).llmUsd + pf.heroChars * 0.00022).toFixed(2);
      return json(res, 200, {
        title: b.title, minutes, chapters: chs.length, lines, cues, cuesOnWord, flags, usd,
        lufs: chs.length ? (chs.reduce((a, c) => a + (c.lufs || 0), 0) / chs.length).toFixed(1) : '—',
        cast: Object.entries(castCount).map(([entity, n]) => ({ entity, lines: n })).sort((a, b2) => b2.lines - a.lines),
      });
    }

    // ---- the company: saved character actors (actors/<name>/) ----
    if (req.method === 'GET' && p === '/api/actors') {
      const dir = path.join(root, 'actors');
      if (!existsSync(dir)) return json(res, 200, { actors: [] });
      const actors = readdirSync(dir).filter((d) => statSync(path.join(dir, d)).isDirectory()).map((name) => {
        const f = (n) => path.join(dir, name, n);
        let origin = {};
        if (existsSync(f('origin.json'))) { try { origin = JSON.parse(readFileSync(f('origin.json'), 'utf8')); } catch { /* ignore */ } }
        const portrait = ['portrait.png', 'portrait.jpg', 'portrait.webp'].find((n) => existsSync(f(n)));
        return {
          name, origin,
          transcript: existsSync(f('transcript.txt')) ? readFileSync(f('transcript.txt'), 'utf8').slice(0, 400) : '',
          // craft notes that travel WITH the actor to every future book
          notes: existsSync(f('notes.md')) ? readFileSync(f('notes.md'), 'utf8') : '',
          seed: existsSync(f('seed.wav')) ? `/actors/${name}/seed.wav` : null,
          portrait: portrait ? `/actors/${name}/${portrait}` : null,
        };
      });
      return json(res, 200, { actors });
    }
    // ---- upload a voice -> a company actor (Robert: "upload a voice into the
    // interface and get whatever I want out of it, and save it if I want") ----
    if (req.method === 'POST' && p === '/api/actors/upload') {
      const { name, dataUrl, transcript, character } = await readBody(req);
      const slug = String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      if (!slug) return json(res, 422, { error: 'give the voice a name first' });
      const dir = path.join(root, 'actors', slug);
      if (existsSync(dir)) return json(res, 409, { error: `"${slug}" already exists in the company — pick another name` });
      const m = /^data:audio\/(wav|x-wav|mpeg|mp3|ogg|webm|mp4|m4a|x-m4a|flac);base64,(.+)$/s.exec(dataUrl || '');
      if (!m) return json(res, 422, { error: 'need an audio file (wav/mp3/ogg/m4a/flac)' });
      const { ffmpeg, ffprobeDuration } = await import('../src/util.mjs');
      mkdirSync(dir, { recursive: true });
      const rawFile = path.join(dir, `upload-raw.${m[1] === 'mpeg' ? 'mp3' : m[1].replace('x-', '')}`);
      writeFileSync(rawFile, Buffer.from(m[2], 'base64'));
      try {
        // seed spec: 24 kHz mono wav, capped at 60 s (clone sweet spot is 8–15 s,
        // but keep more so a representative window can be chosen later — the
        // Chatterbox battery proved the HEAD of a clip is often the wrong slice)
        await ffmpeg(['-y', '-i', rawFile, '-ar', '24000', '-ac', '1', '-t', '60', path.join(dir, 'seed.wav')]);
        const dur = await ffprobeDuration(path.join(dir, 'seed.wav'));
        if (!(dur >= 3)) throw new Error(`clip is ${dur?.toFixed(1) ?? '?'}s — need at least ~3 s of clean speech (8–15 s is the sweet spot)`);
        writeFileSync(path.join(dir, 'transcript.txt'), String(transcript || '').trim());
        writeFileSync(path.join(dir, 'origin.json'), JSON.stringify({
          seed_engine: 'upload', seed_voice: 'user-provided recording',
          character: character || '', created: new Date().toISOString(),
          consent: 'uploader affirmed the right to use this voice (see clone-from-audio.py consent policy)',
          gate: 'none yet — audition before casting',
        }, null, 2));
        writeFileSync(path.join(dir, 'notes.md'), transcript
          ? '' : 'No transcript provided — adding one raises Qwen3 clone similarity ~0.75→0.89.');
        unlinkSync(rawFile);
        const secs = +dur.toFixed(1);
        return json(res, 200, { ok: true, name: slug, seconds: secs });
      } catch (e) {
        // clean up the half-made actor rather than leaving a broken company member
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
        return json(res, 422, { error: `could not read that audio: ${String(e.message).slice(0, 140)}` });
      }
    }

    const notesMatch = p.match(/^\/api\/actors\/([a-z0-9-]+)\/notes$/);
    if (req.method === 'POST' && notesMatch) {
      const dir = path.join(root, 'actors', notesMatch[1]);
      if (!existsSync(dir)) return json(res, 404, { error: 'unknown actor' });
      const { notes } = await readBody(req);
      const file = path.join(dir, 'notes.md');
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, String(notes ?? ''));
      renameSync(tmp, file);
      return json(res, 200, { ok: true });
    }
    const portraitMatch = p.match(/^\/api\/actors\/([a-z0-9-]+)\/portrait$/);
    if (req.method === 'POST' && portraitMatch) {
      const name = portraitMatch[1];
      const dir = path.join(root, 'actors', name);
      if (!existsSync(dir)) return json(res, 404, { error: 'unknown actor' });
      const { dataUrl } = await readBody(req);
      const m = /^data:image\/(png|jpe?g|webp);base64,(.+)$/s.exec(dataUrl || '');
      if (!m) return json(res, 422, { error: 'need a pasted PNG/JPG/WEBP image' });
      const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
      for (const old of ['portrait.png', 'portrait.jpg', 'portrait.webp']) {
        if (existsSync(path.join(dir, old))) unlinkSync(path.join(dir, old));
      }
      writeFileSync(path.join(dir, `portrait.${ext}`), Buffer.from(m[2], 'base64'));
      return json(res, 200, { ok: true, portrait: `/actors/${name}/portrait.${ext}` });
    }

    // ---- casting room: the full talent roster + audition any voice ----
    if (req.method === 'GET' && p === '/api/casting/roster') {
      const { KOKORO_VOICES, GEMINI_VOICES } = await import('../src/voice-tables.mjs');
      let eleven = [];
      try {
        const r = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY || '' } });
        if (r.ok) {
          const seen = new Set();
          eleven = (await r.json()).voices
            .filter((v) => !/^Dynamic Voice \d+$/.test(v.name.trim()))
            .map((v) => ({
              voice: v.name.trim().split(/\s+-\s+/)[0].trim(),
              // the API ships gender/age/accent labels — the filterable truth
              gender: v.labels?.gender || null,
              age: v.labels?.age?.replace(/_/g, ' ') || null,
              accent: v.labels?.accent || null,
              note: [v.labels?.gender, v.labels?.age?.replace(/_/g, ' '), v.labels?.accent].filter(Boolean).join(' · ')
                || v.name.split(/\s+-\s+/)[1]?.trim() || 'custom',
            }))
            .filter((v) => (seen.has(v.voice) ? false : seen.add(v.voice)));
        }
      } catch { /* offline */ }
      return json(res, 200, {
        // best-graded first: the published grade is what separates the ~5
        // audiobook-grade Kokoro voices from the ones that sound rough
        kokoro: KOKORO_VOICES.slice().sort((a, b) => b.score - a.score).map((v) => ({
          voice: v.voice, label: v.name, gender: v.gender, accent: v.accent, grade: v.grade,
          note: `${v.voice} · grade ${v.grade} · ${v.accent}${v.note ? ` — ${v.note}` : ''}`,
        })),
        gemini: GEMINI_VOICES.map((v) => ({
          voice: v.voice, gender: v.gender, age: v.ageSkew || null, character: v.character,
          note: v.note,
        })),
        elevenlabs: eleven,
      });
    }
    if (req.method === 'POST' && p === '/api/casting/audition') {
      const { engine, voice, params, line: lineText } = await readBody(req);
      const LINE = lineText || 'The rain came early that evening, and the city held its breath — this is how the story begins.';
      const maps = {
        kokoro: { narrator: params || { voice, speed: 1.0 } },
        gemini: { narrator: params || { voice, prompt: 'A natural, engaging storyteller reading the opening line of an audiobook.' } },
        elevenlabs: { narrator: params || { candidates: [voice], stability: 0.5, style: 0.25 } },
        qwen3: { narrator: params || { design: voice } },
      };
      if (!maps[engine]) return json(res, 422, { error: `engine must be one of ${Object.keys(maps).join(' | ')}` });
      const renderLines = await loadRenderer(engine);
      const id = `cast_${engine}_${String(voice).replace(/\W+/g, '_').slice(0, 40)}`;
      const line = { id, kind: 'narration', entity: 'narrator', text: LINE };
      const t0 = Date.now();
      const wavs = await renderLines([line], maps[engine], OUT);
      const rel = path.relative(OUT, wavs[line.id]).split(path.sep).join('/');
      return json(res, 200, { media: `/media/${rel}`, engine, voice, ms: Date.now() - t0 });
    }

    if (req.method === 'POST' && p === '/api/casting/design') {
      const char = await readBody(req);
      const { candidateSlate, SEED_LINE } = await import('../src/voicedesign.mjs');
      let elevenlabs = [];
      try {
        const r = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY || '' } });
        if (r.ok) {
          elevenlabs = (await r.json()).voices
            .filter((v) => !/^Dynamic Voice \d+$/.test(v.name.trim()))
            .map((v) => ({
              voice: v.name.trim().split(/\s+-\s+/)[0].trim(),
              gender: v.labels?.gender || null,
              age: v.labels?.age?.replace(/_/g, ' ') || null,
              accent: v.labels?.accent || null,
            }));
        }
      } catch { /* offline: the slate simply won't include an 11L candidate */ }
      const slate = candidateSlate(char, { elevenlabs });
      return json(res, 200, { ...slate, line: SEED_LINE });
    }

    if (req.method === 'POST' && p === '/api/casting/hire') {
      const { name, engine, voice, params, media, character } = await readBody(req);
      const slug = String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      if (!slug) return json(res, 422, { error: 'give them a name first' });
      const dir = path.join(root, 'actors', slug);
      if (existsSync(dir)) return json(res, 409, { error: `"${slug}" is already in the company — pick another name` });
      const rel = String(media || '').replace(/^\/media\//, '');
      const src = path.resolve(OUT, rel);
      if (!src.startsWith(OUT) || !existsSync(src)) return json(res, 422, { error: 'audition clip not found — play the take first' });
      const { SEED_LINE } = await import('../src/voicedesign.mjs');
      const { ffmpeg } = await import('../src/util.mjs');
      mkdirSync(dir, { recursive: true });
      // normalise to 24k mono wav: this clip is a CLONE REFERENCE, and Qwen3
      // cloning wants clean mono >=24kHz (mp3 previews from 11L land here too)
      await ffmpeg(['-y', '-i', src, '-ar', '24000', '-ac', '1', path.join(dir, 'seed.wav')]);
      writeFileSync(path.join(dir, 'transcript.txt'), SEED_LINE);
      writeFileSync(path.join(dir, 'origin.json'), JSON.stringify({
        seed_engine: engine, seed_voice: voice, params: params || null,
        character: character || '', created: new Date().toISOString(),
        gate: 'auditioned + approved by ear',
      }, null, 2));
      writeFileSync(path.join(dir, 'notes.md'), '');
      return json(res, 200, { ok: true, name: slug });
    }

    // ---- cue preview: current clip + top-3 library alternatives for swap ----
    if (req.method === 'POST' && p === '/api/cue-preview') {
      const { book: bookId, cueId } = await readBody(req);
      const b = loadBook(bookId);
      if (!b) return json(res, 404, { error: 'unknown book' });
      let cue = null;
      for (const ch of b.chapters) for (const c of ch.cues || []) if (c.id === cueId) cue = c;
      if (!cue) return json(res, 404, { error: 'unknown cue' });
      const { contentKey, cachePath, pythonExe, pexecFile } = await import('../src/util.mjs');
      // current resolved clip (content-addressed — same key the mixer uses)
      const curKey = contentKey(['sfx@2', cue.sfx.toLowerCase(), String(cue.dur || 0)]);
      const cur = cachePath(OUT, curKey, '.wav');
      // top-3 alternatives from the library (cached per spec)
      const altKey = contentKey(['cue-alts@1', cue.sfx.toLowerCase()]);
      const altCache = cachePath(OUT, altKey, '.json');
      let alts = [];
      if (existsSync(altCache)) alts = JSON.parse(readFileSync(altCache, 'utf8'));
      else {
        const idx = path.join(root, 'corpus', 'fsd50k', 'index');
        if (existsSync(idx)) {
          const q = cachePath(OUT, contentKey(['cue-q', cue.sfx]), '.json');
          writeFileSync(q, JSON.stringify([{ id: 'q', text: cue.sfx, topk: 4 }]));
          const r = q.replace(/\.json$/, '-r.json');
          await pexecFile(pythonExe(), [path.join(root, 'engines', 'sfx', 'clap-query.py'), idx, q, r]);
          alts = (JSON.parse(readFileSync(r, 'utf8')).q || []).map((m) => ({
            file: path.relative(root, m.file).split(path.sep).join('/'),
            caption: (m.caption || '').slice(0, 100), score: +m.score.toFixed(2),
          }));
          writeFileSync(altCache, JSON.stringify(alts));
        }
      }
      return json(res, 200, {
        cue,
        current: existsSync(cur) ? `/media/${path.relative(OUT, cur).split(path.sep).join('/')}` : null,
        alternatives: alts.map((a) => ({ ...a, media: `/corpus/${a.file.replace(/^corpus\//, '')}` })),
      });
    }

    return json(res, 404, { error: 'no route', path: p });
  } catch (e) {
    return json(res, 500, { error: String(e && e.message || e).slice(0, 300) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[studio] DRAMATIS Studio at http://localhost:${PORT} (root ${root})`);
});
