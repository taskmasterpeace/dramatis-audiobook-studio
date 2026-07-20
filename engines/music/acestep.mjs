// ACE-Step 1.5 — the FREE, LOCAL underscore engine (MIT code AND MIT weights,
// both licence files read before this was wired; the model card states outputs
// are usable commercially). Runs as its own service because it keeps its own
// pinned Python world — point ACESTEP_DIR at a checkout of
// https://github.com/ACE-Step/ACE-Step-1.5 (installed with `uv sync`), or
// ACESTEP_URL at an already-running `uv run acestep-api` server.
//
// Contract: renderTrack(spec, durSec, cacheRoot) -> { file, engine, license }
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { contentKey, cached, ffmpeg, log } from '../../src/util.mjs';

const ENGINE = 'acestep@1';
const LICENSE = 'ACE-Step 1.5 (MIT, local) — outputs usable commercially per model card';
const URL = () => (process.env.ACESTEP_URL || 'http://localhost:8001').replace(/\/$/, '');

async function healthy(ms = 3000) {
  try {
    const r = await fetch(`${URL()}/v1/models`, { signal: AbortSignal.timeout(ms) });
    return r.ok;
  } catch { return false; }
}

// Start the sidecar on demand and wait for it. First-ever launch also downloads
// model weights, which can take minutes — hence the generous ceiling. The child
// is detached on purpose: music cues arrive one at a time across a render, and
// tearing the model out of VRAM between cues would make every cue pay the load.
let spawned = false;
async function ensureServer() {
  if (await healthy()) return;
  const dir = process.env.ACESTEP_DIR;
  if (!dir) {
    throw new Error('ACE-Step server not reachable. Start it (`uv run acestep-api` in your '
      + 'ACE-Step-1.5 checkout) or set ACESTEP_DIR so DRAMATIS can start it for you.');
  }
  if (!spawned) {
    spawned = true;
    log('music', `acestep: starting sidecar from ${dir} (first launch may download models)`);
    const child = spawn('uv', ['run', 'acestep-api'], {
      cwd: dir, detached: true, stdio: 'ignore', shell: process.platform === 'win32',
    });
    child.on('error', () => { spawned = false; });
    child.unref();
  }
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    if (await healthy()) return;
  }
  throw new Error('ACE-Step server did not become healthy within 5 minutes — '
    + 'run `uv run acestep-api` in the checkout to see what is wrong.');
}

// deterministic seed from the cache key, so identical cues reproduce
const seedFrom = (key) => parseInt(key.slice(0, 8), 16) % 2_147_483_647;

export async function renderTrack(spec, durSec, cacheRoot) {
  const dur = Math.min(600, Math.max(10, Math.round(durSec)));
  const key = contentKey([ENGINE, spec, String(dur)]);
  const { path: out, hit } = cached(cacheRoot, key);
  if (hit) return { file: out, engine: ENGINE, license: LICENSE };

  await ensureServer();

  // Same instrumental law as the ElevenLabs engine, belt and braces: the caption
  // says it AND lyrics are pinned to [Instrumental] — sung words under narration
  // break the cast-are-the-only-voices rule. CoT rewriting is off so the caption
  // we cached is the caption that rendered.
  const body = {
    prompt: `${spec}. Instrumental underscore only: no vocals, no singing, no humming, no spoken words. Low-key cinematic bed that sits under narration.`,
    lyrics: '[Instrumental]',
    thinking: false,
    use_cot_caption: false,
    use_cot_language: false,
    audio_format: 'wav',
    audio_duration: dur,
    inference_steps: 8,
    use_random_seed: false,
    seed: seedFrom(key),
    batch_size: 1,
    ...(process.env.ACESTEP_MODEL ? { model: process.env.ACESTEP_MODEL } : {}),
  };
  // The very first request after install can stall for MINUTES while the server
  // lazily pulls model weights (measured: an 8.4 GB download blocking the
  // request, which blew Node fetch's built-in body timeout). So: transient
  // network failures never kill a render — they retry inside one overall
  // deadline, generous enough to cover a first-run download.
  const DEADLINE = 20 * 60_000;
  const t0 = Date.now();
  let taskId = null;
  for (let attempt = 1; !taskId; attempt++) {
    if (Date.now() - t0 > DEADLINE) throw new Error('acestep: could not submit task within 20 min');
    try {
      const rel = await fetch(`${URL()}/release_task`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!rel.ok) throw new Error(`release_task ${rel.status}: ${(await rel.text()).slice(0, 160)}`);
      const relJson = await rel.json();
      taskId = typeof relJson.data === 'string' ? relJson.data
        : relJson.data?.task_id || relJson.data?.taskId;
      if (!taskId) throw new Error(`no task id in response: ${JSON.stringify(relJson).slice(0, 160)}`);
    } catch (e) {
      log('music', `acestep submit retry ${attempt} (${String(e.message || e).slice(0, 90)}) — `
        + 'first run downloads models; this can take a while');
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  let entry = null;
  for (;;) {
    if (Date.now() - t0 > DEADLINE) throw new Error('acestep generation timeout (20 min)');
    await new Promise((r) => setTimeout(r, 2000));
    let q;
    try {
      q = await fetch(`${URL()}/query_result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task_id_list: [taskId] }),
      });
    } catch { continue; }   // transient — the deadline above is the real limit
    if (!q.ok) continue;
    const d = (await q.json()).data?.[0];
    if (!d) continue;
    if (d.status === 2) throw new Error(`acestep generation failed: ${String(d.result).slice(0, 160)}`);
    if (d.status === 1) {
      const results = typeof d.result === 'string' ? JSON.parse(d.result) : d.result;
      entry = Array.isArray(results) ? results[0] : results;
      break;
    }
  }
  const fileUrl = entry?.file;
  if (!fileUrl) throw new Error('acestep: succeeded but returned no file');
  const audio = await fetch(fileUrl.startsWith('http') ? fileUrl : `${URL()}${fileUrl}`);
  if (!audio.ok) throw new Error(`acestep audio download ${audio.status}`);
  const src = out.replace(/\.wav$/, '.src.wav');
  writeFileSync(src, Buffer.from(await audio.arrayBuffer()));
  await ffmpeg(['-i', src, '-ar', '48000', '-ac', '2', out]);
  log('music', `acestep track (${dur}s, seed ${body.seed}) for "${spec.slice(0, 50)}" in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return { file: out, engine: ENGINE, license: LICENSE };
}
