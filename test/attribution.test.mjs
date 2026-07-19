// Golden-file tests for the speaker-attribution cascade — the highest-churn,
// least-tested code in the repo (~70 lines of interacting heuristics, revised
// repeatedly, each revision verified by a HAND line-by-line audit).
//
//   node --test test/            run the suite
//   UPDATE_SNAPSHOTS=1 node --test test/    accept intentional changes
//
// Every shipped book is compiled and its {lineId -> entity} map diffed against a
// committed snapshot, so a said-verb tweak that fixes two lines and breaks five
// elsewhere shows its full blast radius in seconds instead of an audiobook listen.
import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compile } from '../src/compile.mjs';
import { castingRecipe } from '../src/casting.mjs';
import { validateBook } from '../src/validate.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SNAP = path.join(root, 'test', 'snapshots');
mkdirSync(SNAP, { recursive: true });
const UPDATE = !!process.env.UPDATE_SNAPSHOTS;

const BOOKS = ['monkeys-paw', 'open-window', 'the-signal-man'];

function snapshot(name, actual) {
  const file = path.join(SNAP, `${name}.json`);
  const text = JSON.stringify(actual, null, 2);
  if (UPDATE || !existsSync(file)) { writeFileSync(file, text); return; }
  const expected = readFileSync(file, 'utf8');
  if (text === expected) return;
  // report the first few differing lines, not a wall of JSON
  const a = JSON.parse(text), b = JSON.parse(expected);
  const diffs = Object.keys({ ...a, ...b }).filter((k) => a[k] !== b[k])
    .slice(0, 12).map((k) => `  ${k}: ${b[k]} -> ${a[k]}`);
  assert.fail(`${name} attribution changed (${diffs.length}+ lines):\n${diffs.join('\n')}\n` +
    `If intended: UPDATE_SNAPSHOTS=1 node --test test/`);
}

for (const id of BOOKS) {
  const bookFile = path.join(root, 'books', id, 'book.json');
  if (!existsSync(bookFile)) continue;
  const book = JSON.parse(readFileSync(bookFile, 'utf8'));
  const manuscript = path.resolve(path.dirname(bookFile), book.manuscript);

  test(`${id}: speaker attribution is stable`, () => {
    const map = {};
    for (const ch of book.chapters) {
      const script = compile(book, ch, manuscript);
      for (const sc of script.scenes) {
        for (const l of sc.lines) if (l.kind === 'dialogue') map[l.id] = l.entity;
      }
    }
    assert.ok(Object.keys(map).length > 0, 'compiled no dialogue lines');
    snapshot(`${id}-attribution`, map);
  });

  test(`${id}: every compiled line lands in exactly one scene`, () => {
    for (const ch of book.chapters) {
      const script = compile(book, ch, manuscript);   // throws on a coverage gap
      const inScenes = script.scenes.reduce((n, s) => n + s.lines.length, 0);
      assert.ok(inScenes > 0, `${ch.heading}: no lines bucketed`);
    }
  });

  test(`${id}: book validates (no silent narrator fallbacks)`, () => {
    const r = validateBook(book, { tts: 'kokoro' });
    assert.deepStrictEqual(r.errors, [], `validation errors: ${r.errors.join('; ')}`);
  });
}

test('casting: gender/age determination on known traps', () => {
  const t = (visual, names = []) => castingRecipe({ id: 'x', visual, names }).determined;
  // compound nouns — "Englishwoman" is one token, \bwoman\b never matched it
  assert.strictEqual(t('White-haired elderly Englishwoman with a shawl.').gender, 'female');
  assert.strictEqual(t('Elderly Englishman around seventy.').gender, 'male');
  assert.strictEqual(t('A gentlewoman of the court.').gender, 'female');
  // alias possessives belong to ANOTHER character and used to flip her male
  assert.strictEqual(t('White-haired elderly Englishwoman.', ['his wife', 'the old woman', 'his mother']).gender, 'female');
  // "middle-aged" contains "aged" and was casting clerks as elderly
  assert.strictEqual(t('Well-dressed nervous middle-aged clerk.').ageBand, 'adult');
  assert.strictEqual(t('An aged woman, frail and white-haired.').ageBand, 'elderly');
  // children and teens must be caught for the high-pitch gate
  assert.strictEqual(t('A little boy about eight years old.').ageBand, 'child');
  assert.strictEqual(t('A very self-possessed young lady of fifteen.').ageBand, 'teen');
  assert.strictEqual(castingRecipe({ id: 'k', visual: 'A little boy of eight.' }).gate.expectChildHighPitch, true);
  // accent routes to the character tier
  assert.match(t('Elderly Chinese man, blind masseur.').accent, /Mandarin/);
  assert.strictEqual(castingRecipe({ id: 'liu', visual: 'Elderly Chinese man.' }).recipe.engine, 'gemini');
});
