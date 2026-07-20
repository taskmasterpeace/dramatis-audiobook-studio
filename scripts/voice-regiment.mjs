#!/usr/bin/env node
// THE VOICE REGIMENT — standing test battery for Qwen3 VoiceDesign.
//   node scripts/voice-regiment.mjs
// Renders a matrix of gendered/aged/accented designs (one short line each, one
// batched model load), then independently pitch-verifies every output file —
// defense in depth OVER the engine's internal gate. Any mismatch = exit 1.
// Born 2026-07-19: an "elderly woman" design shipped as a MAN, caught by the
// listener instead of the machine. Never again.
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { renderLines } from '../engines/tts/qwen3.mjs';
import { pythonExe } from '../src/util.mjs';

const MATRIX = [
  ['f_elder_nola', 'female-range', 'Elderly Black woman from New Orleans; warm weathered Southern voice, New Orleans accent, unhurried drawl.'],
  ['f_young_us', 'female-range', 'Young American woman in her twenties; bright, quick, clear voice.'],
  ['f_brit_formal', 'female-range', 'Middle-aged British woman; crisp RP accent, precise and formal.'],
  ['f_deep_smoky', 'female-range', 'Older woman with a deep, smoky, low-register female voice; jazz-club warmth.'],
  ['m_elder_uk', 'male-range', 'Elderly English man; gravelly, slow, gentle village voice.'],
  ['m_young_us', 'male-range', 'Young American man in his twenties; energetic, confident tenor.'],
  ['m_deep_narrator', 'male-range', 'Man with a deep, resonant bass narrator voice; slow and cinematic.'],
  ['m_light_tenor', 'male-range', 'Soft-spoken young man; light, high tenor male voice, shy delivery.'],
];
const LINE = 'The evening train rolled in right on time, and the whole town came out to see it.';

const t0 = Date.now();
const voices = Object.fromEntries(MATRIX.map(([id, , design]) => [id, { design }]));
const lines = MATRIX.map(([id]) => ({ id: `reg_${id}`, kind: 'dialogue', entity: id, text: LINE }));
console.log(`[regiment] ${MATRIX.length} designed voices, one line each — rendering (one batch)...`);
const wavs = await renderLines(lines, voices, 'out');

let failures = 0;
const report = [];
for (const [id, want] of MATRIX.map((r) => [r[0], r[1]])) {
  const wav = wavs[`reg_${id}`];
  const out = JSON.parse(execFileSync(pythonExe(), [path.resolve('engines/tts/pitch-check.py'), wav]).toString());
  const ok = out.register === want;
  if (!ok) failures++;
  report.push({ id, want, got: out.register, f0: out.f0_median, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id.padEnd(16)} want=${want.padEnd(13)} got=${out.register.padEnd(13)} f0=${out.f0_median}Hz`);
}
const elapsed = Math.round((Date.now() - t0) / 1000);
writeFileSync('out/voice-regiment-report.json', JSON.stringify({ date: new Date().toISOString(), elapsed, report }, null, 2));
console.log(`\n[regiment] ${MATRIX.length - failures}/${MATRIX.length} passed in ${elapsed}s -> out/voice-regiment-report.json`);
process.exit(failures ? 1 : 0);
