// Regression test for law 2 — "nothing under narration may sing or speak
// except the cast" — after the 2026-07-27 audit found the guard leaking.
//
// THE INCIDENT: the founding defect of this project was a retrieved clip of a
// teacher yelling at a class playing under narration. The fix landed in the
// ANALYZER (src/scaffold.mjs) and never reached the two places that actually
// choose audio at render time. Measured on the shipped 2,409-clip corpus: the
// runtime guard used bare stems, so "laughing", "voices" and "singing" all got
// through — and the noun-overlap re-rank then PROMOTED them. The ambience bed
// path had no guard whatsoever while its own query table asked for "crowd of
// people murmuring", and a bed loops under the WHOLE scene.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isVocal } from '../src/vocal-guard.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('every caption that leaked past the old guard is now blocked', () => {
  // real captions from the shipped corpus that the bare-stem guard let through
  const leaked = [
    '7 - running, children laughing.wav',
    'jumbled voices in a small conference room, multiple conversations',
    'crowd singing along at a concert',
    'OH MY GOD — A man yells "OH MY GOD!!"',
    'crowd of people murmuring ambience',
    'woman speaking softly into a microphone',
    'two people having a conversation',
    'girl giggles and runs away',
  ];
  for (const c of leaked) assert.ok(isVocal(c), `must block: ${c}`);
});

test('ordinary sound effects are not over-blocked', () => {
  const legit = [
    'door slam heavy wooden', 'rain on window glass', 'car engine idling',
    'footsteps on gravel', 'thunder rumble distant', 'glass shatter',
    'clock ticking', 'sword unsheathed slowly', 'paper rustling',
  ];
  for (const c of legit) assert.ok(!isVocal(c), `must allow: ${c}`);
});

test('inflections cannot slip past — the exact hole that leaked', () => {
  // the old guard matched the stem but not the tense: this is the whole bug
  for (const stem of ['laugh', 'voice', 'sing', 'yell', 'shout', 'scream', 'whisper']) {
    for (const suffix of ['', 's', 'ing', 'ed']) {
      const word = stem + suffix;
      assert.ok(isVocal(`a clip of ${word} in a room`), `must block inflection: ${word}`);
    }
  }
});

test('all three call sites use the SHARED guard, not a private copy', () => {
  // The founding lesson landed in one file and missed the other two. A local
  // regex here is how that happens again, so assert the imports structurally.
  for (const f of ['engines/sfx/retrieve.mjs', 'engines/ambience/retrieve.mjs', 'src/scaffold.mjs']) {
    const src = readFileSync(path.join(root, f), 'utf8');
    assert.match(src, /from '.*vocal-guard\.mjs'/,
      `${f} must import the shared vocal guard`);
  }
  // and the ambience BED path must actually apply it (it had none at all)
  const amb = readFileSync(path.join(root, 'engines/ambience/retrieve.mjs'), 'utf8');
  assert.match(amb, /isVocal\(/, 'ambience beds must filter vocal clips');
});

test('the real corpus has no vocal clip that survives the guard by inflection', () => {
  const mf = path.join(root, 'corpus', 'index-all', 'manifest.json');
  if (!existsSync(mf)) { console.log('  (no corpus indexed — corpus sweep skipped)'); return; }
  const rows = JSON.parse(readFileSync(mf, 'utf8'));
  // any caption naming a vocalisation in ANY tense must be caught
  const inflected = /\b(?:laughing|laughs|voices|singing|sings|yelling|yells|shouting|shouts|screaming|screams|speaking|speaks|talking|talks|conversations?)\b/i;
  const escapees = rows.filter((r) => inflected.test(r.caption || '') && !isVocal(r.caption || ''));
  assert.deepEqual(escapees.map((r) => r.caption).slice(0, 5), [],
    `${escapees.length} vocal captions still escape the guard`);
});
