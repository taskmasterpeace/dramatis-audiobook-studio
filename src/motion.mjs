// Motion-comic stage: Production Script + timing -> Directors Palette art ->
// chapter MP4 (panels timed to the immersive master, Ken Burns moves, x-fades).
//   node bin/dramatis.mjs motion books/liu-xiao/book.json --chapter 1
// Art is content-addressed (cast manifest + panel prompts cached on disk);
// the DP API is the only spend, logged per call.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import { createWriteStream } from 'node:fs';
import { postJson } from './llm.mjs';
import { contentKey, ensureDir, ffmpeg, ffprobeDuration, log } from './util.mjs';

// no default: this is a self-hosted image service, so the endpoint belongs in
// your own config rather than baked into the source
const DP_BASE = process.env.DP_BASE_URL;
// default look for generated panels; override per book via book.json style
const STYLE = process.env.DRAMATIS_ART_STYLE
  || 'Stylized comic book illustration, dark cinematic lighting, graphic novel realism, bold shadows, NOT photorealistic';
const W = 1920, H = 1080, FPS = 30, XFADE = 1.0;

function dpKey() {
  const key = process.env.DP_API_KEY;
  if (!key) throw new Error('DP_API_KEY not set');
  if (!DP_BASE) throw new Error('DP_BASE_URL not set — point it at your image service');
  return key;
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, (res) => {
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

async function dpJob(kind, apiPath, body, pollSec = 10, maxWaitMin = 12) {
  const res = await postJson(`${DP_BASE}${apiPath}`, { authorization: `Bearer ${dpKey()}` }, body);
  if (res.status >= 400) throw new Error(`dp ${kind} submit ${res.status}: ${res.text.slice(0, 200)}`);
  const data = JSON.parse(res.text).data;
  // character generation returns {turnaround, expressions}; single jobs return a job object
  const jobs = data.turnaround ? [data.turnaround, data.expressions] : [data];
  const ids = jobs.map((j) => j.job_id);
  log('motion', `${kind}: ${ids.length} job(s) ${ids.map((i) => i.slice(0, 8)).join(', ')}`);
  const t0 = Date.now();
  const urls = [];
  for (const id of ids) {
    for (;;) {
      if (Date.now() - t0 > maxWaitMin * 60000) throw new Error(`dp job ${id} timeout`);
      await new Promise((r) => setTimeout(r, pollSec * 1000));
      const jr = await fetch(`${DP_BASE}/api/v2/jobs/${id}`, { headers: { authorization: `Bearer ${dpKey()}` } });
      const jd = (await jr.json()).data;
      if (jd.status === 'completed') { urls.push(jd.result.url || jd.result.image_url || jd.result.video_url); break; }
      if (jd.status === 'failed') throw new Error(`dp job ${id} failed: ${jd.error_message}`);
    }
  }
  return urls;
}

// -- cast sheets: one turnaround + expressions per character, cached ----------

async function ensureCast(entities, castDir) {
  const manifestPath = path.join(castDir, 'cast.json');
  const cast = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
  for (const e of entities) {
    if (e.kind !== 'character' || !e.visual || cast[e.id]?.turnaround) continue;
    const [turn, expr] = await dpJob('character', '/api/v2/characters/generate', {
      name: e.visualName || e.id, description: e.visual, style: STYLE, aspect_ratio: '16:9',
    });
    const tFile = path.join(castDir, `${e.id}_turnaround.png`);
    const xFile = path.join(castDir, `${e.id}_expressions.png`);
    await download(turn, tFile);
    await download(expr, xFile);
    cast[e.id] = { turnaround: turn, expressions: expr, local: tFile };
    writeFileSync(manifestPath, JSON.stringify(cast, null, 2));
    log('motion', `cast ${e.id} sheeted`);
  }
  return cast;
}

// -- scene panels: one per scene, character-referenced -----------------------

async function ensurePanels(scenes, cast, panelDir) {
  const panels = [];
  for (const scene of scenes) {
    const promptText = `${scene.env?.location || 'scene'}, ${scene.env?.mood || ''}: ${scene.visual || scene.id}. ` +
      `${scene.env?.weather || ''} ${scene.env?.time || ''}`.trim();
    const key = contentKey(['panel@1', promptText, STYLE]);
    const file = path.join(panelDir, `${scene.id}-${key}.png`);
    if (!existsSync(file)) {
      // reference the lead character's sheet when one is tagged in the scene
      const refs = (scene.characters || []).map((id) => cast[id]?.turnaround).filter(Boolean);
      const prompt = `${promptText} Style: ${STYLE}`;
      const [url] = await dpJob('panel', '/api/v2/images/generate', {
        model: 'nano-banana-2', prompt, aspect_ratio: '16:9',
        ...(refs.length ? { reference_image: refs[0] } : {}),
      });
      await download(url, file);
      log('motion', `panel ${scene.id}`);
    }
    panels.push({ scene: scene.id, file });
  }
  return panels;
}

// -- assemble: zoompan per panel across its scene span, xfade, mux audio -----

async function assemble(panels, spans, audioFile, outFile) {
  const segs = [];
  for (let i = 0; i < panels.length; i++) {
    const dur = spans[i].dur;
    const frames = Math.ceil(dur * FPS);
    // alternate push-in / pull-out for variety (zoompan evaluates z per frame)
    const zoom = i % 2 === 0
      ? `z='min(zoom+0.0006,1.15)'`
      : `z='max(1.15-0.0006*on,1.0)'`;
    const seg = path.join(path.dirname(outFile), `_seg${i}.mp4`);
    await ffmpeg([
      '-loop', '1', '-t', dur.toFixed(2), '-i', panels[i].file,
      '-vf', `scale=2560:1440:force_original_aspect_ratio=increase,crop=2560:1440,zoompan=${zoom}:d=${frames}:s=${W}x${H}:fps=${FPS},format=yuv420p`,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', seg,
    ]);
    segs.push(seg);
  }
  // concat with xfade
  let filter = '';
  let prev = '[0:v]';
  for (let i = 1; i < segs.length; i++) {
    const off = spans.slice(0, i).reduce((a, s) => a + s.dur, 0) - XFADE * i;
    filter += `${prev}[${i}:v]xfade=transition=fade:duration=${XFADE}:offset=${off.toFixed(2)}[x${i}];`;
    prev = `[x${i}]`;
  }
  const args = [];
  for (const s of segs) args.push('-i', s);
  args.push('-i', audioFile);
  if (filter) args.push('-filter_complex', filter.slice(0, -1), '-map', prev);
  else args.push('-map', '0:v');
  args.push('-map', `${segs.length}:a`, '-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
    '-c:a', 'aac', '-b:a', '160k', '-shortest', outFile);
  await ffmpeg(args);
  for (const s of segs) { try { (await import('node:fs')).unlinkSync(s); } catch {} }
}

// -- entry: one chapter -> mp4 -------------------------------------------------

export async function motionChapter({ book, chapterCfg, n, outRoot }) {
  const chOut = path.join(outRoot, `ch-${String(n).padStart(2, '0')}`);
  const script = JSON.parse(readFileSync(path.join(chOut, 'production-script.json'), 'utf8'));
  const timing = JSON.parse(readFileSync(path.join(chOut, 'timing.json'), 'utf8'));
  const audio = path.join(chOut, 'immersive.m4a');
  if (!existsSync(audio)) throw new Error(`missing ${audio} — produce the chapter first`);

  const motionDir = ensureDir(path.join(outRoot, 'motion'));
  const cast = await ensureCast(book.entities, ensureDir(path.join(motionDir, 'characters')));

  // attach book.json scene visuals + characters to the compiled scenes
  const sceneCfg = Object.fromEntries((chapterCfg.scenes || []).map((s) => [s.id, s]));
  const scenes = script.scenes.map((s) => ({
    ...s, visual: sceneCfg[s.id]?.visual, characters: sceneCfg[s.id]?.characters || [],
  }));
  const panels = await ensurePanels(scenes, cast, ensureDir(path.join(motionDir, `ch-${String(n).padStart(2, '0')}`)));

  // scene spans from line timings: first line start -> next scene's first line
  const lineStart = Object.fromEntries(timing.lines.map((l) => [l.id, l.start]));
  const lineEnd = Object.fromEntries(timing.lines.map((l) => [l.id, l.start + l.dur]));
  const starts = scenes.map((s) => Math.min(...s.lines.map((l) => lineStart[l.id] ?? Infinity)));
  const spans = scenes.map((s, i) => {
    const start = starts[i];
    const end = i + 1 < scenes.length ? starts[i + 1] : Math.max(...s.lines.map((l) => lineEnd[l.id] ?? 0)) + 2;
    return { start, dur: Math.max(2, end - start) };
  });

  const outFile = path.join(motionDir, `ch-${String(n).padStart(2, '0')}.mp4`);
  await assemble(panels, spans, audio, outFile);
  const dur = await ffprobeDuration(outFile);
  log('motion', `${outFile} — ${panels.length} panels, ${Math.round(dur / 60)} min`);
  return { file: outFile, panels: panels.length, durationSec: dur };
}
