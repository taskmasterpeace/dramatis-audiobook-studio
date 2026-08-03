#!/usr/bin/env node
// Mix bench -- puts numbers on any change to the stem trims, the duck profiles
// or the master targets BEFORE anyone spends an hour listening.
//
// Why it exists: the mix is the one stage with no golden file. Its output is
// audio, and "dialog is sacred" is a claim about RELATIVE LEVEL that nothing
// measured -- which is how the SFX stem shipped into amix with no trim and no
// duck at all (see UNDER_DIALOG in src/mix.mjs). A test can prove the graph is
// shaped right; only a bench can say by how many dB.
//
// It drives the REAL graph builder with REAL speech (an actor seed clip, so the
// sidechain sees a true speech envelope -- a tone or noise burst would give a
// flattering and meaningless answer) plus deterministic transients at known
// times, then reports:
//   * duck depth per stem, in dB, under speech
//   * how much of that a one-shot recovers inside a GAP_LINE inter-line gap
//   * master conformance: integrated LUFS, LRA and TRUE PEAK AFTER the AAC
//     encode, which is the only true peak a listener ever hears
//
// Usage:  node scripts/mix-bench.mjs [--out DIR] [--keep]
//         --keep leaves the rendered wavs/m4as for listening.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildImmersiveGraph, MIX_PROFILE } from '../src/mix.mjs';
import { master, masterGainDb, IMMERSIVE } from '../src/master.mjs';
import { measureLoudness } from '../src/util.mjs';

const pexec = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { GAP_LINE, DUCK, DUCK_SFX } = MIX_PROFILE;

// The graph exactly as it shipped before 2026-07-28, kept verbatim so the
// comparison is against what really ran, not against a reconstruction of it.
// Two defects live in this one string: the SFX stem [2:a] enters amix with no
// trim and no duck, and the trailing single-pass loudnorm runs in DYNAMIC mode
// (a compressor). The bench measures both against the current chain.
const LEGACY_GRAPH =
  '[1:a]volume=-16dB[ambq];[3:a]volume=-20dB[musq];' +
  `[ambq][0:a]${DUCK}[duckedA];[musq][0:a]${DUCK}[duckedM];` +
  '[0:a][duckedA][2:a][duckedM]amix=inputs=4:duration=first:normalize=0,' +
  'loudnorm=I=-18:TP=-2:LRA=11[out]';

// Bench timeline, built the way src/mix.mjs builds a dialog stem: lead-in
// silence, then speech segments separated by GAP_LINE holes.
const LEAD = 1.0;
const SEG = 5.0;
const SPEECH = [
  { start: LEAD, end: LEAD + SEG },                                  // 1.00 - 6.00
  { start: LEAD + SEG + GAP_LINE, end: LEAD + 2 * SEG + GAP_LINE },  // 6.45 - 11.45
];
const GAP = { start: LEAD + SEG, end: LEAD + SEG + GAP_LINE };       // 6.00 - 6.45
const TOTAL = SPEECH[1].end + 1.0;

// One-shots: one landing mid-sentence (the masking risk) and one landing in the
// inter-line gap (the "does it ever bloom" question).
const HIT_SPEECH = 3.50;
const HIT_GAP = GAP.start + 0.05;

async function ff(args) {
  return pexec('ffmpeg', ['-hide_banner', '-nostats', '-loglevel', 'error', '-y', ...args],
    { maxBuffer: 64 * 1024 * 1024 });
}

// astats prints at info level, so this cannot reuse util.mjs ffmpeg().
async function stats(file, start, end) {
  const { stderr } = await pexec('ffmpeg', ['-hide_banner', '-nostats', '-i', file,
    '-af', `atrim=start=${start}:end=${end},astats`, '-f', 'null', '-'],
    { maxBuffer: 64 * 1024 * 1024 });
  const peak = [...stderr.matchAll(/Peak level dB:\s*(-?[\d.]+|-?inf)/g)].at(-1);
  const rms = [...stderr.matchAll(/RMS level dB:\s*(-?[\d.]+|-?inf)/g)].at(-1);
  const num = (m) => (m ? (m[1] === '-inf' ? -Infinity : parseFloat(m[1])) : null);
  return { peakDb: num(peak), rmsDb: num(rms) };
}

async function loudness(file) {
  const { stderr } = await pexec('ffmpeg', ['-hide_banner', '-nostats', '-i', file,
    '-filter_complex', 'ebur128=peak=true', '-f', 'null', '-'], { maxBuffer: 64 * 1024 * 1024 });
  const tail = stderr.slice(-2000);
  const grab = (re) => { const m = tail.match(re); return m ? parseFloat(m[1]) : null; };
  return {
    i: grab(/I:\s*(-?[\d.]+)\s*LUFS/),
    lra: grab(/LRA:\s*(-?[\d.]+)\s*LU/),
    truePeak: grab(/Peak:\s*(-?[\d.]+)\s*dBFS/),
  };
}

// ---- signal construction -------------------------------------------------

async function buildDialogStem(out) {
  const seeds = ['nola-elder', 'liu-xiao'].map((a) => path.join(ROOT, 'actors', a, 'seed.wav'));
  const seed = seeds.find((s) => existsSync(s));
  if (!seed) throw new Error('no actor seed clip found -- bench needs real speech in actors/*/seed.wav');
  // Two 5 s slices of real narration, concatenated with a real GAP_LINE hole,
  // resampled to the 48 kHz mono the mix stage works in.
  await ff(['-i', seed, '-filter_complex',
    `[0:a]atrim=start=1:end=6,asetpts=N/SR/TB[a];` +
    `[0:a]atrim=start=8:end=13,asetpts=N/SR/TB[b];` +
    `anullsrc=r=24000:cl=mono:d=${LEAD}[lead];` +
    `anullsrc=r=24000:cl=mono:d=${GAP_LINE}[gap];` +
    `anullsrc=r=24000:cl=mono:d=1.0[tail];` +
    `[lead][a][gap][b][tail]concat=n=5:v=0:a=1[c]`,
    '-map', '[c]', '-ar', '48000', '-ac', '1', out]);
  return out;
}

// A chapter is not uniform: it has an intimate scene and a loud one. The plain
// bench stem is already narrower than every LRA target we might set, so it
// physically cannot answer "is LRA=11 too wide" -- this one can. Segment two is
// dropped 14 dB to stand in for a quiet passage.
async function buildWideDialogStem(out) {
  const seeds = ['nola-elder', 'liu-xiao'].map((a) => path.join(ROOT, 'actors', a, 'seed.wav'));
  const seed = seeds.find((s) => existsSync(s));
  await ff(['-i', seed, '-filter_complex',
    `[0:a]atrim=start=1:end=6,asetpts=N/SR/TB[a];` +
    `[0:a]atrim=start=8:end=13,asetpts=N/SR/TB,volume=-14dB[b];` +
    `[0:a]atrim=start=14:end=19,asetpts=N/SR/TB[c];` +
    `anullsrc=r=24000:cl=mono:d=${LEAD}[lead];` +
    `anullsrc=r=24000:cl=mono:d=${GAP_LINE}[g1];` +
    `anullsrc=r=24000:cl=mono:d=${GAP_LINE}[g2];` +
    `[lead][a][g1][b][g2][c]concat=n=6:v=0:a=1[o]`,
    '-map', '[o]', '-ar', '48000', '-ac', '1', out]);
  return out;
}

// A slam: low-passed noise crack over a decaying thump. Deterministic, and
// shaped like the transients that actually cause the complaint (door, shot).
async function buildSlam(out, dur = 0.65) {
  await ff(['-f', 'lavfi', '-i', `anoisesrc=r=48000:d=${dur}:c=pink:a=0.85:s=7`,
    '-f', 'lavfi', '-i', `sine=frequency=64:duration=${dur}:sample_rate=48000`,
    '-filter_complex',
    `[0:a]lowpass=f=1100,afade=t=in:st=0:d=0.004,afade=t=out:st=0.01:d=${dur - 0.01}:curve=exp[n];` +
    `[1:a]afade=t=in:st=0:d=0.004,afade=t=out:st=0:d=0.28:curve=exp,volume=0.8[t];` +
    `[n][t]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[o]`,
    '-map', '[o]', '-ar', '48000', '-ac', '1', out]);
  return out;
}

async function buildSfxStem(out, slam) {
  // Cue gains as the sfx-proof book sets them by ear: slam -4, gunshot-class -7.
  await ff(['-f', 'lavfi', '-i', `anullsrc=r=48000:cl=mono:d=${TOTAL}`, '-i', slam, '-i', slam,
    '-filter_complex',
    `[1:a]volume=-4dB,adelay=${Math.round(HIT_SPEECH * 1000)}:all=1[s1];` +
    `[2:a]volume=-4dB,adelay=${Math.round(HIT_GAP * 1000)}:all=1[s2];` +
    `[0:a][s1][s2]amix=inputs=3:duration=first:normalize=0[o]`,
    '-map', '[o]', '-ar', '48000', '-ac', '1', out]);
  return out;
}

// Two speech segments separated by a gap of `gap` seconds -- used to ask how
// fast the duck lets go at a line edge versus a scene edge.
async function buildGappedDialog(out, gap) {
  const seeds = ['nola-elder', 'liu-xiao'].map((a) => path.join(ROOT, 'actors', a, 'seed.wav'));
  const seed = seeds.find((s) => existsSync(s));
  await ff(['-i', seed, '-filter_complex',
    `[0:a]atrim=start=1:end=6,asetpts=N/SR/TB[a];` +
    `[0:a]atrim=start=8:end=13,asetpts=N/SR/TB[b];` +
    `anullsrc=r=24000:cl=mono:d=${LEAD}[lead];` +
    `anullsrc=r=24000:cl=mono:d=${gap}[g];` +
    `anullsrc=r=24000:cl=mono:d=1.0[tail];` +
    `[lead][a][g][b][tail]concat=n=5:v=0:a=1[o]`,
    '-map', '[o]', '-ar', '48000', '-ac', '1', out]);
  return out;
}

async function buildOneShotAt(out, slam, at, total) {
  await ff(['-f', 'lavfi', '-i', `anullsrc=r=48000:cl=mono:d=${total.toFixed(2)}`, '-i', slam,
    '-filter_complex', `[1:a]volume=-4dB,adelay=${Math.round(at * 1000)}:all=1[s];` +
    `[0:a][s]amix=inputs=2:duration=first:normalize=0[o]`,
    '-map', '[o]', '-ar', '48000', '-ac', '1', out]);
  return out;
}

async function buildBed(out, filter) {
  await ff(['-f', 'lavfi', '-i', `anoisesrc=r=48000:d=${TOTAL}:c=pink:a=0.5:s=3`,
    '-af', filter, '-ar', '48000', '-ac', '1', out]);
  return out;
}

// ---- measurement ---------------------------------------------------------

// Render one stem's chain in isolation, with the dialog stem driving the
// sidechain, so the reported number is that stem's gain reduction and nothing
// else. `duck` null reproduces an un-ducked stem (the legacy SFX path).
async function renderChain(dialog, stem, gainDb, duck, out) {
  const graph = duck
    ? `[1:a]volume=${gainDb}dB[q];[q][0:a]${duck}[o]`
    : `[1:a]volume=${gainDb}dB[o]`;
  await ff(['-i', dialog, '-i', stem, '-filter_complex', graph, '-map', '[o]',
    '-ar', '48000', '-ac', '1', out]);
  return out;
}

const dB = (v) => (v === null || v === -Infinity ? '  -inf' : v.toFixed(1).padStart(6));

// Candidates put in front of the ear. Only the SFX path varies between 1-3; the
// master is held constant so the comparison answers one question at a time.
const EAR_OPTIONS = [
  { name: '1-gentle', trim: 0, ratio: 1.5, note: 'slam +0.5 dB vs dialog RMS' },
  { name: '2-balanced', trim: -2, ratio: 1.5, note: 'slam -1.5 dB vs dialog RMS' },
  { name: '3-firm', trim: -3, ratio: 2, note: 'slam -5.7 dB vs dialog RMS' },
];

// Bring a clip to a fixed true peak with ONE linear gain — the audition
// equivalent of the master stage's ceiling, minus the loudness target. The ear
// options are compared for RELATIVE slam-vs-dialog level (baked into the
// premaster before any master), so matching their peaks is all that is needed
// to make them fair to compare; chasing an absolute LUFS target would only make
// the audition fail the same peak gate a hot cinematic premaster does.
async function peakNormalize(inFile, out, targetPeak, encodeArgs) {
  const { truePeak } = await loudness(inFile);
  const gain = (typeof truePeak === 'number' ? targetPeak - truePeak : 0);
  await ff(['-i', inFile, '-af', `volume=${gain.toFixed(2)}dB`, ...encodeArgs, out]);
  return out;
}

// Machines rule on level; only the ear rules on whether a slam still startles.
// This renders the same seconds of narration through each candidate so that
// judgement is made on audio, not on a table of decibels. Each option is
// peak-normalized to the same -3.5 dBTP ceiling (see peakNormalize) so the ONLY
// thing that differs between clips is the SFX trim/duck under test.
async function renderEarOptions(outDir, dialog, amb, sfx, mus) {
  const p = (n) => path.join(outDir, n);
  const enc = ['-c:a', 'aac', '-b:a', '128k', '-ar', '44100'];
  const made = [];
  const shipped = p('0-shipped-today.m4a');
  await ff(['-i', dialog, '-i', amb, '-i', sfx, '-i', mus, '-filter_complex', LEGACY_GRAPH,
    '-map', '[out]', ...enc, shipped]);
  made.push([shipped, 'what ships today: SFX raw + one-pass loudnorm (compressor)']);
  for (const o of EAR_OPTIONS) {
    const stems = [
      { input: 1, tag: 'amb', gainDb: -16, duck: DUCK },
      { input: 2, tag: 'sfx', gainDb: o.trim, duck: `sidechaincompress=threshold=0.02:ratio=${o.ratio}:attack=60:release=350:makeup=1` },
      { input: 3, tag: 'mus', gainDb: -20, duck: DUCK },
    ];
    const pre = p(`${o.name}-premaster.wav`);
    await ff(['-i', dialog, '-i', amb, '-i', sfx, '-i', mus,
      '-filter_complex', buildImmersiveGraph(stems), '-map', '[out]', '-ar', '48000', '-ac', '1', pre]);
    const f = p(`${o.name}.m4a`);
    await peakNormalize(pre, f, IMMERSIVE.tp, enc);
    if (!process.argv.includes('--keep')) rmSync(pre, { force: true });
    made.push([f, `trim ${o.trim} dB, duck ratio ${o.ratio} -- ${o.note}`]);
  }
  console.log('\nEAR OPTIONS  (peak-normalized to -3.5 dBTP; relative SFX level is the variable)');
  for (const [f, note] of made) console.log(`  ${path.basename(f).padEnd(20)} ${note}`);
  return made;
}

async function main() {
  const outDir = argValue('--out') || path.join(ROOT, 'out', 'mix-bench');
  mkdirSync(outDir, { recursive: true });
  const p = (n) => path.join(outDir, n);

  console.log('building bench signals from real speech...');
  const dialog = await buildDialogStem(p('bench-dialog.wav'));
  const slam = await buildSlam(p('bench-slam.wav'));
  const sfx = await buildSfxStem(p('bench-sfx.wav'), slam);
  const amb = await buildBed(p('bench-amb.wav'), 'highpass=f=200,lowpass=f=6000');
  const mus = await buildBed(p('bench-mus.wav'), 'lowpass=f=2500,tremolo=f=0.4:d=0.3');

  const speechWin = [SPEECH[0].start + 1.0, SPEECH[0].start + 4.0];
  const dRms = (await stats(dialog, ...speechWin)).rmsDb;
  console.log(`dialog stem RMS over the measurement window: ${dB(dRms)} dBFS\n`);

  if (process.argv.includes('--ear')) {
    await renderEarOptions(outDir, dialog, amb, sfx, mus);
    console.log(`\nartifacts in ${outDir}`);
    return;
  }

  // 1) duck depth per stem, dry vs ducked, measured over continuous speech
  console.log('DUCK DEPTH under speech  (dry -> ducked, so more negative = more protection)');
  const rows = [
    ['ambience', amb, -16, DUCK],
    ['music', mus, -20, DUCK],
    ['sfx  (was: none)', sfx, 0, null],
    ['sfx  (now)', sfx, MIX_PROFILE.UNDER_DIALOG[1].gainDb, DUCK_SFX],
  ];
  for (const [label, stem, gain, duck] of rows) {
    const dry = await renderChain(dialog, stem, gain, null, p(`chain-dry-${slug(label)}.wav`));
    const wet = await renderChain(dialog, stem, gain, duck, p(`chain-wet-${slug(label)}.wav`));
    const a = await stats(dry, ...speechWin);
    const b = await stats(wet, ...speechWin);
    const delta = b.rmsDb - a.rmsDb;
    console.log(`  ${label.padEnd(18)} dry ${dB(a.rmsDb)}   ducked ${dB(b.rmsDb)}   duck ${dB(delta)} dB`);
  }

  // 2) the one-shot question: how loud is a slam over a word, and does the one
  //    that lands in the gap recover before the next line starts?
  console.log('\nONE-SHOT LEVEL  (peak of the same slam, relative to dialog RMS)');
  for (const [label, gain, duck] of [
    ['before (raw)', 0, null],
    ['after', MIX_PROFILE.UNDER_DIALOG[1].gainDb, DUCK_SFX],
  ]) {
    const f = await renderChain(dialog, sfx, gain, duck, p(`chain-shot-${slug(label)}.wav`));
    const over = await stats(f, HIT_SPEECH - 0.02, HIT_SPEECH + 0.45);
    const inGap = await stats(f, HIT_GAP - 0.02, HIT_GAP + 0.40);
    console.log(`  ${label.padEnd(14)} over a word ${dB(over.peakDb)} dBFS ` +
      `(${dB(over.peakDb - dRms)} dB vs dialog)   in the gap ${dB(inGap.peakDb)} dBFS`);
  }

  // 3) the master stage: the shipped one-pass loudnorm (a compressor) vs
  //    measure-then-linear-gain. Built on a WIDE premaster so the LRA squash is
  //    visible -- a flat signal cannot show a compressor doing its damage.
  console.log('\nMASTER STAGE  (one-pass loudnorm vs measure-then-gain, on wide material)');
  const widePre = p('premaster-wide.wav');
  {
    const wideDialog = await buildWideDialogStem(p('bench-dialog-wide.wav'));
    await ff(['-i', wideDialog, '-i', amb, '-i', sfx, '-i', mus,
      '-filter_complex', buildImmersiveGraph(), '-map', '[out]', '-ar', '48000', '-ac', '1', widePre]);
  }
  const preL = await loudness(widePre);
  console.log(`  premaster (ungraded):        I=${dB(preL.i)}  LRA=${preL.lra} LU  TP=${dB(preL.truePeak)}`);
  // the old chain: one-pass loudnorm, exactly as it shipped
  const oldM = p('master-oldchain.m4a');
  await ff(['-i', widePre, '-af', 'loudnorm=I=-18:TP=-2:LRA=11',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', oldM]);
  const oldL = await loudness(oldM);
  console.log(`  old one-pass loudnorm:       I=${dB(oldL.i)}  LRA=${oldL.lra} LU  TP=${dB(oldL.truePeak)}` +
    `   squashed ${(preL.lra - oldL.lra).toFixed(1)} LU of range`);
  // the new chain: master() measures then applies one linear gain. On a quiet,
  // peaky premaster the peak ceiling can block the boost to target — that is a
  // legitimate gate failure (a too-hot mix), so report it rather than crash.
  const newM = p('master-newchain.m4a');
  const r = await master(widePre, newM, IMMERSIVE, ['-c:a', 'aac', '-b:a', '128k', '-ar', '44100'])
    .catch((e) => ({ err: e.message }));
  if (r.err) {
    console.log(`  new measure-then-gain:       GATE FAILED — ${r.err}`);
  } else {
    console.log(`  new measure-then-gain:       I=${dB(r.measured.integratedLufs)}  LRA=${r.measured.lra} LU  ` +
      `TP=${dB(r.measured.truePeakDb)}   preserved range (${(preL.lra - r.measured.lra).toFixed(1)} LU drift)` +
      `${r.measured.truePeakDb < -3 ? '   ACX ok' : '   ACX FAIL'}`);
  }

  // 4) candidate sweep. The number that decides this is the slam's peak
  //    relative to dialog RMS: positive means it sits above the voice.
  console.log('\nSFX PROFILE SWEEP  (slam peak relative to dialog RMS, over a word)');
  console.log('   trim  ratio |  over a word  |  in the gap  | duck depth');
  for (const trim of [0, -2, -3]) {
    for (const ratio of [1.3, 1.5, 2, 2.5]) {
      const duck = `sidechaincompress=threshold=0.02:ratio=${ratio}:attack=60:release=350:makeup=1`;
      const f = await renderChain(dialog, sfx, trim, duck, p('sweep.wav'));
      const over = await stats(f, HIT_SPEECH - 0.02, HIT_SPEECH + 0.45);
      const inGap = await stats(f, HIT_GAP - 0.02, HIT_GAP + 0.40);
      const dry = await renderChain(dialog, sfx, trim, null, p('sweep-dry.wav'));
      const depth = (await stats(f, ...speechWin)).rmsDb - (await stats(dry, ...speechWin)).rmsDb;
      console.log(`  ${String(trim).padStart(5)}  ${String(ratio).padStart(5)} | ` +
        `${dB(over.peakDb - dRms)} dB    | ${dB(inGap.peakDb - dRms)} dB   | ${dB(depth)} dB`);
    }
  }
  rmSync(p('sweep.wav'), { force: true });
  rmSync(p('sweep-dry.wav'), { force: true });

  // 5) does the -3.5 immersive ceiling cost any loudness? Under linear gain a
  //    tighter true-peak ceiling caps how much gain the master may apply, so a
  //    peaky mix could land short of -18. This is the measurement behind
  //    IMMERSIVE.tp: if byPeak < byLoudness at -3.5, immersive is peak-limited.
  console.log('\nIMMERSIVE CEILING  (does -3.5 dBTP still let the mix reach -18 LUFS?)');
  // masterGainDb is pure, so this evaluates the trade without rendering. Two
  // reference premasters: this bench's (quiet + peaky, a worst case for the
  // ceiling) and the one real render on record (src/master.mjs: -16.7 LUFS,
  // -1.6 dBTP), which is LOUDER than target and therefore masters DOWN.
  const immPreL = await loudness(widePre);
  const refs = [
    ['bench premaster', { integratedLufs: immPreL.i, truePeakDb: immPreL.truePeak }],
    ['real render (on record)', { integratedLufs: -16.7, truePeakDb: -1.6 }],
  ];
  for (const [name, m] of refs) {
    console.log(`  ${name}: I=${dB(m.integratedLufs)} LUFS  peak=${dB(m.truePeakDb)} dBTP`);
    for (const tp of [-2, -3, -3.5]) {
      const g = masterGainDb(m, { i: -18, tp });
      const landedI = m.integratedLufs + g.db;
      console.log(`    ceiling ${String(tp).padStart(4)} dBTP -> gain ${g.db >= 0 ? '+' : ''}${g.db.toFixed(2)} dB` +
        `  (${g.peakLimited ? 'PEAK-LIMITED' : 'loudness-limited'})  lands I=${landedI.toFixed(1)}` +
        `${Math.abs(landedI + 18) <= 0.5 ? '  hits -18' : '  MISSES -18'}`);
    }
  }

  // 6) does the release time buy anything? A one-shot landing just after a line
  //    ends can only bloom if the duck has let go by then. GAP_LINE is 450 ms
  //    and GAP_SCENE is 2200 ms, so measure at both before believing any story
  //    about release times.
  console.log('\nRELEASE SWEEP  (slam 50 ms into a gap, peak relative to dialog RMS)');
  const sceneDialog = await buildGappedDialog(p('bench-dialog-scene.wav'), 2.2);
  const sceneSfx = await buildOneShotAt(p('bench-sfx-scene.wav'), slam, LEAD + SEG + 0.05, LEAD + 2 * SEG + 2.2);
  for (const rel of [1100, 350, 150]) {
    const duck = `sidechaincompress=threshold=0.02:ratio=2:attack=60:release=${rel}:makeup=1`;
    const lineF = await renderChain(dialog, sfx, -3, duck, p('rel-line.wav'));
    const sceneF = await renderChain(sceneDialog, sceneSfx, -3, duck, p('rel-scene.wav'));
    const a = await stats(lineF, HIT_GAP - 0.02, HIT_GAP + 0.40);
    const b = await stats(sceneF, LEAD + SEG + 0.03, LEAD + SEG + 0.50);
    console.log(`  release ${String(rel).padStart(4)} ms   in a 450 ms line gap ${dB(a.peakDb - dRms)} dB` +
      `   in a 2200 ms scene gap ${dB(b.peakDb - dRms)} dB`);
  }
  for (const f of ['rel-line.wav', 'rel-scene.wav']) rmSync(p(f), { force: true });

  // (a rendered ACX verdict per ceiling would need a premaster at a realistic
  //  crest; the raw actor-seed bench signal is too peaky to master to target,
  //  so the ceiling analysis above uses the pure gain function on both the
  //  bench worst case and the real render on record. The end-to-end proof that
  //  the encode preserves true peak within 0.1 dB lives in
  //  test/master-loudness.test.mjs, which masters a controlled fixture.)

  if (!process.argv.includes('--keep')) {
    for (const f of ['chain-dry', 'chain-wet', 'chain-shot']) {
      for (const g of rows.map(([l]) => slug(l))) rmSync(p(`${f}-${g}.wav`), { force: true });
    }
    for (const f of ['premaster-wide.wav', 'master-oldchain.m4a', 'master-newchain.m4a']) {
      rmSync(p(f), { force: true });
    }
  }
  console.log(`\nartifacts in ${outDir}`);
}

function slug(s) { return s.replace(/[^a-z0-9]+/gi, '-').replace(/-+$/, '').toLowerCase(); }
function argValue(flag) { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : null; }

main().catch((e) => { console.error(e.message); process.exit(1); });
