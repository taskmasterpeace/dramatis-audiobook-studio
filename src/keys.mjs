// API keys, loaded once at boot and never printed.
//
// Precedence: real environment > .env.local > .env > anything listed in
// DRAMATIS_ENV_FILES (a ';' or ',' separated path list, so you can point at a
// key store you already keep elsewhere without hard-coding a directory layout).
//
// This lived only in studio/server.mjs, so the CLI never read .env at all —
// `dramatis produce --tts gemini` failed with "REPLICATE_API_TOKEN not set" on a
// machine whose .env had it. Both entry points share this now.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const KEY_NAMES = [
  'ELEVENLABS_API_KEY', 'OPENROUTER_API_KEY', 'REPLICATE_API_TOKEN', 'GEMINI_API_KEY',
];

export function loadKeys() {
  const extra = (process.env.DRAMATIS_ENV_FILES || '').split(/[;,]/).map((s) => s.trim()).filter(Boolean);
  for (const file of [path.join(root, '.env.local'), path.join(root, '.env'), ...extra]) {
    if (!existsSync(file)) continue;
    const txt = readFileSync(file, 'utf8');
    for (const n of KEY_NAMES) {
      if (process.env[n]) continue;
      const m = txt.match(new RegExp(`^${n}=(.*)$`, 'm'));
      if (m) process.env[n] = m[1].trim().replace(/\r$/, '');
    }
  }
}
