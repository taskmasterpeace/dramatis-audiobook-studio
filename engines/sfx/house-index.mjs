#!/usr/bin/env node
// Index the house Foley library and merge it with the FSD50K index into
// corpus/index-all/ (single CLAP search space). Run after adding house clips:
//   node engines/sfx/house-index.mjs
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { pythonExe } from '../../src/util.mjs';

const root = path.resolve('.');
const HOUSE = path.join(root, 'corpus', 'house');
const FSD = path.join(root, 'corpus', 'fsd50k', 'index');
const MERGED = path.join(root, 'corpus', 'index-all');

// 1) house manifest -> FSD50K metadata shape (license text carries the
// "publicdomain-equivalent" marker the CC0 filter looks for — house clips are
// ElevenLabs-generated under the paid plan, owned output, commercial-ok)
const manifest = JSON.parse(readFileSync(path.join(HOUSE, 'house-manifest.json'), 'utf8'));
const info = {};
for (const [name, m] of Object.entries(manifest)) {
  info[name] = {
    title: `${name}.wav`, description: m.text, tags: ['house-foley', 'generated'],
    license: 'house foley (ElevenLabs-generated, commercial per plan) — publicdomain-equivalent in-house',
  };
}
const infoPath = path.join(HOUSE, 'house-clips-info.json');
writeFileSync(infoPath, JSON.stringify(info, null, 2));

// 2) embed the house clips
mkdirSync(path.join(HOUSE, 'index'), { recursive: true });
execFileSync(pythonExe(), [path.join(root, 'engines', 'sfx', 'clap-index.py'), HOUSE, infoPath, path.join(HOUSE, 'index')], { stdio: 'inherit' });

// 3) merge house + fsd50k -> corpus/index-all (numpy concat via python)
mkdirSync(MERGED, { recursive: true });
const py = `
import numpy as np, json, pathlib
fsd = pathlib.Path(${JSON.stringify(FSD)}); house = pathlib.Path(${JSON.stringify(path.join(HOUSE, 'index'))})
out = pathlib.Path(${JSON.stringify(MERGED)})
e1 = np.load(fsd / 'embeddings.npy'); e2 = np.load(house / 'embeddings.npy')
m1 = json.loads((fsd / 'manifest.json').read_text(encoding='utf-8'))
m2 = json.loads((house / 'manifest.json').read_text(encoding='utf-8'))
np.save(out / 'embeddings.npy', np.concatenate([e1, e2]))
(out / 'manifest.json').write_text(json.dumps(m1 + m2), encoding='utf-8')
print(f'[merge] {len(m1)} fsd50k + {len(m2)} house = {len(m1)+len(m2)} clips in index-all')
`;
execFileSync(pythonExe(), ['-c', py], { stdio: 'inherit' });
