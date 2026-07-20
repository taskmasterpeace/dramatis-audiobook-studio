// Golden-file tests for the speaker-attribution cascade — the highest-churn,
// least-tested code in the repo (~70 lines of interacting heuristics, revised
// repeatedly, each revision verified by a HAND line-by-line audit).
//
//   node --test                  run the suite (default discovery finds test/*)
//   UPDATE_SNAPSHOTS=1 node --test          accept intentional changes
// (the `node --test test/` directory form no longer works on Node 25 — it tries
//  to run the directory itself as a test file and reports one failure)
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
  // a BARE "boy"/"girl" is a child — this read as middle-aged until 2026-07-20
  assert.strictEqual(t('A frightened boy of about nine.').ageBand, 'child');
  assert.strictEqual(t('A girl, barefoot in the yard.').ageBand, 'child');
  // ...but the word must stand alone: compounds are not children
  assert.strictEqual(t('A cowboy in his forties.').ageBand, 'adult');
  assert.strictEqual(t('His girlfriend, a lawyer in her thirties.').ageBand, 'adult');
  // "teenage girl" matches BOTH bands; teen must win or a 15-year-old gets the
  // eight-year-old design ("small bright high-pitched") — an audible miscast
  assert.strictEqual(t('A nervous teenage girl.').ageBand, 'teen');
});

test('voice designer: slate picks the right voice per engine', async () => {
  const { candidateSlate } = await import('../src/voicedesign.mjs');
  const slate = (visual, roster = []) => candidateSlate({ id: 'x', visual }, { elevenlabs: roster });
  const gem = (s) => s.candidates.find((c) => c.engine === 'gemini');

  // texture words must reach Google's published characteristic: Algenib is the
  // ONLY gravelly male, so a gruff dockworker routed to "Informative" would
  // spend the whole book fighting its own preset
  assert.strictEqual(gem(slate('A gruff Irish dockworker, been shouting over machinery for thirty years.')).voice, 'Algenib');
  // age outranks texture: Gacrux is the only aged-reading female and is our
  // ear-approved nola-elder seed — "warm elderly woman" must not land on Sulafat
  assert.strictEqual(gem(slate('An elderly Black woman from New Orleans, warm and slow.')).voice, 'Gacrux');

  // locale is a real accent lever, but our accent directions all end in
  // "...speaking English" — a bare /english/ test sent New Orleans to en-GB
  assert.strictEqual(gem(slate('An elderly Black woman from New Orleans.')).params.language_code, 'en-US');
  assert.strictEqual(gem(slate('A dockworker from Dublin, Irish.')).params.language_code, 'en-GB');

  // the director's note must never carry the header that gets read aloud
  assert.doesNotMatch(gem(slate('A calm narrator.')).params.prompt, /DIRECTOR/);
  assert.match(gem(slate('A calm narrator.')).params.prompt, /Synthesize this performance as speech/);

  // ElevenLabs is matched against the user's OWN roster by its labels
  const withRoster = slate('An elderly woman.', [
    { voice: 'Madison', gender: 'female', age: 'old', accent: 'american' },
    { voice: 'Callum', gender: 'male', age: 'middle aged', accent: 'irish' },
  ]);
  assert.strictEqual(withRoster.candidates.find((c) => c.engine === 'elevenlabs').voice, 'Madison');
  // ...and is simply absent when the roster is empty, never invented
  assert.strictEqual(slate('An elderly woman.').candidates.some((c) => c.engine === 'elevenlabs'), false);
});
