#!/usr/bin/env node
// One-time model setup for the free local path. Cross-platform, zero deps.
//   node scripts/setup-models.mjs
//
// This replaces a PowerShell-only script that Linux and macOS users could not
// run — and that the published README never mentioned, so a fresh clone hit a
// FileNotFoundError on a model file it had no way to know it needed.
import { mkdirSync, existsSync, createWriteStream, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { get } from 'node:https';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'models', 'kokoro');
const BASE = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0';
const FILES = [
  ['kokoro-v1.0.onnx', 310_000_000],
  ['voices-v1.0.bin', 27_000_000],
];

function download(url, dest, expectBytes) {
  return new Promise((resolve, reject) => {
    const req = get(url, { headers: { 'User-Agent': 'dramatis-setup' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return download(res.headers.location, dest, expectBytes).then(resolve, reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      const total = Number(res.headers['content-length']) || expectBytes;
      let got = 0, lastPct = -1;
      const file = createWriteStream(dest);
      res.on('data', (c) => {
        got += c.length;
        const pct = Math.floor((got / total) * 100);
        if (pct !== lastPct && pct % 5 === 0) { process.stdout.write(`\r  ${pct}%   `); lastPct = pct; }
      });
      res.pipe(file);
      file.on('finish', () => file.close(() => { process.stdout.write('\r  100%  \n'); resolve(); }));
      file.on('error', reject);
    });
    req.on('error', reject);
  });
}

const python = process.platform === 'win32' ? '.venv\\Scripts\\python.exe' : '.venv/bin/python';

console.log('DRAMATIS — model setup for the free local path\n');
mkdirSync(dir, { recursive: true });

for (const [name, size] of FILES) {
  const dest = path.join(dir, name);
  if (existsSync(dest) && statSync(dest).size > size * 0.9) {
    console.log(`✓ ${name} already present`);
    continue;
  }
  console.log(`downloading ${name} (~${Math.round(size / 1e6)} MB)…`);
  await download(`${BASE}/${name}`, dest, size);
  console.log(`✓ ${name}`);
}

console.log(`
Models ready in models/kokoro/.

Still needed for the free path — the Python side:
  uv venv --python 3.12 .venv
  uv pip install --python ${python} kokoro-onnx soundfile onnxruntime

Then produce a book:
  node bin/dramatis.mjs produce books/open-window/book.json --tts kokoro

Check everything at once with:
  node bin/dramatis.mjs doctor
`);
