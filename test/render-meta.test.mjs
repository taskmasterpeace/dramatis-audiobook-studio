// The generation-record collector: every engine reports {engine, engineTag,
// voiceKey, key} for every line it touches, at the same moment it computes the
// cache key — cache HITS included. Without this the manifest can't say what an
// exported clip is, and Directors Desktop is back to mystery wavs.
//
// The tests pre-seed the content-addressed cache so renderLines never spawns
// python or hits a network: a hit exercises the exact code path (key
// computation precedes the cache check) at zero cost.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { contentKey, speakable } from '../src/util.mjs';
import { renderLines as kokoroRender } from '../engines/tts/kokoro.mjs';
import { renderLines as qwen3Render } from '../engines/tts/qwen3.mjs';

const ROOT = path.join(tmpdir(), 'ams-render-meta-test');

test.before(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(path.join(ROOT, 'cache'), { recursive: true });
});
test.after(() => rmSync(ROOT, { recursive: true, force: true }));

function seedCache(key) {
  const p = path.join(ROOT, 'cache', `${key}.wav`);
  writeFileSync(p, Buffer.from('RIFF fake'));
  return p;
}

test('kokoro fills the collector on a cache hit', async () => {
  const line = { id: 'lin_0001', entity: 'narrator', text: 'The night was cold.' };
  const voices = { narrator: { voice: 'am_michael', speed: 1 } };
  const key = contentKey(['kokoro-onnx@2', 'am_michael', '1', speakable(line.text)]);
  seedCache(key);

  const meta = {};
  const out = await kokoroRender([line], voices, ROOT, meta);
  assert.ok(out.lin_0001.endsWith(`${key}.wav`));
  assert.deepEqual(meta.lin_0001, { engine: 'kokoro', engineTag: 'kokoro-onnx@2', voiceKey: 'am_michael', key });
});

test('qwen3 fills the collector, direction included, on a cache hit', async () => {
  const line = { id: 'lin_0002', entity: 'liu', text: '"You dare!"', emotion: { anger: 0.8 } };
  const voices = { liu: { design: 'a stern general' } };
  const ins = 'Speak with a very angry tone.'; // instruct() at anger 0.8
  const key = contentKey(['qwen3-tts@1', 'a stern general', ins, speakable(line.text)]);
  seedCache(key);

  const meta = {};
  await qwen3Render([line], voices, ROOT, meta);
  assert.equal(meta.lin_0002.engine, 'qwen3');
  assert.equal(meta.lin_0002.voiceKey, 'a stern general');
  assert.equal(meta.lin_0002.direction, ins);
  assert.equal(meta.lin_0002.key, key);
});

test('the collector is optional — no meta argument, no behavior change', async () => {
  const line = { id: 'lin_0003', entity: 'narrator', text: 'Still fine without it.' };
  const voices = { narrator: { voice: 'am_michael', speed: 1 } };
  seedCache(contentKey(['kokoro-onnx@2', 'am_michael', '1', speakable(line.text)]));
  const out = await kokoroRender([line], voices, ROOT);
  assert.ok(out.lin_0003, 'legacy callers (say/audition/casting) pass no collector and must not break');
});
