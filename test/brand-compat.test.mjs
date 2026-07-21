import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(root, file), 'utf8');

test('package exposes the new command and keeps the legacy command', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.name, 'audiomoviestudio');
  assert.match(pkg.description, /Audio Movie Studio/);
  assert.equal(pkg.bin.audiomoviestudio, 'bin/dramatis.mjs');
  assert.equal(pkg.bin.dramatis, 'bin/dramatis.mjs');
});

test('compatibility-sensitive identifiers survive the visual rebrand', () => {
  assert.match(read('src/util.mjs'), /DRAMATIS_PYTHON/);
  assert.match(read('src/keys.mjs'), /DRAMATIS_ENV_FILES/);
  assert.match(read('engines/music/index.mjs'), /DRAMATIS_MUSIC/);
  assert.match(read('README.md'), /legacy `dramatis` command/);
});

test('installer and launchers use the Audio Movie Studio display name', () => {
  assert.match(read('installer/dramatis-setup.iss'), /#define MyAppName "Audio Movie Studio"/);
  assert.match(read('start-studio.cmd'), /title Audio Movie Studio/);
  assert.match(read('installer/launch.cmd'), /Audio Movie Studio/);
});
