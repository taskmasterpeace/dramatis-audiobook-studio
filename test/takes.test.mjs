// Surgical regeneration: one line becomes a new TAKE, the old one survives,
// and the chosen take is a book.json decision that produce re-renders.
// Hermetic: a synthetic book compiled by the REAL compiler, cache pre-seeded
// with real (tiny) wavs so no python/GPU/network runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { compile, chapterConfigHash } from '../src/compile.mjs';
import { contentKey, speakable, ffmpeg } from '../src/util.mjs';
import { chooseTakeEngine, loadTakes, renderLineTake, selectTake } from '../src/takes.mjs';

const ROOT = path.join(tmpdir(), 'ams-takes-test');
const BOOK_DIR = path.join(ROOT, 'books', 'take-book');
const MANUSCRIPT = path.join(BOOK_DIR, 'manuscript.md');
const CACHE = path.join(ROOT, 'out', 'cache');
const CH_OUT = path.join(ROOT, 'out', 'take-book', 'ch-01');

const P1 = 'The night was cold and wet.';
const P2 = 'The fire burned brightly in the small parlour.';

const BOOK = {
  id: 'take-book',
  title: 'Take Book',
  manuscript: 'manuscript.md',
  entities: [{ id: 'narrator', kind: 'narrator', names: [] }],
  chapters: [{ heading: 'Chapter One', scenes: [{ id: 'sc-1', anchor: 'The night was cold', ambience: null }] }],
  voices: {
    kokoro: { narrator: { voice: 'am_michael', speed: 1 } },
    qwen3: { narrator: { design: 'a calm narrator' } },
  },
};

function writeBook(book) {
  writeFileSync(path.join(BOOK_DIR, 'book.json'), JSON.stringify(book, null, 2));
}

async function seedWav(key) {
  const f = path.join(CACHE, `${key}.wav`);
  await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=1000:duration=0.5',
    '-af', 'volume=-20dB', '-ar', '24000', '-ac', '1', f]);
  return f;
}

let script;

test.before(async () => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(BOOK_DIR, { recursive: true });
  mkdirSync(CACHE, { recursive: true });
  mkdirSync(CH_OUT, { recursive: true });
  writeFileSync(MANUSCRIPT, `## Chapter One\n\n${P1}\n\n${P2}\n`);
  writeBook(BOOK);
  script = compile(BOOK, BOOK.chapters[0], MANUSCRIPT);
  writeFileSync(path.join(CH_OUT, 'production-script.json'), JSON.stringify(script, null, 2));
  // seed the caches the takes below will hit
  await seedWav(contentKey(['kokoro-onnx@2', 'am_michael', '1', speakable(P1)]));
  await seedWav(contentKey(['qwen3-tts@1', 'a calm narrator', 'Read it with dread.', speakable(P1)]));
});
test.after(() => rmSync(ROOT, { recursive: true, force: true }));

test('chooseTakeEngine: notes route to a directed engine, never kokoro or elevenlabs', () => {
  const voices = { kokoro: {}, qwen3: {}, elevenlabs: {} };
  const available = { kokoro: true, qwen3: true, elevenlabs: true, gemini: false };
  const narration = { entity: 'narrator', kind: 'narration' };
  // plain re-roll of narration (kokoro-routed, deterministic) -> directed engine
  assert.equal(chooseTakeEngine({ line: narration, voices, note: '', engine: null, available }), 'qwen3');
  // a note also goes to the free directed engine first
  assert.equal(chooseTakeEngine({ line: narration, voices, note: 'angrier', engine: null, available }), 'qwen3');
  // explicit kokoro + note is a refusal, not a silent no-op
  assert.throws(() => chooseTakeEngine({ line: narration, voices, note: 'angrier', engine: 'kokoro', available }), /cannot perform/);
  // explicit elevenlabs + note is a refusal too (v3 tags, not prose)
  assert.throws(() => chooseTakeEngine({ line: narration, voices, note: 'angrier', engine: 'elevenlabs', available }), /not free-text/);
  // emotive dialogue re-rolls on its own engine
  const emotive = { entity: 'a', kind: 'dialogue', emotion: { anger: 0.8 } };
  assert.equal(chooseTakeEngine({ line: emotive, voices, note: '', engine: null, available }), 'elevenlabs');
});

test('first take renders (cache-hit), levels, and lands in takes.json', async () => {
  const rec = await renderLineTake({ root: ROOT, bookId: 'take-book', chapter: 1, lineId: 'lin_0001', engine: 'kokoro' });
  assert.equal(rec.take, 1);
  assert.equal(rec.engine, 'kokoro');
  assert.equal(rec.entity, 'narrator');
  assert.equal(rec.nonce, null);
  assert.ok(rec.dur > 0.3, `real duration expected, got ${rec.dur}`);
  assert.ok(rec.lvlWav && existsSync(rec.lvlWav), 'levelled sibling must exist — takes are drop-in timeline clips');
  const store = loadTakes(path.join(ROOT, 'out'), 'take-book', 1);
  assert.equal(store.lines.lin_0001.length, 1);
});

test('kokoro re-roll refuses honestly — deterministic engines cannot re-roll', async () => {
  await assert.rejects(
    renderLineTake({ root: ROOT, bookId: 'take-book', chapter: 1, lineId: 'lin_0001', engine: 'kokoro' }),
    /deterministic/);
});

test('a noted take routes to qwen3, records the direction, and dedupes by key', async () => {
  const rec = await renderLineTake({ root: ROOT, bookId: 'take-book', chapter: 1, lineId: 'lin_0001', note: 'Read it with dread.' });
  assert.equal(rec.engine, 'qwen3');
  assert.equal(rec.take, 2);
  assert.equal(rec.direction, 'Read it with dread.');
  assert.equal(rec.note, 'Read it with dread.');
  // same note again: the existing record comes back, no duplicate
  const again = await renderLineTake({ root: ROOT, bookId: 'take-book', chapter: 1, lineId: 'lin_0001', note: 'Read it with dread.' });
  assert.equal(again.existing, true);
  assert.equal(again.key, rec.key);
  assert.equal(loadTakes(path.join(ROOT, 'out'), 'take-book', 1).lines.lin_0001.length, 2);
});

test('selecting a take is a book.json decision produce can reproduce', () => {
  const store = loadTakes(path.join(ROOT, 'out'), 'take-book', 1);
  const noted = store.lines.lin_0001.find((t) => t.note);
  const before = JSON.parse(readFileSync(path.join(BOOK_DIR, 'book.json'), 'utf8'));
  const sansBefore = chapterConfigHash(before, { ...before.chapters[0], takes: undefined });

  selectTake({ root: ROOT, bookId: 'take-book', chapter: 1, lineId: 'lin_0001', key: noted.key });

  const after = JSON.parse(readFileSync(path.join(BOOK_DIR, 'book.json'), 'utf8'));
  const sel = after.chapters[0].takes.lin_0001;
  assert.deepEqual({ note: sel.note, engine: sel.engine, nonce: sel.nonce }, { note: 'Read it with dread.', engine: 'qwen3', nonce: null });

  // the selection marks the chapter stale (full hash moves)…
  assert.notEqual(chapterConfigHash(after, after.chapters[0]), chapterConfigHash(before, before.chapters[0]));
  // …but never locks the takes API out (sans-takes hash is unmoved)
  assert.equal(chapterConfigHash(after, { ...after.chapters[0], takes: undefined }), sansBefore);

  // compile threads the selection into the line: note + engine pin reproduce
  // the take's exact cache key at the next produce
  const script2 = compile(after, after.chapters[0], MANUSCRIPT);
  const line = script2.scenes[0].lines.find((l) => l.id === 'lin_0001');
  assert.equal(line.note, 'Read it with dread.');
  assert.equal(line.takeEngine, 'qwen3');
  assert.equal(contentKey(['qwen3-tts@1', 'a calm narrator', 'Read it with dread.', speakable(line.text)]), noted.key);

  // clearing restores the original
  selectTake({ root: ROOT, bookId: 'take-book', chapter: 1, lineId: 'lin_0001', key: null });
  const cleared = JSON.parse(readFileSync(path.join(BOOK_DIR, 'book.json'), 'utf8'));
  assert.equal(cleared.chapters[0].takes, undefined);
});

test('a changed chapter refuses take requests — line ids are positional', async () => {
  const mutated = JSON.parse(JSON.stringify(BOOK));
  mutated.hints = [{ match: 'The night', entity: 'narrator', emotion: { fear: 0.9 } }];
  writeBook(mutated);
  await assert.rejects(
    renderLineTake({ root: ROOT, bookId: 'take-book', chapter: 1, lineId: 'lin_0001', engine: 'kokoro' }),
    (e) => e.code === 'STALE');
  writeBook(BOOK); // restore
});
