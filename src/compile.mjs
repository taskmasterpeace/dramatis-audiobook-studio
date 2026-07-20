// Compile stage: manuscript markdown -> Production Script (the IR).
// Deterministic segmentation + attribution heuristics; the analyzer LLM (or a
// human) refines via book.json hints. Every line/scene/cue carries a `cite`
// back to the source text.
import { readFileSync } from 'node:fs';
import { log } from './util.mjs';

const SAID_VERBS = 'said|asked|told|reported|cried|murmured|called|shouted|whispered|repeated|added|answered|replied|inquired|exclaimed|bawled|remarked|screamed|faltered|announced|pursued|admitted|demanded|began';

function stripMd(s) {
  return s.replace(/\*+/g, '').replace(/\s+/g, ' ').trim();
}

// Chapter text -> paragraphs with manuscript offsets (cites). Shared by the
// deterministic compiler and the LLM analyzer.
export function chapterParagraphs(manuscriptPath, heading) {
  const raw = readFileSync(manuscriptPath, 'utf8');
  const chapters = raw.split(/^## /m).filter((c) => c.trim());
  const chapterSrc = chapters.find((c) => c.startsWith(heading));
  if (!chapterSrc) throw new Error(`chapter heading not found: ${heading}`);
  const chapterTitle = chapterSrc.split('\n')[0].trim();
  const body = chapterSrc.slice(chapterSrc.indexOf('\n') + 1);
  const paragraphs = [];
  let cursor = raw.indexOf(body);
  for (const block of body.split(/\n\s*\n/)) {
    const text = block.trim();
    const at = raw.indexOf(block.trim(), cursor);
    if (text && !text.startsWith('<!--')) paragraphs.push({ text, cite: [at, at + text.length] });
    cursor = at + block.length;
  }
  return { chapterTitle, paragraphs };
}

export function listChapters(manuscriptPath) {
  const raw = readFileSync(manuscriptPath, 'utf8');
  return raw.split(/^## /m)
    .map((c) => c.trim())
    .filter((c) => c && !c.startsWith('#')) // drop front matter (H1 title etc.)
    .map((c) => c.split('\n')[0].trim());
}

// Fingerprint of everything that actually affects THIS chapter's render. Stored
// in the production script so staleness is precise: approving one cue in ch3
// used to mark every chapter in the book stale (whole-book mtime), which trains
// you to ignore the warning entirely.
export function chapterConfigHash(bookCfg, chapterCfg) {
  const relevant = {
    chapter: chapterCfg,
    // only what affects the rendered audio: names drive attribution; casting-
    // sheet metadata (gender/age/ethnicity/portrait/notes) drives SUGGESTIONS
    // only — filling out a sheet must not mark every chapter stale
    entities: (bookCfg.entities || []).map((e) => ({ id: e.id, kind: e.kind, names: e.names })),
    voices: bookCfg.voices,
    casting: bookCfg.casting || null,
    hints: bookCfg.hints || [],
    protagonist: bookCfg.protagonist || null,
  };
  let h = 0;
  const s = JSON.stringify(relevant);
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
  return String(h >>> 0);
}

export function compile(bookCfg, chapterCfg, manuscriptPath) {
  const { chapterTitle, paragraphs } = chapterParagraphs(manuscriptPath, chapterCfg.heading);

  // scene boundaries: match book.json anchors by paragraph prefix
  const sceneDefs = chapterCfg.scenes.map((s) => ({ ...s, startPara: -1 }));
  paragraphs.forEach((p, idx) => {
    for (const s of sceneDefs) if (s.startPara === -1 && p.text.startsWith(s.anchor)) s.startPara = idx;
  });
  for (const s of sceneDefs) if (s.startPara === -1) throw new Error(`scene anchor not found: ${s.anchor}`);
  sceneDefs.sort((a, b) => a.startPara - b.startPara);

  // segment paragraphs into narration / dialogue lines
  const castByName = {};
  for (const e of bookCfg.entities) for (const n of e.names) castByName[n.toLowerCase()] = e.id;
  const nameAlt = Object.keys(castByName)
    .sort((a, b) => b.length - a.length)
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const tagRe = nameAlt
    ? new RegExp(`\\b(${nameAlt})\\b[^.!?"]{0,30}?\\b(?:${SAID_VERBS})\\b|\\b(?:${SAID_VERBS})\\b[^.!?"]{0,20}?\\b(${nameAlt})\\b`, 'i')
    : null;
  const pronounRe = new RegExp(`\\b(?:he|she)\\b[^.!?"]{0,20}?\\b(?:${SAID_VERBS})\\b|\\b(?:${SAID_VERBS})\\b\\s+(?:he|she)\\b`, 'i');
  const hints = bookCfg.hints || [];

  // pass 1: split every paragraph into segments
  const paraRecs = [];
  paragraphs.forEach((p, pIdx) => {
    if (p.text === '---') return;
    const segs = [];
    const re = /"([^"]+)"/g;
    let last = 0, m;
    while ((m = re.exec(p.text)) !== null) {
      if (m.index > last) segs.push({ kind: 'narration', text: p.text.slice(last, m.index) });
      segs.push({ kind: 'dialogue', text: m[1] });
      last = re.lastIndex;
    }
    if (last < p.text.length) segs.push({ kind: 'narration', text: p.text.slice(last) });
    const narrText = segs.filter((s) => s.kind === 'narration').map((s) => s.text).join(' ');
    paraRecs.push({ pIdx, cite: p.cite, segs, narrText, hasDialogue: segs.some((s) => s.kind === 'dialogue') });
  });

  // pass 2: resolve one speaker per dialogue paragraph, tracking conversation turns.
  // Narration speech-mentions ("And Liu told him —") advance whose turn it is,
  // but only real dialogue turns define the A/B pair — otherwise a flashback
  // mention ("Dr. Han said...") poisons the exchange.
  let turns = [];    // all turns {entity, at}
  let dlgTurns = []; // dialogue-paragraph turns only
  let lastNarrActor = null; // "action beat" actor: narration para opening on a name
  const speakerOf = {};

  const findInitialActor = (text) => {
    for (const [name, id] of Object.entries(castByName)) {
      const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`^\\s*(?:the\\s+|a\\s+)?${esc}\\b`, 'i').test(text)) return id;
    }
    return null;
  };
  const sceneStarts = new Set(sceneDefs.map((s) => s.startPara));
  for (const rec of paraRecs) {
    // a new scene is a new conversation — stale turns must not leak across
    if (sceneStarts.has(rec.pIdx)) { turns = []; dlgTurns = []; }

    const tagMatch = tagRe && rec.narrText.match(tagRe);
    const tagged = tagMatch ? castByName[(tagMatch[1] || tagMatch[2]).toLowerCase()] : null;

    if (!rec.hasDialogue) {
      if (tagged) turns.push({ entity: tagged, at: rec.pIdx }); // e.g. "And Liu told him —"
      const actor = findInitialActor(rec.narrText);
      if (actor) lastNarrActor = { entity: actor, at: rec.pIdx };
      continue;
    }
    const present = new Set();
    let initialActor = null;
    for (const [name, id] of Object.entries(castByName)) {
      const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`\\b${esc}\\b`, 'i').test(rec.narrText)) present.add(id);
      if (new RegExp(`^\\s*(?:the\\s+|a\\s+)?${esc}\\b`, 'i').test(rec.narrText)) initialActor = id;
    }
    const lastTurn = turns.at(-1);
    const adjacent = lastTurn && rec.pIdx - lastTurn.at <= 3;

    let entity = null;
    const hint = hints.find((h) => rec.segs.some((s) => s.kind === 'dialogue' && stripMd(s.text).startsWith(h.match)));
    if (hint) entity = hint.entity;
    else if (tagged) entity = tagged;
    // unambiguous single cast name in the narration around the quotes
    else if (present.size === 1) entity = [...present][0];
    // the paragraph opens on a named actor -> the quotes are theirs
    else if (initialActor) entity = initialActor;
    // two names in narration, one of them just spoke -> it's the other one
    else if (present.size === 2 && adjacent && present.has(lastTurn.entity)) {
      entity = [...present].find((e) => e !== lastTurn.entity);
    }
    if (!entity && adjacent) {
      // exchange alternation: in a live A/B exchange, an untagged or
      // pronoun-tagged turn belongs to whoever didn't speak last
      const pair = [...new Set(dlgTurns.slice(-6).map((t) => t.entity).reverse())].slice(0, 2);
      if (pair.length === 2 && pair.includes(lastTurn.entity)) {
        entity = pair.find((e) => e !== lastTurn.entity);
      }
    }
    // action beat: narration para opening on a named actor, quote right after
    if (!entity && lastNarrActor && rec.pIdx - lastNarrActor.at === 1) entity = lastNarrActor.entity;
    if (!entity) entity = bookCfg.protagonist;
    speakerOf[rec.pIdx] = entity;
    turns.push({ entity, at: rec.pIdx });
    dlgTurns.push({ entity, at: rec.pIdx });
    if (turns.length > 12) turns = turns.slice(-12);
    if (dlgTurns.length > 12) dlgTurns = dlgTurns.slice(-12);
  }

  // pass 3: emit lines
  let lineNo = 0;
  const allLines = [];
  for (const rec of paraRecs) {
    for (const seg of rec.segs) {
      const clean = stripMd(seg.text).replace(/^[—\-,.\s]+|[—\-\s]+$/g, (c) => (/[.!?…]/.test(c) ? c : ''));
      if (!clean || !/[a-zA-Z0-9一-鿿]/.test(clean)) continue;
      const entity = seg.kind === 'dialogue' ? speakerOf[rec.pIdx] : 'narrator';
      const line = {
        id: `lin_${String(lineNo++).padStart(4, '0')}`,
        para: rec.pIdx, kind: seg.kind, entity, text: clean, cite: rec.cite,
      };
      // a hint may carry an emotion payload { anger: 0.7, ... } for the engines
      if (seg.kind === 'dialogue') {
        const h = hints.find((hh) => clean.startsWith(hh.match));
        if (h?.emotion) line.emotion = h.emotion;
      }
      allLines.push(line);
    }
  }

  // bucket lines into scenes. The first scene ALWAYS starts at paragraph 0:
  // otherwise every line above the first anchor is compiled, counted, and then
  // silently never rendered — and a cue anchored there resolves to a line the
  // mixer's timeline doesn't contain, throwing 30 minutes into a render.
  if (sceneDefs.length) sceneDefs[0].startPara = 0;
  const scenes = sceneDefs.map((s, i) => {
    const end = i + 1 < sceneDefs.length ? sceneDefs[i + 1].startPara : Infinity;
    return {
      id: s.id, env: s.env, ambience: s.ambience,
      lines: allLines.filter((l) => l.para >= s.startPara && l.para < end),
    };
  });
  // invariant: every compiled line lives in exactly one scene
  const bucketed = scenes.reduce((n, s) => n + s.lines.length, 0);
  if (bucketed !== allLines.length) {
    throw new Error(`scene coverage gap: ${allLines.length - bucketed} of ${allLines.length} lines fell outside every scene ` +
      `(scene starts: ${sceneDefs.map((s) => s.startPara).join(', ')}) — fix the scene anchors in book.json`);
  }

  // cues: anchor by text prefix search across lines
  const cues = (chapterCfg.cues || []).map((c) => {
    const line = allLines.find((l) => l.text.includes(c.anchor));
    if (!line) throw new Error(`cue anchor not found: ${c.anchor}`);
    return { ...c, at_line: line.id };
  });

  // music cues: same text anchoring, placed on their own stem in the mix
  const music = (chapterCfg.music || []).map((c) => {
    const line = allLines.find((l) => l.text.includes(c.anchor));
    if (!line) throw new Error(`music anchor not found: ${c.anchor}`);
    return { ...c, at_line: line.id };
  });

  const script = {
    book: bookCfg.id, chapter: chapterTitle, revision: 1,
    configHash: chapterConfigHash(bookCfg, chapterCfg),
    entities: bookCfg.entities, scenes, cues, music,
  };
  log('compile', `${paragraphs.length} paragraphs -> ${allLines.length} lines, ${scenes.length} scenes, ${cues.length} cues`);
  return script;
}
