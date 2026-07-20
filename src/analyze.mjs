// Analyzer: raw manuscript chapter -> cited Production Script, LLM-driven.
// Four ledgered purposes: entities -> scenes -> sfx-cues -> attribution.
// The deterministic compiler provides draft segmentation + attribution; the
// LLM discovers the cast, scenes, and cues, then verifies each dialogue
// speaker and assigns emotions. Low-confidence calls land in a review queue
// instead of being silently asserted (spec principle 2).
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chapterParagraphs, listChapters, compile } from './compile.mjs';
import { analyze } from './llm.mjs';
import { ensureDir, log } from './util.mjs';

const SYSTEM = 'You are a meticulous audiobook production analyst. You answer with JSON only, grounded strictly in the provided text. Never invent characters, scenes, or sounds that are not evidenced by the text.';

const AMBIENCE_TYPES = ['rain', 'crowd', 'city-night', 'lab-cold', 'battle', 'room-hum', 'roomtone-morning', 'silence'];
const EMOTION_KEYS = ['anger', 'fear', 'sadness', 'joy', 'surprise', 'disgust', 'tenderness', 'curiosity'];

const SCHEMAS = {
  entities: {
    type: 'object', required: ['entities'],
    properties: {
      entities: {
        type: 'array', items: {
          type: 'object', required: ['id', 'kind', 'names'],
          properties: {
            id: { type: 'string', description: 'short lowercase snake_case id' },
            kind: { type: 'string', enum: ['character', 'narrator'] },
            names: { type: 'array', items: { type: 'string' }, description: 'every name/alias used in the text' },
            description: { type: 'string' },
          },
        },
      },
    },
  },
  scenes: {
    type: 'object', required: ['scenes'],
    properties: {
      scenes: {
        type: 'array', items: {
          type: 'object', required: ['start_para', 'location', 'ambience_type', 'intensity'],
          properties: {
            start_para: { type: 'integer' },
            location: { type: 'string' },
            time: { type: 'string' }, weather: { type: 'string' }, mood: { type: 'string' },
            ambience_type: { type: 'string', enum: AMBIENCE_TYPES },
            intensity: { type: 'number', description: '0.0-1.0' },
          },
        },
      },
    },
  },
  cues: {
    type: 'object', required: ['cues'],
    properties: {
      cues: {
        type: 'array', items: {
          type: 'object', required: ['para', 'anchor_text', 'sfx', 'gain_db'],
          properties: {
            para: { type: 'integer' },
            anchor_text: { type: 'string', description: 'exact substring of the paragraph the sound belongs to' },
            sfx: { type: 'string', description: 'short sound description, e.g. "distant thunder", "wooden door slams"' },
            gain_db: { type: 'number' }, dur: { type: 'number' },
          },
        },
      },
    },
  },
  attribution: {
    type: 'object', required: ['lines'],
    properties: {
      lines: {
        type: 'array', items: {
          type: 'object', required: ['line_id', 'entity', 'confidence'],
          properties: {
            line_id: { type: 'string' },
            entity: { type: 'string' },
            confidence: { type: 'number' },
            emotion: { type: ['object', 'null'], description: `subset of {${EMOTION_KEYS.join(',')}} with 0-1 intensities, or null if neutral` },
          },
        },
      },
    },
  },
};

const numbered = (paragraphs) =>
  paragraphs.map((p, i) => `[${i}] ${p.text}`).join('\n\n');

export async function analyzeChapter({ manuscriptPath, bookId, chapter, cacheRoot, provider }) {
  const headings = listChapters(manuscriptPath);
  const heading = chapter ? (isNaN(+chapter) ? chapter : headings[+chapter - 1]) : headings[0];
  if (!heading) throw new Error(`no such chapter: ${chapter}`);
  const { chapterTitle, paragraphs } = chapterParagraphs(manuscriptPath, heading);
  const scope = { book: bookId, chapter: heading };
  const opts = { cacheRoot, scope, provider, system: SYSTEM };
  log('analyze', `${chapterTitle}: ${paragraphs.length} paragraphs`);

  // A: cast discovery
  const { data: ent } = await analyze({
    ...opts, purpose: 'entities', schema: SCHEMAS.entities,
    prompt: `Chapter "${chapterTitle}" of a novel, paragraphs numbered:\n\n${numbered(paragraphs)}\n\n` +
      'List every character who speaks or is significantly present. Rules: use the SHORTEST distinctive name as id (single lowercase word, "liu" not "liu_xiao"); give every name/alias exactly as written and a one-line description; do NOT create entities for people only mentioned in memory or hearsay who never speak or act on-page; merge role labels ("the guard", "the tourist") as entities only when they actually speak. Include a "narrator" entity (kind narrator, no names).',
  });
  const entities = ent.entities.filter((e, i, a) => a.findIndex((x) => x.id === e.id) === i);
  if (!entities.some((e) => e.id === 'narrator')) entities.unshift({ id: 'narrator', kind: 'narrator', names: [] });
  const roster = entities.map((e) => `${e.id} (${e.kind}): ${(e.names || []).join(', ')}`).join('\n');

  // B: scene segmentation
  const { data: scn } = await analyze({
    ...opts, purpose: 'scenes', schema: SCHEMAS.scenes,
    prompt: `Chapter "${chapterTitle}", paragraphs numbered:\n\n${numbered(paragraphs)}\n\n` +
      `Split it into scenes (location/time changes). For each: start_para (first paragraph index), location/time/weather/mood, an ambience bed type from ${AMBIENCE_TYPES.join('|')}, and intensity 0-1. First scene must start at paragraph 0. Cover the whole chapter with ascending, non-overlapping scenes.`,
  });
  const seen = new Set();
  const scenes = scn.scenes
    .map((s) => ({ ...s, start_para: Math.trunc(+s.start_para) }))
    .filter((s) => Number.isFinite(s.start_para) && s.start_para >= 0 && s.start_para < paragraphs.length)
    .sort((a, b) => a.start_para - b.start_para)
    .filter((s) => !seen.has(s.start_para) && seen.add(s.start_para));
  if (!scenes.length || scenes[0].start_para !== 0) {
    scenes.unshift({ start_para: 0, location: 'unspecified', ambience_type: 'room-hum', intensity: 0.3 });
  }

  // C: SFX cues
  const { data: cue } = await analyze({
    ...opts, purpose: 'sfx-cues', schema: SCHEMAS.cues,
    prompt: `Chapter "${chapterTitle}", paragraphs numbered:\n\n${numbered(paragraphs)}\n\n` +
      'Find every explicit sound event in the prose (things a reader would HEAR: impacts, weather bursts, doors, machines, screams, vehicles). For each: para index, anchor_text (exact short substring of that paragraph), a short sfx description, gain_db (-2 loud to -20 subtle), and optional dur seconds for sustained sounds. Only sounds clearly stated or strongly implied by the text.',
  });

  // draft compile with the LLM-derived cast/scenes
  const nameCount = (e) => (e.names || []).reduce((n, name) =>
    n + paragraphs.filter((p) => p.text.toLowerCase().includes(name.toLowerCase())).length, 0);
  const protagonist = entities.filter((e) => e.kind === 'character')
    .sort((a, b) => nameCount(b) - nameCount(a))[0]?.id;
  const bookCfg = {
    id: bookId, protagonist, entities, hints: [],
    chapters: [{
      heading,
      scenes: scenes.map((s, i) => ({
        id: `sc${i + 1}`,
        anchor: paragraphs[s.start_para].text.slice(0, 48),
        env: { location: s.location, time: s.time, weather: s.weather, mood: s.mood },
        ambience: { type: s.ambience_type, intensity: s.intensity },
      })),
      cues: [],
    }],
  };
  const draft = compile(bookCfg, bookCfg.chapters[0], manuscriptPath);

  // D: attribution verification + emotion, batched over dialogue lines
  const dialogue = draft.scenes.flatMap((s) => s.lines).filter((l) => l.kind === 'dialogue');
  const byId = {};
  const reviewQueue = [];
  for (let i = 0; i < dialogue.length; i += 40) {
    const batch = dialogue.slice(i, i + 40);
    const listing = batch.map((l) => {
      const para = paragraphs[l.para];
      return `${l.id} [draft: ${l.entity}]\ncontext: ${para.text}\nquote: "${l.text}"`;
    }).join('\n\n');
    const { data: att } = await analyze({
      ...opts, purpose: 'attribution', schema: SCHEMAS.attribution,
      prompt: `Cast:\n${roster}\n\nDialogue lines from "${chapterTitle}" with their paragraph context and a draft attribution. ` +
        'For each: the true speaker entity id (from the cast), confidence 0-1, and the dominant emotion as {key: intensity} or null. ' +
        'Use confidence < 0.7 when genuinely ambiguous rather than guessing.\n\n' + listing,
    });
    for (const r of att.lines) byId[r.line_id] = r;
  }

  // merge: LLM overrides at confidence >= 0.7; below that, keep the draft and flag
  let overridden = 0;
  const lines = draft.scenes.flatMap((s) => s.lines).map((l) => {
    const r = byId[l.id];
    const out = { ...l };
    if (l.kind === 'dialogue' && r) {
      if (r.confidence >= 0.7 && r.entity !== l.entity) { out.entity = r.entity; overridden++; }
      else if (r.confidence < 0.7) reviewQueue.push({ line: l.id, draft: l.entity, llm: r.entity, confidence: r.confidence, cite: l.cite, text: l.text.slice(0, 60) });
      if (r.emotion && typeof r.emotion === 'object') {
        const em = Object.fromEntries(Object.entries(r.emotion).filter(([k, v]) => EMOTION_KEYS.includes(k) && v > 0 && v <= 1));
        if (Object.keys(em).length) out.emotion = em;
      }
    }
    return out;
  });

  // resolve cue anchors against real lines; misses go to the review queue
  const cues = [];
  for (const c of cue.cues) {
    const line = lines.find((l) => l.text.includes(c.anchor_text));
    if (line) cues.push({ id: `cue_${cues.length + 1}`, at_line: line.id, sfx: c.sfx, gain_db: c.gain_db, dur: c.dur || 0, cite: paragraphs[c.para]?.cite });
    else reviewQueue.push({ cue: c.sfx, reason: 'anchor not found in any line', anchor: c.anchor_text });
  }

  const script = {
    book: bookId, chapter: chapterTitle, revision: 1, analyzedBy: provider || process.env.DRAMATIS_LLM || 'ollama',
    entities, protagonist,
    scenes: draft.scenes.map((s, i) => ({ ...s, env: bookCfg.chapters[0].scenes[i].env, lines: s.lines.map((l) => lines.find((x) => x.id === l.id)) })),
    cues, reviewQueue,
    stats: {
      paragraphs: paragraphs.length, lines: lines.length, dialogue: dialogue.length,
      attributionOverrides: overridden, reviewQueueSize: reviewQueue.length,
    },
  };
  const outDir = ensureDir(path.join(cacheRoot, bookId));
  const outFile = path.join(outDir, `analysis-${heading.replace(/\W+/g, '-').toLowerCase()}.json`);
  writeFileSync(outFile, JSON.stringify(script, null, 2));
  log('analyze', `${lines.length} lines (${dialogue.length} dialogue), ${scenes.length} scenes, ${cues.length} cues, ` +
    `${overridden} attribution overrides, ${reviewQueue.length} flagged -> ${outFile}`);
  return script;
}
