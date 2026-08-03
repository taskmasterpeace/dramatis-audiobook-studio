// Regression tests for the mix stage. Every assertion here corresponds to a
// defect that was live in the mixer, and each one FAILS on the code that
// preceded it:
//
//   - inter-line gaps were digital zero (anullsrc), so the floor pumped between
//     the renders' own noise and -inf at every boundary
//   - a dialogue/attribution split got the full 0.45s line gap, so the mixer
//     paused in the middle of a sentence
//   - every scene got a room-hum bed by default
//   - lines were concatenated at whatever level they rendered at (measured
//     12.5 LU of spread)
//   - loudnorm TP=-3 delivered -2.9, failing ACX's "peak less than -3 dB"
//   - there was no MP3 retail artifact at all
//
// The mixer needs ffmpeg. It is already a hard dependency of the project, so a
// missing ffmpeg is a real failure here, not a skip.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { ffmpeg, pexecFile } from '../src/util.mjs';
import { mix } from '../src/mix.mjs';

const ROOT = path.join(tmpdir(), 'ams-mix-test');

// Three "renders" at deliberately different levels. The 12 dB spread between
// the loudest and quietest is the defect being tested: it is roughly what was
// measured across real renders, and the mixer used to carry it straight into
// the master.
// CALIBRATION, so nobody re-derives this the hard way. Two traps here:
//   1. ebur128 is K-weighted. A 220 Hz tone reads far quieter than speech at
//      the same dBFS, so low-frequency material clamps at max gain and the test
//      ends up measuring the clamp instead of the levelling. 1 kHz is where
//      K-weighting is flat.
//   2. ffmpeg's `sine` source is NOT full scale — measured, volume=-10dB gives
//      a peak of -28.1 dBFS, so the base tone sits ~18 dB down.
// Measured on this filter chain: these three land at roughly -13/-25/-19 LUFS,
// a real 12 dB spread, all needing gains inside the +/-12 dB clamp.
const LINES = [
  { id: 'lin_0001', entity: 'mr_white', text: '"Hark at the wind,"', para: 0, db: 8 },
  { id: 'lin_0002', entity: 'narrator', text: 'said Mr. White.', para: 0, db: -4 },
  { id: 'lin_0003', entity: 'narrator', text: 'The night was cold.', para: 1, db: 2 },
];

const script = {
  book: 'test-book',
  chapter: 'Chapter 1',
  // no ambience: this is what a freshly scaffolded book now looks like
  scenes: [{ id: 'sc-1', ambience: null, lines: LINES.map(({ db, ...l }) => l) }],
  cues: [],
  music: [],
};

async function rmsOf(file, from, to) {
  const { stderr } = await pexecFile('ffmpeg', ['-hide_banner', '-nostats', '-i', file,
    '-af', `atrim=${from}:${to},astats`, '-f', 'null', '-'], { maxBuffer: 32 * 1024 * 1024 });
  const all = [...stderr.matchAll(/RMS level dB:\s*(-?[\d.]+|-?inf)/g)];
  assert.ok(all.length, `no astats RMS for ${file}`);
  return parseFloat(all.at(-1)[1]);   // -inf parses to -Infinity, which is the point
}

async function integratedLufs(file) {
  const { stderr } = await pexecFile('ffmpeg', ['-hide_banner', '-nostats', '-i', file,
    '-filter_complex', 'ebur128=peak=true', '-f', 'null', '-'], { maxBuffer: 32 * 1024 * 1024 });
  // last match, not first — see the note in util.mjs measureLoudness
  return parseFloat([...stderr.matchAll(/I:\s*(-?[\d.]+)\s*LUFS/g)].at(-1)[1]);
}

let result;
let outDir;

test.before(async () => {
  rmSync(ROOT, { recursive: true, force: true });
  outDir = path.join(ROOT, 'out');
  const cacheRoot = path.join(ROOT, 'cache');
  mkdirSync(outDir, { recursive: true });
  mkdirSync(cacheRoot, { recursive: true });

  const lineWavs = {};
  for (const l of LINES) {
    const f = path.join(cacheRoot, `${l.id}.wav`);
    // speech-ish rather than a pure tone: a sine sweep gives ebur128 real
    // gated material to integrate over
    await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=1000:duration=1.4',
      '-af', `volume=${l.db}dB`, '-ar', '24000', '-ac', '1', f]);
    lineWavs[l.id] = f;
  }
  result = await mix(script, lineWavs, outDir, cacheRoot);
});

test.after(() => rmSync(ROOT, { recursive: true, force: true }));

test('a dialogue/attribution split does not get a full inter-line pause', async () => {
  const timing = JSON.parse(readFileSync(path.join(outDir, 'timing.json'), 'utf8'));
  const [a, b, c] = timing.lines;

  // lin_0001 ends on a comma inside a quote and lin_0002 finishes that same
  // sentence in the same paragraph -> clause gap
  const midSentence = +(b.start - (a.start + a.dur)).toFixed(2);
  // lin_0002 ends on a full stop -> a real line gap follows
  const betweenSentences = +(c.start - (b.start + b.dur)).toFixed(2);

  assert.ok(midSentence < 0.2,
    `mid-sentence gap should be a clause pause, got ${midSentence}s (the old mixer gave 0.45s here)`);
  assert.ok(betweenSentences > 0.4,
    `a finished sentence should still get the full line gap, got ${betweenSentences}s`);
  assert.ok(betweenSentences > midSentence * 2,
    'the two gap lengths must actually differ, or the sentence test is not firing');
});

test('the gaps carry room tone, not digital zero', async () => {
  const stem = path.join(outDir, 'stem-dialog.wav');
  // ACX wants room tone at BOTH ends, so check both: the 1.0s lead-in and the
  // trailing pad, each sampled clear of its edges.
  const end = result.durationSec;
  const regions = {
    'lead-in': await rmsOf(stem, 0.15, 0.85),
    tail: await rmsOf(stem, end - 1.5, end - 0.3),
  };

  for (const [where, floor] of Object.entries(regions)) {
    assert.ok(Number.isFinite(floor),
      `the ${where} measured ${floor} — that is digital silence, which is the defect: ` +
      'it discontinuity-jumps against the renders\' own noise floor, fails ACX\'s ' +
      'room-tone requirement, and makes any noise-floor gate read -inf and pass trivially');
    assert.ok(floor < -60,
      `${where} room tone must stay under ACX's -60 dB ceiling, measured ${floor} dB`);
    assert.ok(floor > -100,
      `${where} room tone at ${floor} dB is indistinguishable from silence — it would not do its job`);
  }
  // and it must be the SAME floor at both ends: a level step between them is
  // the discontinuity this whole change exists to remove
  assert.ok(Math.abs(regions['lead-in'] - regions.tail) < 3,
    `room tone differs by ${Math.abs(regions['lead-in'] - regions.tail).toFixed(1)} dB ` +
    'between head and tail — the floor is not continuous');
});

test('a scene with no ambience gets no bed', () => {
  assert.deepEqual(result.qa.beds, [],
    'ambience is opt-in; a scaffolded book must not play a drone under every scene');
});

test('lines are levelled to a common target before the concat', async () => {
  const levels = [];
  for (const l of LINES) {
    const lvl = path.join(ROOT, 'cache', `${l.id}-lvl48k.wav`);
    assert.ok(existsSync(lvl), `missing levelled copy for ${l.id} (the -48k suffix must be bumped)`);
    levels.push(await integratedLufs(lvl));
  }
  const spread = Math.max(...levels) - Math.min(...levels);
  assert.ok(spread < 3,
    `levelled lines still span ${spread.toFixed(1)} LU (sources span 12 dB) — ` +
    'the master would only fix the average and leave this audible');
});

test('the retail master is MP3 and clears ACX peak, RMS and noise floor', async () => {
  const { retail } = result.qa;
  assert.ok(existsSync(retail.file), 'no retail artifact was produced');
  assert.match(retail.file, /\.mp3$/);

  const { stdout } = await pexecFile('ffprobe', ['-v', 'error', '-select_streams', 'a:0',
    '-show_entries', 'stream=codec_name,sample_rate', '-of', 'default=nw=1', retail.file]);
  assert.match(stdout, /codec_name=mp3/);
  assert.match(stdout, /sample_rate=44100/);

  assert.ok(retail.truePeakDb < -3,
    `peak ${retail.truePeakDb} dB fails ACX's "less than -3 dB" (loudnorm's TP=-3 landed at -2.9)`);
  assert.ok(retail.rmsDb >= -23 && retail.rmsDb <= -18,
    `RMS ${retail.rmsDb} dB is outside ACX's -23..-18 window`);
  assert.ok(retail.noiseFloorDb != null && retail.noiseFloorDb < -60,
    `noise floor ${retail.noiseFloorDb} dB fails ACX's -60 dB ceiling`);
  assert.equal(retail.acx.pass, true, `ACX thresholds not met: ${retail.acx.failed.join(', ')}`);
});

test('the SFX stem is ducked and gained like every other non-dialog stem', () => {
  const src = readFileSync(new URL('../src/mix.mjs', import.meta.url), 'utf8');
  const graph = src.match(/\[1:a\]volume=\$\{AMB_GAIN_DB\}[\s\S]*?amix=inputs=4/);
  assert.ok(graph, 'could not locate the 4-stem mix graph');
  const g = graph[0];

  // the bug: [2:a] went straight into the amix while [1:a] and [3:a] were
  // gained and ducked first, so "dialog sacred" skipped the loudest stem
  assert.ok(!/\[0:a\]\[duckedA\]\[2:a\]/.test(g),
    'the SFX stem is being summed raw into the mix — it must be gained and ducked like the beds');
  assert.ok(/\[2:a\]volume=\$\{SFX_GAIN_DB\}/.test(g), 'the SFX stem is not gained');
  assert.ok(/\[sfxq\]\[0:a\]\$\{DUCK_SFX\}/.test(g), 'the SFX stem is not ducked against dialog');
});
