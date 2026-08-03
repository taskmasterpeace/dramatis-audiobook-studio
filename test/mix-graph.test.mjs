// The mix graph is the one stage with no golden file: its output is audio, so
// nothing caught the SFX stem reaching amix as a bare [2:a] with no trim and no
// duck (2026-07-28 -- a slam measured 6.9 dB ABOVE the dialog under it).
//
// These tests encode the law rather than the current numbers: DIALOG IS THE ONLY
// SIGNAL THAT ARRIVES AT amix UNPROCESSED, and it is the sidechain key for every
// other stem. Levels are an ear question and will move; the shape must not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildImmersiveGraph, MIX_PROFILE } from '../src/mix.mjs';

const { UNDER_DIALOG, MASTER_IMMERSIVE, MASTER_CLEAN } = MIX_PROFILE;

// The segment feeding amix, e.g. "[0:a][ambd][sfxd][musd]amix=inputs=4:..."
function amixInputs(graph) {
  // Deliberately case-insensitive: this helper has to be able to parse an
  // OLD-shaped graph too (the shipped one used [duckedA]/[duckedM]), or the
  // gate could not be proved against the very defect it exists to catch.
  const m = graph.match(/((?:\[[A-Za-z0-9:]+\])+)amix=/);
  assert.ok(m, 'graph must contain an amix stage');
  return m[1].match(/\[([A-Za-z0-9:]+)\]/g).map((s) => s.slice(1, -1));
}

test('every stem under dialog is trimmed AND ducked before amix', () => {
  const graph = buildImmersiveGraph();
  for (const stem of UNDER_DIALOG) {
    // a trim exists, taking the raw input and producing this stem's pre-duck tag
    assert.match(graph, new RegExp(`\\[${stem.input}:a\\]volume=-?[\\d.]+dB\\[${stem.tag}q\\]`),
      `stem ${stem.tag} must be trimmed before it is ducked`);
    // and a duck exists, keyed off dialog, consuming that tag
    assert.match(graph, new RegExp(`\\[${stem.tag}q\\]\\[0:a\\]sidechaincompress=[^\\[]+\\[${stem.tag}d\\]`),
      `stem ${stem.tag} must be sidechain-ducked against dialog`);
  }
});

test('only dialog reaches amix unprocessed', () => {
  const inputs = amixInputs(buildImmersiveGraph());
  assert.equal(inputs[0], '0:a', 'dialog must be the first amix input');
  // This is the assertion that would have failed on the shipped graph: every
  // other amix input must be a ducked tag, never a raw [N:a] stream.
  for (const label of inputs.slice(1)) {
    assert.doesNotMatch(label, /^\d+:a$/,
      `raw stem ${label} reaches amix with no trim and no duck -- see UNDER_DIALOG in src/mix.mjs`);
  }
  const expected = UNDER_DIALOG.map((s) => `${s.tag}d`);
  assert.deepEqual(inputs.slice(1), expected, 'every under-dialog stem must arrive ducked');
});

test('amix input count matches the stems actually wired', () => {
  const graph = buildImmersiveGraph();
  const declared = Number(graph.match(/amix=inputs=(\d+)/)[1]);
  assert.equal(declared, UNDER_DIALOG.length + 1,
    'a stem was added or removed without updating the amix input count');
  assert.equal(amixInputs(graph).length, declared,
    'declared amix inputs must equal the labels actually fed to it');
});

test('dialog is never trimmed and never ducked', () => {
  const graph = buildImmersiveGraph();
  assert.doesNotMatch(graph, /\[0:a\]volume=/, 'dialog must not be trimmed');
  // [0:a] may appear only as an amix input and as the sidechain key -- i.e. it
  // is never the MAIN input of a compressor, which is what ducking it would be.
  assert.doesNotMatch(graph, /\[0:a\]\[[a-z0-9]+\]sidechaincompress/, 'dialog must never be ducked');
});

test('adding a stem cannot silently skip the trim/duck treatment', () => {
  // The builder is the enforcement: describe a fourth stem and it is wired
  // correctly by construction, which is why hand-written graphs are gone.
  const withFoley = [...UNDER_DIALOG, { input: 4, tag: 'fol', gainDb: -12, duck: MIX_PROFILE.DUCK_SFX }];
  const graph = buildImmersiveGraph(withFoley);
  assert.match(graph, /\[4:a\]volume=-12dB\[folq\]/);
  assert.match(graph, /\[folq\]\[0:a\]sidechaincompress=[^\[]+\[fold\]/);
  assert.equal(amixInputs(graph).length, 5);
  assert.match(graph, /amix=inputs=5/);
});

test('SFX ducks less than the beds it shares the mix with', () => {
  // The point of a separate profile: a slam is meant to punch through where
  // ambience is meant to disappear. Reduction scales with (1 - 1/ratio), so a
  // lower ratio is literally a gentler duck.
  const ratio = (duck) => Number(duck.match(/ratio=([\d.]+)/)[1]);
  const sfx = UNDER_DIALOG.find((s) => s.tag === 'sfx');
  const beds = UNDER_DIALOG.filter((s) => s.tag !== 'sfx');
  for (const bed of beds) {
    assert.ok(ratio(sfx.duck) < ratio(bed.duck),
      `sfx duck ratio ${ratio(sfx.duck)} must stay below ${bed.tag}'s ${ratio(bed.duck)}`);
  }
});

test('both masters clear the ACX true-peak requirement with margin', () => {
  // Measured 2026-07-28: loudnorm delivers the requested ceiling to within
  // 0.1 dB through the AAC encode, so asking for -3 lands at -2.9/-3.0 and
  // does NOT clear ACX's "below -3". Anything looser than -3.5 is a regression.
  for (const [name, master] of [['immersive', MASTER_IMMERSIVE], ['clean', MASTER_CLEAN]]) {
    const tp = Number(master.match(/TP=(-?[\d.]+)/)[1]);
    assert.ok(tp <= -3.5, `${name} true-peak ceiling ${tp} is too hot to clear ACX after encode`);
    const lra = Number(master.match(/LRA=([\d.]+)/)[1]);
    assert.ok(lra <= 9, `${name} LRA ${lra} is wider than spoken word for multitasking listeners`);
  }
});
