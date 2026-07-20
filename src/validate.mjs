// Fail-fast book validation. Catches the defects that used to be discoverable
// only by listening to a finished render: a character with no voice (rendered
// silently in the narrator's voice), a casting override naming an engine that
// isn't loaded, and anchors that don't resolve.
// Called by the CLI before rendering and by the Studio before writing book.json.

const KNOWN_ENGINES = ['kokoro', 'qwen3', 'elevenlabs', 'gemini'];
const KNOWN_AMBIENCE = ['rain', 'roomtone-morning', 'room-hum', 'crowd', 'city-night', 'lab-cold', 'battle'];

// which engines can actually be reached for this book/route
function enginesInPlay(book, tts = 'hybrid') {
  if (tts !== 'hybrid') return [tts];
  const set = new Set(['kokoro', 'qwen3', 'elevenlabs']);            // hybrid's default routes
  for (const c of Object.values(book.casting || {})) if (c.engine) set.add(c.engine);
  return [...set].filter((e) => book.voices?.[e]);
}

export function validateBook(book, { tts = 'hybrid', strict = false } = {}) {
  const errors = [];
  const warnings = [];

  if (!book.id || !/^[a-z0-9-]+$/.test(book.id)) errors.push(`book.id missing or not slug-safe: ${book.id}`);
  if (!Array.isArray(book.entities) || !book.entities.length) errors.push('book has no entities');
  if (!Array.isArray(book.chapters) || !book.chapters.length) errors.push('book has no chapters');

  // casting overrides must name a real, loaded engine
  for (const [eid, c] of Object.entries(book.casting || {})) {
    if (!book.entities?.some((e) => e.id === eid)) errors.push(`casting override for unknown entity '${eid}'`);
    if (c.engine && !KNOWN_ENGINES.includes(c.engine)) errors.push(`casting '${eid}': unknown engine '${c.engine}'`);
    if (c.engine && !book.voices?.[c.engine]) errors.push(`casting '${eid}' routes to '${c.engine}' but book.voices.${c.engine} is missing`);
  }

  // every entity needs a voice in every engine it could be routed to
  for (const eng of enginesInPlay(book, tts)) {
    const map = book.voices[eng];
    if (!map || typeof map === 'string') continue;
    for (const ent of book.entities || []) {
      if (map[ent.id]) continue;
      const msg = `entity '${ent.id}' has no ${eng} voice (would fall back to the narrator)`;
      if (map.narrator) warnings.push(msg); else errors.push(msg);
    }
  }

  // scenes/cues sanity that doesn't need the manuscript
  for (const ch of book.chapters || []) {
    if (!ch.scenes?.length) errors.push(`chapter '${ch.heading}' has no scenes`);
    for (const s of ch.scenes || []) {
      if (!s.anchor) errors.push(`scene '${s.id}' has no anchor`);
      const t = s.ambience?.type;
      if (t && !KNOWN_AMBIENCE.includes(t)) errors.push(`scene '${s.id}': unknown ambience type '${t}' (known: ${KNOWN_AMBIENCE.join(', ')})`);
    }
    for (const c of ch.cues || []) {
      if (!c.anchor) errors.push(`cue '${c.id}' has no anchor`);
      if (!c.sfx) errors.push(`cue '${c.id}' has no sfx spec`);
    }
  }

  return { ok: errors.length === 0, errors, warnings: strict ? [] : warnings };
}

// after synthesis: every line must have produced a file
export function assertAllRendered(lines, lineWavs, existsSync) {
  const missing = lines.filter((l) => !lineWavs[l.id] || !existsSync(lineWavs[l.id]));
  if (missing.length) {
    throw new Error(`${missing.length} line(s) failed to synthesize: ` +
      missing.slice(0, 5).map((l) => `${l.id} (${l.entity})`).join(', ') +
      (missing.length > 5 ? ` …and ${missing.length - 5} more` : ''));
  }
}
