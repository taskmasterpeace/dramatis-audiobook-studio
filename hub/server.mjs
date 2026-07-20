#!/usr/bin/env node
// DRAMATIS Audio Hub — the API other apps and AGENTS call. v1: characters + speech.
//   node hub/server.mjs [--port 4701]
//
// This is deliberately a THIRD entry point beside the CLI and the Studio: the
// Studio stays a localhost cockpit for a human; the hub is a machine interface
// with tenancy from day one. It serves its own documentation (hub/agents.md) at
// GET / — an agent pointed at the URL learns the paid-for lessons, not just the
// endpoint shapes. That answers "how can another Claude Code know?": the API
// teaches its callers.
//
// Tenancy (minimum-regret shape, single-tenant reality): requests from
// localhost with no key are tenant "local" — Robert's own apps on the LAN pay
// zero friction. A Bearer key (sha256 -> tenant in hub/keys.json) scopes
// everything else; characters are ATTACHED TO THE KEY's tenant. Today only
// "local" has actors; the paths are tenant-shaped so multitenancy is a
// migration, not a rewrite.
import http from 'node:http';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadKeys } from '../src/keys.mjs';
import { ENGINE_IDS, ENGINES, loadRenderer } from '../engines/tts/registry.mjs';
import { ffprobeDuration } from '../src/util.mjs';

loadKeys();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, 'out');
const PORT = (() => { const i = process.argv.indexOf('--port'); return i > 0 ? +process.argv[i + 1] : 4701; })();
const AGENTS_MD = path.join(root, 'hub', 'agents.md');
const KEYS_FILE = path.join(root, 'hub', 'keys.json');

// ── tenancy ─────────────────────────────────────────────────────────────────
function tenantOf(req) {
  const auth = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/.exec(auth);
  if (m) {
    const hash = createHash('sha256').update(m[1].trim()).digest('hex');
    const keys = existsSync(KEYS_FILE) ? JSON.parse(readFileSync(KEYS_FILE, 'utf8')) : {};
    const entry = keys[hash];
    return entry ? entry.tenant : null;            // present but wrong -> null = 401
  }
  const ip = req.socket.remoteAddress || '';
  const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  return isLocal ? 'local' : null;                 // keyless is a localhost privilege
}

// tenant "local" owns the original actors/ dir; other tenants get a namespace.
// Slugs are validated everywhere they're used in a path.
const actorsDir = (tenant) => (tenant === 'local'
  ? path.join(root, 'actors')
  : path.join(root, 'actors-tenants', tenant));

// ── helpers ─────────────────────────────────────────────────────────────────
const json = (res, code, obj) => {
  const body = JSON.stringify(obj, null, 1);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
};
const readBody = (req) => new Promise((resolve, reject) => {
  let b = ''; req.on('data', (c) => { b += c; if (b.length > 2e6) reject(new Error('body too large')); });
  req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
  req.on('error', reject);
});

function listCharacters(tenant) {
  const dir = actorsDir(tenant);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((d) => statSync(path.join(dir, d)).isDirectory()).map((id) => {
    const f = (n) => path.join(dir, id, n);
    let origin = {};
    try { origin = JSON.parse(readFileSync(f('origin.json'), 'utf8')); } catch { /* sparse actor */ }
    return {
      id,
      seed: existsSync(f('seed.wav')),
      transcript: existsSync(f('transcript.txt')) ? readFileSync(f('transcript.txt'), 'utf8').trim().slice(0, 200) : '',
      origin_engine: origin.seed_engine || 'unknown',
      character: origin.character || '',
      consent: origin.consent || null,
    };
  });
}

// ── server ──────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  try {
    // the self-teaching page needs no auth — it IS the front door
    if (req.method === 'GET' && (p === '/' || p === '/agents.md')) {
      const md = readFileSync(AGENTS_MD);
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Length': md.length });
      return res.end(md);
    }
    if (req.method === 'GET' && p === '/v1/health') {
      return json(res, 200, { ok: true, engines: ENGINE_IDS });
    }

    const tenant = tenantOf(req);
    if (!tenant) return json(res, 401, { error: 'missing or unknown API key (localhost needs none)' });

    if (req.method === 'GET' && p === '/v1/characters') {
      return json(res, 200, { tenant, characters: listCharacters(tenant) });
    }

    if (req.method === 'POST' && p === '/v1/speech') {
      const { text, character_id, engine, voice, prompt, design } = await readBody(req);
      if (!text || !String(text).trim()) return json(res, 422, { error: 'text required' });

      let eng, voices, label;
      if (character_id) {
        const slug = String(character_id).toLowerCase();
        if (!/^[a-z0-9-]+$/.test(slug)) return json(res, 422, { error: 'bad character_id' });
        const dir = path.join(actorsDir(tenant), slug);
        const seed = path.join(dir, 'seed.wav');
        if (!existsSync(seed)) {
          return json(res, 404, { error: `no character '${slug}' for tenant '${tenant}' — GET /v1/characters for the roster` });
        }
        const tPath = path.join(dir, 'transcript.txt');
        eng = 'qwen3';   // the free lane: the character's own seed cloned locally
        voices = { narrator: { seed, transcript: existsSync(tPath) ? readFileSync(tPath, 'utf8').trim() : '' } };
        label = slug;
      } else {
        eng = engine || 'kokoro';
        if (!ENGINE_IDS.includes(eng)) return json(res, 422, { error: `engine must be one of: ${ENGINE_IDS.join(', ')}` });
        const lim = ENGINES[eng].limits;
        if (lim && !lim.chunked && String(text).length > lim.perCall) {
          return json(res, 422, { error: `${eng} caps at ~${lim.perCall} chars/request; kokoro, gemini and elevenlabs chunk any length` });
        }
        voices = {
          kokoro: { narrator: { voice: voice || 'af_heart', speed: 1 } },
          qwen3: { narrator: { design: design || voice || 'Clear natural narrator voice.' } },
          elevenlabs: { narrator: { candidates: [voice || 'George'], stability: 0.5 } },
          gemini: { narrator: { voice: voice || 'Charon', prompt: prompt || 'Synthesize this performance as speech. PERFORMANCE\nStyle: a natural, engaging narrator. Pace: even.' } },
        }[eng];
        label = voice || eng;
      }

      const renderLines = await loadRenderer(eng);
      const t0 = Date.now();
      const wavs = await renderLines(
        [{ id: 'hub', kind: 'narration', entity: 'narrator', text: String(text).trim() }],
        voices, OUT,
      );
      const file = wavs.hub;
      const wav = readFileSync(file);
      let secs = null;
      try { secs = +(await ffprobeDuration(file)).toFixed(1); } catch { /* non-fatal */ }
      res.writeHead(200, {
        'Content-Type': 'audio/wav',
        'Content-Length': wav.length,
        'X-Engine': eng,
        'X-Character': character_id || '',
        'X-Voice': label,
        'X-Cache': (Date.now() - t0) < 250 ? 'hit' : 'miss',
        'X-Seconds': secs ?? '',
      });
      return res.end(wav);
    }

    return json(res, 404, { error: `no route ${req.method} ${p} — GET / for the guide` });
  } catch (e) {
    return json(res, 500, { error: String(e.message).slice(0, 300) });
  }
});

server.listen(PORT, () => {
  console.log(`DRAMATIS hub  http://localhost:${PORT}  (GET / is the agent guide)`);
});
