#!/usr/bin/env node
// DRAMATIS CLI — walking-skeleton pipeline:
//   node bin/dramatis.mjs produce books/<id>/book.json
// Ingest -> Compile -> Cast -> Render -> Mix -> Master, with content-addressed caching.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from '../src/compile.mjs';
import { renderLines } from '../engines/tts/sapi.mjs';
import { mix } from '../src/mix.mjs';
import { ensureDir, log } from '../src/util.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [cmd, bookPath] = process.argv.slice(2);

if (cmd !== 'produce' || !bookPath) {
  console.log('usage: dramatis produce <book.json>');
  process.exit(1);
}

const book = JSON.parse(readFileSync(bookPath, 'utf8'));
const bookDir = path.dirname(path.resolve(bookPath));
const manuscript = path.resolve(bookDir, book.manuscript);
const outDir = ensureDir(path.join(root, 'out', book.id));
const cacheRoot = path.join(root, 'out');

const t0 = Date.now();
log('produce', `book=${book.id} manuscript=${path.basename(manuscript)}`);

const script = compile(book, manuscript);
writeFileSync(path.join(outDir, 'production-script.json'), JSON.stringify(script, null, 2));

const allLines = script.scenes.flatMap((s) => s.lines);
const lineWavs = await renderLines(allLines, book.voices, cacheRoot);

const qa = await mix(script, lineWavs, outDir, cacheRoot);

log('produce', `done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
console.log(JSON.stringify(qa, null, 2));
