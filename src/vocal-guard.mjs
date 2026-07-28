// THE CAST ARE THE ONLY VOICES (law 2) — one guard, imported everywhere.
//
// THE FOUNDING INCIDENT: a retrieved clip of a teacher yelling at a class
// played under the narration of The Signal-Man. The fix went into the analyzer
// (src/scaffold.mjs, which strips vocal CUES at book-creation time) and never
// reached the two places that actually pick audio at render time. Measured
// 2026-07-27: the runtime guard in engines/sfx/retrieve.mjs used bare stems, so
// `laugh` did not match "laughing", `voice` did not match "voices", `sing` did
// not match "singing" — 57 of 301 vocal captions in the shipped corpus got
// through, and the noun-overlap re-rank actively PROMOTED them. The ambience
// bed path had no guard at all, while asking for "crowd of people murmuring".
//
// Hence this module: a single regex, one import, so the lesson cannot land in
// one file and miss the others again.
//
// THE ASYMMETRY THAT SETS THE THRESHOLD: a human voice leaking under narration
// is a product-breaking defect that only a careful listener catches. A wrongly
// blocked clip costs one rank position — the next candidate, or the procgen
// fallback. So this guard is deliberately GREEDY: when in doubt, block.

// Stems that denote a human vocalisation, with their inflections. Written as
// stem + optional suffix so a new tense can never slip past the way "laughing"
// slipped past "laugh".
const STEMS = [
  'voice', 'vocal', 'yell', 'shout', 'scream', 'shriek', 'holler',
  'speech', 'speak', 'spoke', 'spoken', 'speaker', 'talk', 'whisper', 'murmur',
  'mutter', 'say', 'said', 'saying', 'cry', 'cries', 'cried', 'weep', 'wept',
  'moan', 'groan', 'sob', 'laugh', 'laughter', 'giggle', 'chuckle', 'chant',
  'gasp', 'wail', 'sing', 'sang', 'sung', 'song', 'choir', 'humming',
  'lecture', 'classroom', 'conversation', 'dialogue', 'narrat', 'announcer',
];

// (?:s|es|ed|ing|er|ers)? catches the inflections the old bare-stem guard missed.
export const VOCAL_RE = new RegExp(
  `\\b(?:${STEMS.join('|')})(?:s|es|ed|ing|er|ers)?\\b`, 'i',
);

/** Does this caption / cue text describe a human voice? */
export function isVocal(text) {
  return VOCAL_RE.test(String(text || ''));
}
