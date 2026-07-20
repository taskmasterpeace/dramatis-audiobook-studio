#!/usr/bin/env node
// DRAMATIS — free text → mp3, with a timer. Local Kokoro, $0, no API.
//   node say.mjs "Your text here"
//   node say.mjs --file story.txt --voice af_sarah -o out.mp3
//   node say.mjs "Hi there" --engine qwen3 --design "young excited woman"
// Voices: kokoro presets (bm_george default, af_sarah, am_onyx, af_nicole …).
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const flag = (n) => args.includes(`--${n}`);

const file = opt('file', null);
let text = file ? readFileSync(path.resolve(file), 'utf8') : args.filter((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== `--file` && args[args.indexOf(a) - 1] !== '--voice' && args[args.indexOf(a) - 1] !== '-o' && args[args.indexOf(a) - 1] !== '--engine' && args[args.indexOf(a) - 1] !== '--design').join(' ');
text = (text || '').trim();
if (!text) {
  console.log('usage: node say.mjs "text"  [--file f.txt] [--voice bm_george] [--engine kokoro|qwen3] [--design "persona"] [-o out.mp3]');
  process.exit(1);
}

const engine = opt('engine', 'kokoro');
const voice = opt('voice', 'bm_george');
const design = opt('design', null);
const oi = args.indexOf('-o');
mkdirSync('out/say', { recursive: true });
const stamp = String(process.hrtime.bigint()).slice(-8);
const out = oi >= 0 ? args[oi + 1] : `out/say/say-${stamp}.mp3`;

const eng = { kokoro: './engines/tts/kokoro.mjs', qwen3: './engines/tts/qwen3.mjs' }[engine];
if (!eng) { console.log('engine must be kokoro or qwen3 (the free/local ones)'); process.exit(1); }

console.log(`\n🎙  DRAMATIS say — ${text.length} chars, engine=${engine}, voice=${design ? 'design' : voice}`);
const t0 = Date.now();
const { renderLines } = await import(eng);
const voices = engine === 'qwen3'
  ? { narrator: { design: design || `Clear natural narrator voice.` } }
  : { narrator: { voice, speed: +opt('speed', 1) } };
const wavs = await renderLines([{ id: 'say', kind: 'narration', entity: 'narrator', text }], voices, 'out');
const wav = wavs.say;
execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', wav, '-c:a', 'libmp3lame', '-q:a', '2', out]);
const renderSec = (Date.now() - t0) / 1000;
const audioSec = parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out]).toString().trim());

console.log(`\n  ⏱  rendered in ${renderSec.toFixed(1)}s`);
console.log(`  🔊 ${audioSec.toFixed(1)}s of audio  (${(audioSec / renderSec).toFixed(1)}× realtime)`);
console.log(`  💵 $0.00 — local, free`);
console.log(`  📄 ${out}\n`);
