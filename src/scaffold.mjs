// Scaffold: pasted manuscript -> samples/<slug>.md + books/<slug>/book.json.
// With analyze=true the LLM analyzer drafts cast/scenes/cues (ledgered, ~$0.003/ch);
// otherwise a minimal one-scene-per-chapter draft is created for the Cast screen
// to refine. Voices start from the house template — auditioned later, never final.
import path from 'node:path';
import { existsSync, writeFileSync, readFileSync, mkdirSync, renameSync } from 'node:fs';
import { chapterParagraphs, listChapters } from './compile.mjs';

const KOKORO_ROTATION = ['am_michael', 'af_sarah', 'am_eric', 'af_nicole', 'am_puck', 'am_liam', 'am_adam', 'am_echo', 'af_bella', 'bm_lewis'];
const ELEVEN_ROTATION = [['George', 'Brian'], ['Alice', 'Matilda'], ['Eric', 'Bill'], ['Sarah', 'Rachel'], ['Chris', 'Josh'], ['Archer', 'Daniel']];

const slugify = (s) => s.toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

export async function createBook({ title, author = '', text }, { root, analyze = false } = {}) {
  if (!title || !text) throw new Error('title and text required');
  const id = slugify(title);
  if (!id) throw new Error('title produced an empty slug');
  const bookDir = path.join(root, 'books', id);
  const samplePath = path.join(root, 'samples', `${id}.md`);
  if (existsSync(path.join(bookDir, 'book.json'))) throw new Error(`book "${id}" already exists`);

  // normalize the manuscript: curly quotes -> straight (the compiler's dialogue
  // detector only sees "), ensure an H1 + at least one ## chapter heading
  let body = text.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\r\n/g, '\n').trim();
  if (!/^##\s/m.test(body)) body = `## ${title}\n\n${body}`;
  const manuscript = `# ${title}\n\n${author ? `By ${author}.\n\n` : ''}${body}\n`;
  writeFileSync(samplePath, manuscript);

  const headings = listChapters(samplePath);
  if (!headings.length) throw new Error('no chapters found after normalization');

  const book = {
    id, title, author,
    manuscript: `../../samples/${id}.md`,
    protagonist: null,
    entities: [{ id: 'narrator', kind: 'narrator', names: [] }],
    voices: houseTemplate([]),
    hints: [],
    chapters: headings.map((heading) => {
      const { paragraphs } = chapterParagraphs(samplePath, heading);
      return {
        heading,
        scenes: [{
          id: `${slugify(heading)}-1`,
          anchor: paragraphs[0].text.slice(0, 60),
          ambience: { type: 'room-hum', intensity: 0.3 },
        }],
        cues: [],
      };
    }),
  };

  // Write a VALID book before analysis: if the analyzer dies (API down, bad
  // key, timeout) the paste is still a real book on disk you can open and cast
  // by hand, instead of an error toast and a lost manuscript.
  mkdirSync(bookDir, { recursive: true });
  const writeBook = () => {
    const tmp = path.join(bookDir, 'book.json.tmp');
    writeFileSync(tmp, JSON.stringify(book, null, 2));
    renameSync(tmp, path.join(bookDir, 'book.json'));
  };
  writeBook();

  let analyzed = false;
  let analyzeError = null;
  if (analyze && (process.env.OPENROUTER_API_KEY || process.env.OLLAMA_URL)) {
    const { analyzeChapter } = await import('./analyze.mjs');
    const provider = process.env.OPENROUTER_API_KEY ? 'openrouter' : 'ollama';
    const cacheRoot = path.join(root, 'out');
    try {
      for (let i = 0; i < headings.length; i++) {
        await analyzeChapter({ manuscriptPath: samplePath, bookId: id, chapter: String(i + 1), provider, cacheRoot });
        const aFile = path.join(cacheRoot, id, `analysis-${headings[i].replace(/\W+/g, '-').toLowerCase()}.json`);
        if (existsSync(aFile)) mergeAnalysis(book, JSON.parse(readFileSync(aFile, 'utf8')), i, samplePath);
      }
      book.voices = houseTemplate(book.entities.filter((e) => e.kind !== 'narrator'));
      analyzed = true;
      writeBook();                       // enriched version replaces the draft
    } catch (e) {
      analyzeError = String(e.message).slice(0, 200);   // draft on disk survives
    }
  }

  return {
    id, path: `books/${id}/book.json`, sample: `samples/${id}.md`, analyzed, analyzeError,
    chapters: book.chapters.length, entities: book.entities.length,
  };
}

function mergeAnalysis(book, analysis, chapterIdx, samplePath) {
  // cast: union by entity id
  for (const e of analysis.entities || []) {
    if (e.kind === 'narrator' || book.entities.some((x) => x.id === e.id)) continue;
    book.entities.push({ id: e.id, kind: e.kind || 'character', names: e.names || [], visual: e.description || '' });
  }
  if (!book.protagonist && analysis.protagonist) book.protagonist = analysis.protagonist;

  const heading = book.chapters[chapterIdx].heading;
  const { paragraphs: paras } = chapterParagraphs(samplePath, heading);
  const scenes = [];
  const cues = [];
  const lineText = {};
  for (const sc of analysis.scenes || []) {
    for (const l of sc.lines || []) lineText[l.id] = l.text;
    const firstPara = sc.lines?.[0]?.para;
    if (firstPara == null || !paras[firstPara]) continue;
    const KNOWN_AMBIENCE = ['rain', 'roomtone-morning', 'room-hum', 'crowd', 'city-night', 'lab-cold', 'battle'];
    const amb = sc.ambience && KNOWN_AMBIENCE.includes(sc.ambience.type)
      ? sc.ambience
      : { type: 'room-hum', intensity: sc.ambience?.intensity ?? 0.3 };
    scenes.push({
      id: sc.id || `sc-${scenes.length + 1}`,
      anchor: paras[firstPara].text.slice(0, 60),
      ambience: amb,
    });
  }
  // Human-vocal "SFX" are categorically wrong: the cast performs the lines —
  // a voice cue double-casts the scene with a stranger from the library
  // (measured: "human voice calling out" retrieved a teacher yelling at a class).
  const VOCAL = /\b(voice|voices|yell(?:ing)?|shout(?:ing)?|scream(?:s|ing)?|speech|talking|whisper(?:ing)?|murmur|says|saying|calling(?:\s+out)?|cries|crying|moan(?:ing)?|groan(?:ing)?|sob(?:bing)?|laugh(?:ter|ing)?|sing(?:ing)?|chant(?:ing)?|gasp(?:ing)?|wail(?:ing)?)\b/i;
  for (const c of analysis.cues || []) {
    const t = lineText[c.at_line];
    if (!t) continue;
    if (VOCAL.test(c.sfx)) continue;
    cues.push({ id: c.id, sfx: c.sfx, anchor: t.slice(0, 44), gain_db: c.gain_db ?? -8, ...(c.dur ? { dur: c.dur } : {}) });
  }
  if (scenes.length) book.chapters[chapterIdx].scenes = scenes;
  book.chapters[chapterIdx].cues = cues;
}

function houseTemplate(characters) {
  const kokoro = { narrator: { voice: 'bm_george', speed: 1.0 } };
  const qwen3 = { narrator: { design: 'Calm, measured middle-aged male storyteller; low, warm register; unhurried delivery.' } };
  // Robert's canon: Battlerap Algorithm is the house ElevenLabs narrator default
  const elevenlabs = { narrator: { candidates: ['Battlerap Algorithm', 'George', 'Brian'], model: 'eleven_v3', stability: 0.5, style: 0.25 } };
  characters.forEach((e, i) => {
    kokoro[e.id] = { voice: KOKORO_ROTATION[i % KOKORO_ROTATION.length], speed: 1.0 };
    qwen3[e.id] = { design: e.visual ? `Voice matching: ${e.visual}` : 'Distinct adult voice; natural delivery.' };
    elevenlabs[e.id] = { candidates: [...ELEVEN_ROTATION[i % ELEVEN_ROTATION.length]], stability: 0.5, style: 0.35 };
  });
  return { kokoro, qwen3, elevenlabs, hybrid: { kokoro: '@kokoro', qwen3: '@qwen3', elevenlabs: '@elevenlabs' } };
}
