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
  createReadStream, mkdirSync,
} from 'node:fs';
import { compile, listChapters } from '../src/compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(root, 'studio', 'app');
const OUT = path.join(root, 'out');
const BOOKS = path.join(root, 'books');
const PORT = (() => { const i = process.argv.indexOf('--port'); return i > 0 ? +process.argv[i + 1] : 4600; })();

// ── keys: load from the known env files at boot (never printed) ─────────────
function loadKeys() {
  const sources = [
    ['D:/git/yourehired/.env', ['ELEVENLABS_API_KEY', 'OPENROUTER_API_KEY']],
    ['D:/git/aiobr/.env', ['MUAPI_API_KEY', 'DP_API_KEY', 'REPLICATE_API_TOKEN', 'GEMINI_API_KEY']],
  ];
  for (const [file, names] of sources) {
    if (!existsSync(file)) continue;
    const txt = readFileSync(file, 'utf8');
    for (const n of names) {
      if (process.env[n]) continue;
      const m = txt.match(new RegExp(`^${n}=(.*)$`, 'm'));
      if (m) process.env[n] = m[1].trim().replace(/\r$/, '');
    }
  }
}
loadKeys();

// ── helpers ─────────────────────────────────────────────────────────────────
const json = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
};
const readBody = (req) => new Promise((resolve, reject) => {
  let b = ''; req.on('data', (c) => { b += c; if (b.length > 5e6) reject(new Error('body too large')); });
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
  const bookMtime = mtime(bookPath(book.id));
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
      stale: existsSync(script) && bookMtime > mtime(script),
      minutes: qa ? +(qa.durationSec / 60).toFixed(1) : null,
      lufs: qa?.immersive?.integratedLufs ?? null,
      flags: qa ? qa.flaggedLines.length : null,
      beds: qa?.beds || [],
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

// hero-line estimate straight from the compiler (pure, no side effects)
function preflight(book) {
  const manuscript = path.resolve(path.dirname(bookPath(book.id)), book.manuscript);
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
  const onLine = (buf) => {
    for (const line of buf.toString().split('\n')) {
      if (!line.trim()) continue;
      job.log.push(line);
      if (job.log.length > 500) job.log.shift();
      sseSend('log', { line });
    }
  };
  child.stdout.on('data', onLine);
  child.stderr.on('data', onLine);
  child.on('exit', (code) => {
    job.status = code === 0 ? 'done' : 'failed';
    job.exitCode = code;
    sseSend('status', jobPublic());
  });
  sseSend('status', jobPublic());
  return job;
}
const jobPublic = () => job && {
  id: job.id, book: job.book, chapter: job.chapter, tts: job.tts,
  status: job.status, startedAt: job.startedAt, elapsedSec: Math.round((Date.now() - job.startedAt) / 1000),
  tail: job.log.slice(-60),
};

// ── audition: render ONE line for one entity through one engine ─────────────
async function audition({ book: bookId, entity, engine, lineText }) {
  const book = loadBook(bookId);
  if (!book) throw new Error('unknown book');
  const engines = { kokoro: '../engines/tts/kokoro.mjs', qwen3: '../engines/tts/qwen3.mjs', elevenlabs: '../engines/tts/elevenlabs.mjs', gemini: '../engines/tts/gemini.mjs' };
  if (!engines[engine]) throw new Error('unknown engine: ' + engine);
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
  const { renderLines } = await import(engines[engine]);
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
        if (existsSync(manuscript) && /truncat/i.test(readFileSync(manuscript, 'utf8'))) warnings.push('manuscript has a truncation marker');
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
      return json(res, 200, { book: b, chapters: chapterStatus(b), preflight: preflight(b), spend: spendRollup(b.id) });
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
    if (req.method === 'GET' && p === '/api/render/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('retry: 2000\n\n');
      if (job) res.write(`event: status\ndata: ${JSON.stringify(jobPublic())}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    // ---- audition ----
    if (req.method === 'POST' && p === '/api/audition') {
      const body = await readBody(req);
      const result = await audition(body);
      return json(res, 200, result);
    }

    // ---- casting room: the full talent roster + audition any voice ----
    if (req.method === 'GET' && p === '/api/casting/roster') {
      const kokoro = ['af_alloy', 'af_aoede', 'af_bella', 'af_heart', 'af_jessica', 'af_kore', 'af_nicole', 'af_nova', 'af_river', 'af_sarah', 'af_sky', 'am_adam', 'am_echo', 'am_eric', 'am_fenrir', 'am_liam', 'am_michael', 'am_onyx', 'am_puck', 'am_santa', 'bf_alice', 'bf_emma', 'bf_isabella', 'bf_lily', 'bm_daniel', 'bm_fable', 'bm_george', 'bm_lewis'];
      const gemini = [['Zephyr', 'F Bright'], ['Puck', 'M Upbeat'], ['Charon', 'M Informative'], ['Kore', 'F Firm'], ['Fenrir', 'M Excitable'], ['Leda', 'F Youthful'], ['Orus', 'M Firm'], ['Aoede', 'F Breezy'], ['Callirrhoe', 'F Easy-going'], ['Autonoe', 'F Bright'], ['Enceladus', 'M Breathy'], ['Iapetus', 'M Clear'], ['Umbriel', 'M Easy-going'], ['Algenib', 'M Gravelly'], ['Despina', 'F Smooth'], ['Erinome', 'F Clear'], ['Laomedeia', 'F Upbeat'], ['Achernar', 'F Soft'], ['Algieba', 'M Smooth'], ['Schedar', 'M Even'], ['Gacrux', 'F Mature'], ['Pulcherrima', 'F Forward'], ['Achird', 'M Friendly'], ['Zubenelgenubi', 'M Casual'], ['Vindemiatrix', 'F Gentle'], ['Sadachbia', 'M Lively'], ['Sadaltager', 'M Knowledgeable'], ['Sulafat', 'F Warm'], ['Alnilam', 'M Firm'], ['Rasalgethi', 'M Informative']];
      let eleven = [];
      try {
        const r = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY || '' } });
        if (r.ok) eleven = (await r.json()).voices
          .map((v) => v.name.trim())
          .filter((n) => !/^Dynamic Voice \d+$/.test(n))
          .map((n) => n.split(/\s+-\s+/)[0].trim());
        eleven = [...new Set(eleven)];
      } catch { /* offline */ }
      return json(res, 200, {
        kokoro: kokoro.map((id) => ({ voice: id, note: (id[0] === 'a' ? 'US' : 'UK') + (id[1] === 'f' ? ' female' : ' male') })),
        gemini: gemini.map(([voice, note]) => ({ voice, note })),
        elevenlabs: eleven.map((voice) => ({ voice, note: 'account roster' })),
        qwen3: [{ voice: '(design your own)', note: 'describe any voice in a sentence — see Cast screen' }],
      });
    }
    if (req.method === 'POST' && p === '/api/casting/audition') {
      const { engine, voice } = await readBody(req);
      const LINE = 'The rain came early that evening, and the city held its breath — this is how the story begins.';
      const maps = {
        kokoro: { narrator: { voice, speed: 1.0 } },
        gemini: { narrator: { voice, prompt: 'A natural, engaging storyteller reading the opening line of an audiobook.' } },
        elevenlabs: { narrator: { candidates: [voice], stability: 0.5, style: 0.25 } },
      };
      if (!maps[engine]) return json(res, 422, { error: 'engine must be kokoro | gemini | elevenlabs' });
      const engines = { kokoro: '../engines/tts/kokoro.mjs', gemini: '../engines/tts/gemini.mjs', elevenlabs: '../engines/tts/elevenlabs.mjs' };
      const { renderLines } = await import(engines[engine]);
      const line = { id: `cast_${engine}_${voice.replace(/\W+/g, '_')}`, kind: 'narration', entity: 'narrator', text: LINE };
      const t0 = Date.now();
      const wavs = await renderLines([line], maps[engine], OUT);
      const rel = path.relative(OUT, wavs[line.id]).split(path.sep).join('/');
      return json(res, 200, { media: `/media/${rel}`, engine, voice, ms: Date.now() - t0 });
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
