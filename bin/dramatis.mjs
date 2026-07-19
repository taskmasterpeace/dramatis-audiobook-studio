#!/usr/bin/env node
// DRAMATIS CLI:
//   node bin/dramatis.mjs produce <book.json> [--chapter N] [--tts kokoro|qwen3|hybrid|elevenlabs|sapi]
//   node bin/dramatis.mjs analyze <manuscript.md> [--book <id>] [--chapter N] [--llm ollama|openrouter]
// Ingest -> Compile -> Cast -> Render -> Mix per chapter, then bind a
// chaptered M4B for the whole book. Content-addressed caching throughout.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from '../src/compile.mjs';
import { mix } from '../src/mix.mjs';
import { ensureDir, ffmpeg, log } from '../src/util.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const cmd = args[0];
const bookPath = args[1];
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};

if (cmd === 'analyze') {
  if (!bookPath) {
    console.log('usage: dramatis analyze <manuscript.md> [--book <id>] [--chapter N|"Heading"] [--llm ollama|openrouter]');
    process.exit(1);
  }
  const manuscriptArg = path.resolve(bookPath);
  const bookId = opt('book', path.basename(manuscriptArg).replace(/\.[^.]+$/, ''));
  const { analyzeChapter } = await import('../src/analyze.mjs');
  await analyzeChapter({
    manuscriptPath: manuscriptArg, bookId,
    chapter: opt('chapter', null), provider: opt('llm', null),
    cacheRoot: path.join(root, 'out'),
  });
  process.exit(0);
}

if (cmd === 'scaffold') {
  // dramatis scaffold --title "X" [--author "Y"] --file manuscript.md [--analyze]
  const title = opt('title', null);
  const file = opt('file', null);
  if (!title || !file) {
    console.log('usage: dramatis scaffold --title "The Story" --file manuscript.md [--author "A. Author"] [--analyze]');
    process.exit(1);
  }
  const { createBook } = await import('../src/scaffold.mjs');
  const result = await createBook(
    { title, author: opt('author', ''), text: readFileSync(path.resolve(file), 'utf8'), analyze: args.includes('--analyze') },
    { root, analyze: args.includes('--analyze') });
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

if (cmd === 'motion') {
  if (!bookPath) {
    console.log('usage: dramatis motion <book.json> --chapter N');
    process.exit(1);
  }
  const book = JSON.parse(readFileSync(bookPath, 'utf8'));
  const n = parseInt(opt('chapter', '1'), 10);
  const chapterCfg = book.chapters[n - 1];
  if (!chapterCfg) throw new Error(`no chapter ${n}`);
  const { motionChapter } = await import('../src/motion.mjs');
  await motionChapter({ book, chapterCfg, n, outRoot: ensureDir(path.join(root, 'out', book.id)) });
  process.exit(0);
}

if (cmd !== 'produce' || !bookPath) {
  console.log('usage: dramatis produce <book.json> [--chapter N] [--tts sapi|kokoro|qwen3|hybrid|elevenlabs]\n' +
    '       dramatis analyze <manuscript.md> [--book <id>] [--chapter N|"Heading"] [--llm ollama|openrouter]');
  process.exit(1);
}

const book = JSON.parse(readFileSync(bookPath, 'utf8'));
const bookDir = path.dirname(path.resolve(bookPath));
const manuscript = path.resolve(bookDir, book.manuscript);
const outRoot = ensureDir(path.join(root, 'out', book.id));
const cacheRoot = path.join(root, 'out');

const ttsName = opt('tts', process.env.DRAMATIS_TTS || 'kokoro');
const { renderLines } = await import(`../engines/tts/${ttsName}.mjs`);
let voices = book.voices[ttsName];
if (!voices) throw new Error(`book.json has no voice map for engine: ${ttsName}`);
// "@name" entries reference another voice map (e.g. hybrid -> kokoro + elevenlabs)
voices = Object.fromEntries(Object.entries(voices).map(([k, v]) =>
  [k, typeof v === 'string' && v.startsWith('@') ? book.voices[v.slice(1)] : v]));
// per-role engine overrides from book.json casting reach the hybrid router
if (book.casting) voices.__casting = book.casting;

// fail fast: a miscast character used to render silently in the narrator's voice
const { validateBook, assertAllRendered } = await import('../src/validate.mjs');
const check = validateBook(book, { tts: ttsName });
for (const w of check.warnings) log('validate', `WARN ${w}`);
if (!check.ok) {
  console.error(`\n[validate] ${book.id} has ${check.errors.length} problem(s):`);
  for (const e of check.errors) console.error(`  - ${e}`);
  console.error('\nfix book.json and re-run (nothing was rendered).\n');
  process.exit(1);
}

const only = opt('chapter', null);
const chapters = only
  ? [book.chapters[parseInt(only, 10) - 1]]
  : book.chapters;

const t0 = Date.now();
log('produce', `book=${book.id} tts=${ttsName} chapters=${chapters.length}`);

const produced = [];
for (let ci = 0; ci < chapters.length; ci++) {
  const chapterCfg = chapters[ci];
  const n = book.chapters.indexOf(chapterCfg) + 1;
  const chOut = ensureDir(path.join(outRoot, `ch-${String(n).padStart(2, '0')}`));
  log('produce', `--- ${chapterCfg.heading} ---`);

  const script = compile(book, chapterCfg, manuscript);
  writeFileSync(path.join(chOut, 'production-script.json'), JSON.stringify(script, null, 2));

  const allLines = script.scenes.flatMap((s) => s.lines);
  const lineWavs = await renderLines(allLines, voices, cacheRoot);
  assertAllRendered(allLines, lineWavs, existsSync); // named failure, not a cryptic ffmpeg exit in mix
  const result = await mix(script, lineWavs, chOut, cacheRoot);
  produced.push({ n, title: script.chapter, ...result });
  log('produce', `${chapterCfg.heading}: ${Math.round(result.durationSec / 60)} min, ` +
    `${result.qa.flaggedLines.length} QA flags, immersive ${result.qa.immersive.integratedLufs} LUFS`);
}

// bind chaptered book masters
if (produced.length > 1) {
  for (const master of ['immersive', 'clean']) {
    const listFile = path.join(outRoot, `concat-${master}.txt`);
    writeFileSync(listFile, produced.map((p) => `file '${p.files[master].replace(/\\/g, '/')}'`).join('\n'));
    const metaLines = [';FFMETADATA1', `title=${book.title} (${master})`, 'album=DRAMATIS render'];
    let pos = 0;
    for (const p of produced) {
      const startMs = Math.round(pos * 1000);
      pos += p.durationSec;
      metaLines.push('[CHAPTER]', 'TIMEBASE=1/1000', `START=${startMs}`, `END=${Math.round(pos * 1000)}`, `title=${p.title}`);
    }
    const metaFile = path.join(outRoot, `chapters-${master}.txt`);
    writeFileSync(metaFile, metaLines.join('\n'));
    const out = path.join(outRoot, `book-${master}.m4b`);
    await ffmpeg(['-f', 'concat', '-safe', '0', '-i', listFile, '-i', metaFile,
      '-map', '0:a', '-map_metadata', '1', '-c', 'copy', out]);
    log('produce', `bound ${out}`);
  }
}

const summary = {
  book: book.title, tts: ttsName,
  chapters: produced.map((p) => ({ n: p.n, title: p.title, min: +(p.durationSec / 60).toFixed(1), qaFlags: p.qa.flaggedLines.length, lufs: p.qa.immersive.integratedLufs })),
  totalMin: +(produced.reduce((a, p) => a + p.durationSec, 0) / 60).toFixed(1),
  elapsedSec: Math.round((Date.now() - t0) / 1000),
};
writeFileSync(path.join(outRoot, 'book-report.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
