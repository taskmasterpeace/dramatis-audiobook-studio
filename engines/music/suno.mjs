// Music engine — muapi.ai Suno relay (instrumental underscore only).
// NOTE: muapi is an unofficial Suno relay; commercial licensing of output is
// unresolved (see SPEC §7 music). Fine for previews/scratch; resolve before
// selling a finished book. Engine is a slot: swap in elevenlabs-music or
// ACE-Step (local, Apache-2.0) behind the same renderTrack() contract.
import https from 'node:https';
import http from 'node:http';
import { createWriteStream } from 'node:fs';
import { contentKey, cached, ffmpeg, log } from '../../src/util.mjs';

const ENGINE = 'suno-muapi@1';
const LICENSE = 'unverified (Suno via muapi relay) — preview use only';
const HOST = 'api.muapi.ai';

function apiKey() {
  const key = process.env.MUAPI_API_KEY;
  if (!key) throw new Error('MUAPI_API_KEY not set');
  return key;
}

function request(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: HOST, path: apiPath, method,
      headers: { 'x-api-key': apiKey(), 'content-type': 'application/json',
        ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) },
      timeout: 60000,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode, body: buf }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    if (data) req.write(data);
    req.end();
  });
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, { headers: { 'user-agent': 'Mozilla/5.0', accept: '*/*' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return download(res.headers.location, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`download HTTP ${res.statusCode}`));
      const f = createWriteStream(dest);
      res.pipe(f);
      f.on('finish', () => f.close(resolve));
    }).on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// renderTrack(spec, durSec, cacheRoot) -> { file, engine, license }
export async function renderTrack(spec, durSec, cacheRoot) {
  const key = contentKey([ENGINE, spec, String(durSec || 0)]);
  const { path: out, hit } = cached(cacheRoot, key);
  if (hit) return { file: out, engine: ENGINE, license: LICENSE };

  const submit = await request('POST', '/api/v1/suno-create-music', {
    prompt: `${spec}, instrumental, no vocals, cinematic audiobook underscore`,
    style: 'Cinematic', instrumental: true,
    duration: durSec || 120, model: 'V5',
  });
  if (submit.status >= 400) throw new Error(`suno submit ${submit.status}: ${JSON.stringify(submit.body).slice(0, 200)}`);
  const reqId = submit.body?.request_id || submit.body?.id || submit.body?.data?.request_id;
  if (!reqId) throw new Error(`suno: no request_id in ${JSON.stringify(submit.body).slice(0, 200)}`);
  log('music', `suno job ${reqId} (~${Math.ceil((durSec || 120) / 60)} min track, 1-3 min wait)`);

  let urls = null;
  for (let i = 0; i < 75 && !urls; i++) {
    await sleep(8000);
    const res = await request('GET', `/api/v1/predictions/${reqId}/result`);
    const b = res.body || {};
    const status = b.status || b.data?.status;
    if (status === 'completed' || status === 'success' || status === 'succeeded') {
      urls = b.outputs || b.data?.outputs || (b.output?.audio ? [b.output.audio] : null);
    } else if (status === 'failed' || status === 'error') {
      throw new Error(`suno job failed: ${JSON.stringify(b).slice(0, 300)}`);
    }
  }
  if (!urls?.length) throw new Error('suno: poll timeout / no audio urls');

  const mp3 = out.replace(/\.wav$/, '.tmp.mp3');
  await download(urls[0], mp3);
  await ffmpeg(['-i', mp3, '-ar', '48000', '-ac', '1', '-t', String(durSec || 120), out]);
  return { file: out, engine: ENGINE, license: LICENSE };
}
