#!/usr/bin/env node
// Usage-ledger report: who did we call, for what, and what did it cost.
//   node scripts/ledger-report.mjs [book-id]   (default: all books under out/)
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const outRoot = path.resolve(process.argv[2] ? `out/${process.argv[2]}` : 'out');
const files = process.argv[2]
  ? [path.join(outRoot, 'llm-ledger.jsonl')]
  : readdirSync(outRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(outRoot, d.name, 'llm-ledger.jsonl'));

const rows = [];
for (const f of files) {
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (line.trim()) rows.push(JSON.parse(line));
  }
}

const by = {};
let cost = 0;
for (const r of rows) {
  const k = `${r.provider}/${r.model} :: ${r.purpose}`;
  by[k] ??= { calls: 0, tokensIn: 0, tokensOut: 0, cost: 0 };
  by[k].calls++;
  by[k].tokensIn += r.tokens_in || 0;
  by[k].tokensOut += r.tokens_out || 0;
  by[k].cost += r.cost_usd || 0;
  cost += r.cost_usd || 0;
}

console.log(`${rows.length} LLM calls, $${cost.toFixed(4)} total spend\n`);
for (const [k, v] of Object.entries(by).sort((a, b) => b[1].calls - a[1].calls)) {
  console.log(`${k}\n  ${v.calls} calls · ${v.tokensIn.toLocaleString()} in / ${v.tokensOut.toLocaleString()} out · $${v.cost.toFixed(4)}`);
}
