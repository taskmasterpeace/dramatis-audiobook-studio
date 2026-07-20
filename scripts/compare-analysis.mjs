#!/usr/bin/env node
// Compare an analyzer output against a reference Production Script.
//   node scripts/compare-analysis.mjs <analysis.json> <production-script.json>
// Reports: cast overlap, dialogue attribution agreement, scene/cue counts.
import { readFileSync } from 'node:fs';

const [analysisPath, refPath] = process.argv.slice(2);
if (!analysisPath || !refPath) {
  console.log('usage: node scripts/compare-analysis.mjs <analysis.json> <production-script.json>');
  process.exit(1);
}
const a = JSON.parse(readFileSync(analysisPath, 'utf8'));
const r = JSON.parse(readFileSync(refPath, 'utf8'));

const aEnts = new Set(a.entities.map((e) => e.id));
const rEnts = new Set(r.entities.map((e) => e.id));
const found = [...rEnts].filter((e) => aEnts.has(e));
console.log(`cast: analyzer found ${aEnts.size}, reference has ${rEnts.size}, overlap ${found.length}: ${found.join(', ') || '(none)'}`);
console.log(`  missing from analysis: ${[...rEnts].filter((e) => !aEnts.has(e)).join(', ') || '(none)'}`);
console.log(`  extra in analysis:     ${[...aEnts].filter((e) => !rEnts.has(e)).join(', ') || '(none)'}`);

// attribution: join on text (ids differ across compilers)
const refByText = {};
for (const s of r.scenes) for (const l of s.lines) if (l.kind === 'dialogue') refByText[l.text] = l;
const aLines = a.scenes.flatMap((s) => s.lines).filter((l) => l.kind === 'dialogue');
let agree = 0, compared = 0;
const misses = [];
for (const l of aLines) {
  const ref = refByText[l.text];
  if (!ref) continue;
  compared++;
  if (ref.entity === l.entity) agree++;
  else misses.push(`  "${l.text.slice(0, 50)}…" analysis=${l.entity} ref=${ref.entity}`);
}
console.log(`attribution: ${agree}/${compared} dialogue lines agree (${compared ? Math.round((100 * agree) / compared) : 0}%)`);
if (misses.length) console.log(misses.join('\n'));

console.log(`scenes: analysis ${a.scenes.length} vs reference ${r.scenes.length}`);
console.log(`cues: analysis ${a.cues.length} vs reference ${r.cues.length}`);
if (a.reviewQueue?.length) console.log(`review queue: ${a.reviewQueue.length} items`);
console.log(`emotions assigned: ${aLines.filter((l) => l.emotion).length}/${aLines.length} dialogue lines`);
