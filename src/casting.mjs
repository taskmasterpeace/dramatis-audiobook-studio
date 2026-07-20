// Casting intelligence: turn a character's description into a VOICE RECIPE, and
// declare what the gate must verify. This is "how DRAMATIS decides who to hire."
//
// Determination has two sources, in order:
//   1. Explicit fields on the character (gender/age/ethnicity/accent) — the LLM
//      analyzer fills these into a per-character "casting sheet".
//   2. Keyword inference from the description text — the fallback when the sheet
//      is thin (and a sanity check on #1).
// Verification (the gate) is HONEST about what's measurable:
//   - gender  -> pitch-checkable (female >170Hz / male <150Hz)
//   - age     -> only the CHILD end is pitch-checkable (kids read clearly high);
//                elderly is directed + human-approved, not measured.
//   - ethnicity/accent -> NOT measurable; directed prompt + human ear only.

// Compound words matter: "Englishwoman"/"Frenchman" are single tokens, so a bare
// \bwoman\b misses them (Mrs. White read as gender-unknown until this was fixed).
// [a-z]*woman catches the compounds; (?<!wo) stops "woman" matching as "man".
const FEMALE = /\b(?:[a-z]*woman|female|girl|lady|grandmother|mother|aunt|daughter|sister|queen|actress|matriarch|widow|nun|maiden|she|her|hers)\b/i;
const MALE = /\b(?:[a-z]*(?<!wo)man|male|boy|guy|grandfather|father|uncle|son|brother|king|actor|patriarch|widower|monk|he|him|his)\b/i;

// age bands with the cues that signal them and the voice direction they imply
const AGE_BANDS = [
  // Teen is tested BEFORE child on purpose: "teenage girl" matches both, and the
  // first match wins — a fifteen-year-old was being given the eight-year-old
  // design ("small bright high-pitched"), which is an audible miscast.
  { band: 'teen', re: /\b(teenager|teenage|adolescent|1[0-7][- ]?year|youth|schoolkid|(of|aged|around) (thirteen|fourteen|fifteen|sixteen|seventeen)|(thirteen|fourteen|fifteen|sixteen|seventeen)[- ]years?[- ]old)\b/i, years: '15', design: 'a teenager around fifteen, light youthful voice, still a bit high', expectHighPitch: true },
  // A bare "boy"/"girl" reads as a child — "a frightened boy of about nine" was
  // being cast as a middle-aged adult. \b keeps "cowboy" and "girlfriend" out
  // (no word boundary inside a compound). "(about|around|aged) nine" is the
  // other everyday phrasing that the years-old-only pattern missed.
  { band: 'child', re: /\b(child|kid|boy|girl|toddler|infant|schoolboy|schoolgirl|[4-9][- ]?year|(four|five|six|seven|eight|nine|ten|eleven|twelve)[- ](years?[- ]old|year)|(about|around|aged|of)\s+(four|five|six|seven|eight|nine|ten|eleven|twelve))\b/i, years: '8', design: 'a young child about 8 years old, small bright high-pitched voice, innocent and quick', expectHighPitch: true },
  { band: 'young-adult', re: /\b(young (man|woman)|in (his|her) (twenties|20s)|college|student)\b/i, years: 'mid-20s', design: 'in their mid-twenties, clear energetic adult voice', expectHighPitch: false },
  // NOTE: no bare "aged" — it matches inside "middle-aged" (a middle-aged clerk
  // was being cast as elderly). Same trap as \bwoman\b inside "Englishwoman".
  { band: 'elderly', re: /\b(elderly|old (man|woman|lady)|ancient|in (his|her) (seventies|eighties|nineties|70s|80s|90s)|grandmother|grandfather|geriatric|frail|white[- ]haired|(?<!middle[- ])aged\b)/i, years: 'in their late 70s', design: 'elderly, in their late seventies, thin weathered voice with a faint age-quaver, breathy and slow', expectHighPitch: false },
  { band: 'adult', re: /.*/, years: 'middle-aged', design: 'a middle-aged adult, natural full voice', expectHighPitch: false },
];

// accents/ethnicity worth a directed prompt (origin -> "speaking English")
function accentDirection(text) {
  const t = (text || '').toLowerCase();
  const map = [
    [/new orleans|creole|nola/, 'deep New Orleans Southern Black accent, speaking English'],
    [/southern|dixie|deep south/, 'warm American Southern accent'],
    [/chinese|mandarin|beijing|shanghai/, 'light Mandarin-accented English, a Chinese person speaking English'],
    [/japanese|tokyo/, 'light Japanese-accented English'],
    [/british|english|london|cockney|rp\b/, 'British English accent'],
    [/scottish|glasgow|highland/, 'Scottish accent'],
    [/irish|dublin/, 'Irish accent'],
    [/french|parisian/, 'French-accented English'],
    [/russian|moscow/, 'Russian-accented English'],
    [/indian|delhi|mumbai/, 'Indian-accented English'],
    [/african|nigerian|kenyan/, 'West African-accented English'],
    [/italian|sicilian/, 'Italian-accented English'],
    [/spanish|mexican|latino|latina/, 'Spanish-accented English'],
    [/black|african[- ]american/, 'African American voice'],
  ];
  for (const [re, dir] of map) if (re.test(t)) return dir;
  return null;
}

// numeric age (from the casting sheet form) -> band; NaN falls through to regex
function bandFromAge(age) {
  const n = parseInt(String(age ?? '').replace(/\D+/g, ''), 10);
  if (Number.isNaN(n) || n <= 0 || n > 120) return null;
  return n < 13 ? 'child' : n < 18 ? 'teen' : n < 30 ? 'young-adult' : n < 60 ? 'adult' : 'elderly';
}

export function determine(char) {
  // Alias lists carry possessives that belong to OTHER characters ("his wife",
  // "his mother") — those made every wife read as male and cancel to unknown.
  // Strip pronouns from names before they reach gender inference.
  const nameText = (char.names || []).join(' ').replace(/\b(his|her|hers|him|he|she|their|them|my|your)\b/gi, ' ');
  const desc = [char.visual, char.description, nameText, char.gender, char.age, char.ethnicity, char.accent].filter(Boolean).join(' ');
  // explicit casting-sheet fields ALWAYS beat inference — the sheet is Robert's
  // "pop in there and fill it out" form; the regex is only the fallback
  const gender = char.gender
    || (FEMALE.test(desc) && !MALE.test(desc) ? 'female'
      : MALE.test(desc) && !FEMALE.test(desc) ? 'male' : 'unknown');
  const ageBand = char.ageBand || bandFromAge(char.age) || AGE_BANDS.find((b) => b.re.test(desc)).band;
  const accent = char.accent || accentDirection([char.ethnicity, desc].filter(Boolean).join(' '));
  return { gender, ageBand, accent, desc };
}

// full recipe: engine + params + what the gate must check
export function castingRecipe(char) {
  const { gender, ageBand, accent, desc } = determine(char);
  const ageSpec = AGE_BANDS.find((b) => b.band === ageBand);
  const needsCharacterTier = !!accent || ageBand === 'child' || ageBand === 'elderly' || ageBand === 'teen';

  // build a stacked, directed prompt (the Qwen-research recipe: specifics beat labels)
  const genderWord = gender === 'unknown' ? 'a person' : `a ${gender === 'female' ? 'woman' : 'man'}`;
  const promptParts = [
    `AUDIO PROFILE: ${char.id || 'character'}. ${genderWord}, ${ageSpec.years}.`,
    char.visual ? `WHO: ${char.visual}` : '',
    `DIRECTOR'S NOTES: Style: ${ageSpec.design}.`,
    accent ? `Accent: ${accent}.` : '',
    'Pace: natural, in character.',
  ].filter(Boolean);
  const directedPrompt = promptParts.join(' ');

  const recipe = needsCharacterTier
    ? { // character tier — directed voice, Gemini (accent/age land via direction)
        engine: 'gemini',
        voice: gender === 'female' ? (ageBand === 'child' ? 'Leda' : 'Gacrux') : (ageBand === 'child' ? 'Puck' : 'Enceladus'),
        prompt: directedPrompt,
        note: 'character actor: seed on Gemini, then clone into Qwen3 for free volume',
      }
    : { // generic tier — free Qwen3 design
        engine: 'qwen3',
        design: `${genderWord}, ${ageSpec.years}; ${ageSpec.design}.${accent ? ' ' + accent + '.' : ''}`,
        note: 'generic cast: free local design is enough',
      };

  return {
    determined: { gender, ageBand, accent: accent || 'none' },
    recipe,
    gate: {
      expectedRegister: gender === 'unknown' ? null : `${gender}-range`,
      expectChildHighPitch: !!ageSpec.expectHighPitch,   // measurable
      accentVerifiable: false,                            // human ear only — be honest
      note: 'gender + child-high-pitch are machine-gated; accent/ethnicity are directed + human-approved',
    },
  };
}
