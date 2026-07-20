// Voice Designer: plain-English character description -> a SLATE of auditionable
// candidates across every engine, each with the reasoning that picked it.
//
// This is the "calculate it behind the scenes" layer. determine()/castingRecipe()
// in casting.mjs answer "who should voice this?" with ONE answer; a human casting
// a part wants to HEAR the alternatives. So: same inference, four candidates, and
// a `why` on each so the choice is legible instead of magic.
//
// The winning take becomes a company member (actors/<slug>/) — which is why the
// audition line is seed-length (~12 s): the take you approve IS the clone
// reference, no second render, and 8-15 s is the measured sweet spot for Qwen3
// cloning (quality degrades past ~15 s).
import { determine } from './casting.mjs';
import { KOKORO_VOICES, GEMINI_VOICES, ageToEleven, accentKey } from './voice-tables.mjs';

// One line, spoken by every candidate, so they compare fairly — and long enough
// to serve as a clone seed. Phonetically varied, emotionally neutral, no proper
// nouns or setting that would fight a character's accent.
export const SEED_LINE =
  'They told me the road would be clear by morning, but I have lived long enough to know better. '
  + 'Some nights you wait, and you listen, and you hold on to whatever it is you love most.';

const bandYears = {
  child: 'about 8 years old', teen: 'around fifteen', 'young-adult': 'in their mid-twenties',
  adult: 'middle-aged', elderly: 'in their late seventies',
};

// Words in the description that point at one of Google's published voice
// characteristics. Google publishes ONLY a one-word character per voice — no age,
// no pitch, no accent — so these four texture voices are the only real signal
// there is, and matching them means the preset isn't fighting the direction.
const TEXTURE = [
  [/gravell?y|rough|rasp|gruff|hoarse|weathered|smoke|whisk(e)?y|growl/i, 'Gravelly'],
  [/breathy|frail|thin|wispy|failing|dying|asthmatic/i, 'Breathy'],
  [/warm|maternal|kindly|nurturing/i, 'Warm'],
  [/soft|quiet|hushed|timid|shy|gentle/i, 'Soft'],
  [/bright|chirpy|sunny|perky/i, 'Bright'],
  [/smooth|silky|polished|suave|velvet/i, 'Smooth'],
  [/upbeat|bubbly|peppy|cheerful/i, 'Upbeat'],
  [/firm|stern|commanding|authorit|severe|hard/i, 'Firm'],
  [/calm|even|flat|deadpan|measured/i, 'Even'],
  [/excit|manic|frantic|hyper/i, 'Excitable'],
  [/friendly|approachable|affable/i, 'Friendly'],
  [/professor|scholar|learned|erudite|knowledgeable/i, 'Knowledgeable'],
  [/casual|laid[- ]back|relaxed|easy/i, 'Easy-going'],
  [/narrat|announcer|documentary|informative/i, 'Informative'],
];

// Score a Gemini preset. Gender is a hard filter; texture and age are the soft
// signals. Getting this right matters — a gruff dockworker routed to the
// "Informative" voice is fighting the preset for the whole book.
function pickGemini({ gender, ageBand, desc }) {
  const wantTexture = TEXTURE.find(([re]) => re.test(desc || ''))?.[1] || null;
  const pool = GEMINI_VOICES.filter((v) => gender === 'unknown' || v.gender === gender);
  const scored = pool.map((v) => {
    let s = 0;
    if (wantTexture && v.character === wantTexture) s += 5;
    // Age outranks texture on purpose: Gacrux is the ONLY aged-reading female and
    // Enceladus the breathiest male, and those two are our two ear-approved
    // character seeds. "warm elderly woman" must land on Gacrux, not on Sulafat.
    if (ageBand === 'elderly' && v.ageSkew === 'mature') s += 6;
    if ((ageBand === 'child' || ageBand === 'teen') && v.ageSkew === 'young') s += 6;
    if (ageBand === 'adult' && !v.ageSkew) s += 1;
    return { v, s };
  }).sort((a, b) => b.s - a.s);
  const best = scored[0]?.v || GEMINI_VOICES[0];
  return { ...best, matched: wantTexture && best.character === wantTexture ? wantTexture : null };
}

// Locale is a stronger accent lever than prompt wording alone, and it's free.
// American regions are tested FIRST and deliberately: our accent directions are
// phrased "<origin> accent, speaking English", so a bare /english/ test sent
// "deep New Orleans Southern Black accent, speaking English" to en-GB.
function localeFor(accent) {
  const t = String(accent || '').toLowerCase();
  if (/new orleans|southern|american|creole|nola|african american/.test(t)) return 'en-US';
  if (/irish|british|scottish|cockney|london|england|welsh/.test(t)) return 'en-GB';
  if (/indian|delhi|mumbai/.test(t)) return 'en-IN';
  if (/australian|aussie/.test(t)) return 'en-AU';
  return 'en-US';
}

function pickKokoro({ gender, accent }) {
  const wantBritish = /british|english|cockney|scottish|irish/i.test(accent || '');
  const pool = KOKORO_VOICES.filter((v) => (gender === 'unknown' || v.gender === gender)
    && (wantBritish ? v.accent === 'british' : v.accent === 'american'));
  // grade is the published quality rank — prefer the voices that actually hold up
  return (pool.length ? pool : KOKORO_VOICES).slice().sort((a, b) => b.score - a.score)[0];
}

// ElevenLabs is the user's own roster, so it can only be matched at runtime against
// whatever /v1/voices returns. gender is required; age and accent are bonuses.
function pickEleven(roster, { gender, ageBand, accent }) {
  if (!roster?.length) return null;
  const wantAge = ageToEleven(ageBand);
  const wantAcc = accentKey(accent);
  const scored = roster.map((v) => {
    let s = 0;
    if (v.gender && gender !== 'unknown') s += v.gender === gender ? 4 : -6;
    if (v.age && wantAge) s += v.age === wantAge ? 3 : -1;
    if (v.accent && wantAcc) s += String(v.accent).toLowerCase().includes(wantAcc) ? 3 : 0;
    return { v, s };
  }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
  return scored[0]?.v || null;
}

// The director's note, in Google's documented shape. Two details are load-bearing:
// the explicit synthesis imperative (a vague prompt can trip the classifier into
// reading the notes ALOUD or refusing outright), and the header "PERFORMANCE" —
// "DIRECTOR'S NOTES" has been observed being spoken, apostrophes being a known
// classifier hazard.
export function directedPrompt(char, det) {
  const { gender, ageBand, accent } = det;
  const who = gender === 'unknown' ? 'a person' : `a ${gender === 'female' ? 'woman' : 'man'}`;
  return [
    'Synthesize this performance as speech.',
    `\nVOICE\n${who}, ${bandYears[ageBand]}.`,
    char.visual || char.description ? `${char.visual || char.description}.` : '',
    `\nPERFORMANCE\nStyle: ${det.styleNote}.`,
    accent ? `Accent: ${accent}.` : '',
    'Pace: natural, in character. Speak it the way this person would actually say it.',
  ].filter(Boolean).join(' ');
}

const STYLE_BY_BAND = {
  child: 'a young child, small bright high-pitched voice, innocent and quick',
  teen: 'a teenager, light youthful voice, still a bit high',
  'young-adult': 'clear energetic adult voice',
  adult: 'natural full adult voice',
  elderly: 'thin weathered voice with a faint age-quaver, breathy and slow, low energy',
};

/**
 * Build the audition slate.
 * @param {object} char  { visual|description, gender?, age?, ethnicity?, accent?, id? }
 * @param {object} roster { elevenlabs: [{voice,gender,age,accent}] } — live 11L roster
 * @returns {{determined:object, candidates:Array}}
 */
export function candidateSlate(char, roster = {}) {
  const det = determine(char);
  det.styleNote = STYLE_BY_BAND[det.ageBand];
  const prompt = directedPrompt(char, det);

  const g = pickGemini(det);
  const k = pickKokoro(det);
  const e = pickEleven(roster.elevenlabs, det);

  const candidates = [
    {
      engine: 'gemini', voice: g.voice,
      params: { voice: g.voice, prompt, language_code: localeFor(det.accent) },
      why: [
        g.note,
        g.matched ? `matched on "${g.matched}" from your description` : null,
        det.accent ? `directed for ${det.accent} (locale ${localeFor(det.accent)})` : null,
      ].filter(Boolean).join(' · '),
      tier: 'premium', best: !!det.accent || det.ageBand === 'elderly' || det.ageBand === 'child',
    },
    e && {
      engine: 'elevenlabs', voice: e.voice, params: { candidates: [e.voice], stability: 0.5, style: 0.3 },
      why: `your roster's closest match: ${[e.gender, e.age, e.accent].filter(Boolean).join(' · ')}`,
      tier: 'premium',
    },
    {
      engine: 'qwen3', voice: 'designed',
      params: { design: `${det.gender === 'unknown' ? 'A person' : det.gender === 'female' ? 'A woman' : 'A man'}, ${bandYears[det.ageBand]}; ${det.styleNote}.${det.accent ? ` ${det.accent}.` : ''}` },
      why: 'free + unlimited, and the only one you can re-render forever at no cost',
      tier: 'free',
    },
    {
      engine: 'kokoro', voice: k.voice, params: { voice: k.voice, speed: 1.0 },
      why: `fastest free preset that fits (${k.name}, quality ${k.grade})${det.accent ? ' — note: presets cannot do accents' : ''}`,
      tier: 'free', weak: !!det.accent,
    },
  ].filter(Boolean);

  return { determined: { ...det, styleNote: undefined, desc: undefined }, prompt, candidates };
}
