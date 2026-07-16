// Compile stage: manuscript markdown -> Production Script (the IR).
// Deterministic segmentation + attribution heuristics; the analyzer LLM (or a
// human) refines via book.json hints. Every line/scene/cue carries a `cite`
// back to the source text.
import { readFileSync } from 'node:fs';
import { log } from './util.mjs';

const SAID_VERBS = 'said|asked|told|reported|cried|murmured|called|shouted|whispered|repeated|added|answered|replied';

function stripMd(s) {
  return s.replace(/\*+/g, '').replace(/\s+/g, ' ').trim();
}

export function compile(bookCfg, manuscriptPath) {
  const raw = readFileSync(manuscriptPath, 'utf8');

  // isolate requested chapter
  const chapters = raw.split(/^## /m).filter((c) => c.trim());
  const chapterSrc = chapters.find((c) => c.startsWith(bookCfg.chapterHeading));
  if (!chapterSrc) throw new Error(`chapter heading not found: ${bookCfg.chapterHeading}`);
  const chapterTitle = chapterSrc.split('\n')[0].trim();
  const body = chapterSrc.slice(chapterSrc.indexOf('\n') + 1);

  // paragraphs (keep source offsets for cites)
  const paragraphs = [];
  let cursor = raw.indexOf(body);
  for (const block of body.split(/\n\s*\n/)) {
    const text = block.trim();
    const at = raw.indexOf(block.trim(), cursor);
    if (text && !text.startsWith('<!--')) paragraphs.push({ text, cite: [at, at + text.length] });
    cursor = at + block.length;
  }

  // scene boundaries: match book.json anchors by paragraph prefix
  const sceneDefs = bookCfg.scenes.map((s) => ({ ...s, startPara: -1 }));
  paragraphs.forEach((p, idx) => {
    for (const s of sceneDefs) if (s.startPara === -1 && p.text.startsWith(s.anchor)) s.startPara = idx;
  });
  for (const s of sceneDefs) if (s.startPara === -1) throw new Error(`scene anchor not found: ${s.anchor}`);
  sceneDefs.sort((a, b) => a.startPara - b.startPara);

  // segment paragraphs into narration / dialogue lines
  const castByName = {};
  for (const e of bookCfg.entities) for (const n of e.names) castByName[n.toLowerCase()] = e.id;
  const hints = bookCfg.hints || [];

  let lineNo = 0;
  const allLines = [];
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

    segs.forEach((seg, i) => {
      const clean = stripMd(seg.text).replace(/^[—\-,.\s]+|[—\-\s]+$/g, (c) => (/[.!?…]/.test(c) ? c : ''));
      if (!clean || !/[a-zA-Z0-9一-鿿]/.test(clean)) return;
      let entity = 'narrator';
      if (seg.kind === 'dialogue') {
        entity = attribute(clean, segs, i, p.text, castByName, hints, bookCfg.protagonist);
      } else {
        const hint = hints.find((h) => clean.startsWith(h.match));
        if (hint) entity = hint.entity;
      }
      allLines.push({
        id: `lin_${String(lineNo++).padStart(4, '0')}`,
        para: pIdx, kind: seg.kind, entity, text: clean, cite: p.cite,
      });
    });
  });

  // bucket lines into scenes
  const scenes = sceneDefs.map((s, i) => {
    const end = i + 1 < sceneDefs.length ? sceneDefs[i + 1].startPara : Infinity;
    return {
      id: s.id, env: s.env, ambience: s.ambience,
      lines: allLines.filter((l) => l.para >= s.startPara && l.para < end),
    };
  });

  // cues: anchor by text prefix search across lines
  const cues = (bookCfg.cues || []).map((c) => {
    const line = allLines.find((l) => l.text.includes(c.anchor));
    if (!line) throw new Error(`cue anchor not found: ${c.anchor}`);
    return { ...c, at_line: line.id };
  });

  const script = {
    book: bookCfg.id, chapter: chapterTitle, revision: 1,
    entities: bookCfg.entities, scenes, cues,
  };
  log('compile', `${paragraphs.length} paragraphs -> ${allLines.length} lines, ${scenes.length} scenes, ${cues.length} cues`);
  return script;
}

function attribute(text, segs, i, para, castByName, hints, protagonist) {
  const hint = hints.find((h) => text.startsWith(h.match));
  if (hint) return hint.entity;
  const around = [segs[i + 1]?.text || '', segs[i - 1]?.text || ''].join(' ');
  const re = new RegExp(`(?:(\\w+)\\s+(?:${SAID_VERBS}))|(?:(?:${SAID_VERBS})\\s+(\\w+))`, 'i');
  const m = around.match(re);
  if (m) {
    const name = (m[1] || m[2] || '').toLowerCase();
    if (castByName[name]) return castByName[name];
    if (name === 'he' || name === 'she') return protagonist;
  }
  // fall back: search whole paragraph for a cast name
  for (const [name, id] of Object.entries(castByName)) {
    if (id !== 'narrator' && para.toLowerCase().includes(name)) return id;
  }
  return protagonist;
}
