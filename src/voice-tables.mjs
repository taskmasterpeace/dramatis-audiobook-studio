// Voice metadata tables — the facts that make a roster choosable.
//
// Before this existed the Casting Room showed 28 Kokoro voices under four labels
// ("US female", "US male"…) — unusable for picking anyone. The high-value field we
// were discarding is Kokoro's published QUALITY GRADE, which cleanly separates the
// ~5 audiobook-grade voices from the 20 that sound rough.
//
// Sources: hexgrad/Kokoro-82M VOICES.md (grades + training tiers, verified against
// the 54 style tensors actually installed in models/kokoro/voices-v1.0.bin) and
// Google's speech-generation docs (Gemini voice characteristics).
// Honest note: upstream publishes grades, NOT timbre descriptions — the only
// character hints in the whole Kokoro catalog are three emoji. Any prose beyond
// grade/gender/accent has to be authored by us from real auditions, so we don't
// invent it here.

const GRADE_SCORE = { A: 10, 'A-': 9.5, 'B+': 8.5, 'B': 8.2, 'B-': 8, 'C+': 7, C: 6, 'C-': 5.5, 'D+': 5, D: 4, 'D-': 3.5, 'F+': 2, '?': 4.5 };

// [id, name, gender, accent, lang, grade, note]
// lang matters: kokoro-batch.py used to derive it as "en-gb if id starts with b",
// which fed every non-English voice American English phonemes.
const K = [
  ['af_heart', 'Heart', 'female', 'american', 'en-us', 'A', 'flagship — best voice in the model'],
  ['af_bella', 'Bella', 'female', 'american', 'en-us', 'A-', 'energetic; heavily trained'],
  ['af_nicole', 'Nicole', 'female', 'american', 'en-us', 'B-', 'close-mic / ASMR quality'],
  ['af_aoede', 'Aoede', 'female', 'american', 'en-us', 'C+', ''],
  ['af_kore', 'Kore', 'female', 'american', 'en-us', 'C+', ''],
  ['af_sarah', 'Sarah', 'female', 'american', 'en-us', 'C+', ''],
  ['af_alloy', 'Alloy', 'female', 'american', 'en-us', 'C', ''],
  ['af_nova', 'Nova', 'female', 'american', 'en-us', 'C', ''],
  ['af_sky', 'Sky', 'female', 'american', 'en-us', 'C-', 'barely trained — expect artifacts'],
  ['af_jessica', 'Jessica', 'female', 'american', 'en-us', 'D', ''],
  ['af_river', 'River', 'female', 'american', 'en-us', 'D', ''],
  ['am_fenrir', 'Fenrir', 'male', 'american', 'en-us', 'C+', ''],
  ['am_michael', 'Michael', 'male', 'american', 'en-us', 'C+', ''],
  ['am_puck', 'Puck', 'male', 'american', 'en-us', 'C+', 'reads younger'],
  ['am_echo', 'Echo', 'male', 'american', 'en-us', 'D', ''],
  ['am_eric', 'Eric', 'male', 'american', 'en-us', 'D', ''],
  ['am_liam', 'Liam', 'male', 'american', 'en-us', 'D', ''],
  ['am_onyx', 'Onyx', 'male', 'american', 'en-us', 'D', 'deep'],
  ['am_santa', 'Santa', 'male', 'american', 'en-us', 'D-', 'novelty'],
  ['am_adam', 'Adam', 'male', 'american', 'en-us', 'F+', 'worst in the model — avoid'],
  ['bf_emma', 'Emma', 'female', 'british', 'en-gb', 'B-', 'best UK voice; heavily trained'],
  ['bf_isabella', 'Isabella', 'female', 'british', 'en-gb', 'C', ''],
  ['bf_alice', 'Alice', 'female', 'british', 'en-gb', 'D', ''],
  ['bf_lily', 'Lily', 'female', 'british', 'en-gb', 'D', ''],
  ['bm_fable', 'Fable', 'male', 'british', 'en-gb', 'C', ''],
  ['bm_george', 'George', 'male', 'british', 'en-gb', 'C', 'the house narrator so far'],
  ['bm_lewis', 'Lewis', 'male', 'british', 'en-gb', 'D+', ''],
  ['bm_daniel', 'Daniel', 'male', 'british', 'en-gb', 'D', ''],
  ['ff_siwis', 'Siwis', 'female', 'french', 'fr-fr', 'B-', 'French — best non-English voice'],
  ['ef_dora', 'Dora', 'female', 'spanish', 'es', '?', 'Spanish — ungraded upstream'],
  ['em_alex', 'Alex', 'male', 'spanish', 'es', '?', 'Spanish — ungraded upstream'],
  ['em_santa', 'Santa', 'male', 'spanish', 'es', '?', 'Spanish — ungraded upstream'],
  ['pf_dora', 'Dora', 'female', 'brazilian', 'pt-br', '?', 'Brazilian Portuguese — ungraded'],
  ['pm_alex', 'Alex', 'male', 'brazilian', 'pt-br', '?', 'Brazilian Portuguese — ungraded'],
  ['pm_santa', 'Santa', 'male', 'brazilian', 'pt-br', '?', 'Brazilian Portuguese — ungraded'],
  ['if_sara', 'Sara', 'female', 'italian', 'it', 'C', 'Italian'],
  ['im_nicola', 'Nicola', 'male', 'italian', 'it', 'C', 'Italian'],
  ['hf_alpha', 'Alpha', 'female', 'hindi', 'hi', 'C', 'Hindi'],
  ['hf_beta', 'Beta', 'female', 'hindi', 'hi', 'C', 'Hindi'],
  ['hm_omega', 'Omega', 'male', 'hindi', 'hi', 'C', 'Hindi'],
  ['hm_psi', 'Psi', 'male', 'hindi', 'hi', 'C', 'Hindi'],
  ['jf_alpha', 'Alpha', 'female', 'japanese', 'ja', 'C+', 'Japanese'],
  ['jf_gongitsune', 'Gongitsune', 'female', 'japanese', 'ja', 'C', 'Japanese'],
  ['jf_tebukuro', 'Tebukuro', 'female', 'japanese', 'ja', 'C', 'Japanese'],
  ['jf_nezumi', 'Nezumi', 'female', 'japanese', 'ja', 'C-', 'Japanese'],
  ['jm_kumo', 'Kumo', 'male', 'japanese', 'ja', 'C-', 'Japanese'],
  ['zf_xiaobei', 'Xiaobei', 'female', 'chinese', 'cmn', 'D', 'Mandarin'],
  ['zf_xiaoni', 'Xiaoni', 'female', 'chinese', 'cmn', 'D', 'Mandarin'],
  ['zf_xiaoxiao', 'Xiaoxiao', 'female', 'chinese', 'cmn', 'D', 'Mandarin'],
  ['zf_xiaoyi', 'Xiaoyi', 'female', 'chinese', 'cmn', 'D', 'Mandarin'],
  ['zm_yunjian', 'Yunjian', 'male', 'chinese', 'cmn', 'D', 'Mandarin'],
  ['zm_yunxi', 'Yunxi', 'male', 'chinese', 'cmn', 'D', 'Mandarin'],
  ['zm_yunxia', 'Yunxia', 'male', 'chinese', 'cmn', 'D', 'Mandarin'],
  ['zm_yunyang', 'Yunyang', 'male', 'chinese', 'cmn', 'D', 'Mandarin'],
];

export const KOKORO_VOICES = K.map(([voice, name, gender, accent, lang, grade, note]) => ({
  voice, name, gender, accent, lang, grade, note, score: GRADE_SCORE[grade] ?? 4,
}));

export const KOKORO_LANG = Object.fromEntries(KOKORO_VOICES.map((v) => [v.voice, v.lang]));

// Gemini's 30 prebuilt voices. `character` is Google's own one-word descriptor;
// ageSkew is what the voice actually reads as (only where it's clearly skewed).
const G = [
  ['Zephyr', 'female', 'Bright'], ['Puck', 'male', 'Upbeat', 'young'],
  ['Charon', 'male', 'Informative'], ['Kore', 'female', 'Firm'],
  ['Fenrir', 'male', 'Excitable'], ['Leda', 'female', 'Youthful', 'young'],
  ['Orus', 'male', 'Firm'], ['Aoede', 'female', 'Breezy'],
  ['Callirrhoe', 'female', 'Easy-going'], ['Autonoe', 'female', 'Bright'],
  ['Enceladus', 'male', 'Breathy', 'mature'], ['Iapetus', 'male', 'Clear'],
  ['Umbriel', 'male', 'Easy-going'], ['Algenib', 'male', 'Gravelly', 'mature'],
  ['Despina', 'female', 'Smooth'], ['Erinome', 'female', 'Clear'],
  ['Laomedeia', 'female', 'Upbeat'], ['Achernar', 'female', 'Soft'],
  ['Algieba', 'male', 'Smooth'], ['Schedar', 'male', 'Even'],
  ['Gacrux', 'female', 'Mature', 'mature'], ['Pulcherrima', 'female', 'Forward'],
  ['Achird', 'male', 'Friendly'], ['Zubenelgenubi', 'male', 'Casual'],
  ['Vindemiatrix', 'female', 'Gentle'], ['Sadachbia', 'male', 'Lively', 'young'],
  ['Sadaltager', 'male', 'Knowledgeable'], ['Sulafat', 'female', 'Warm'],
  ['Alnilam', 'male', 'Firm'], ['Rasalgethi', 'male', 'Informative'],
];

export const GEMINI_VOICES = G.map(([voice, gender, character, ageSkew]) => ({
  voice, gender, character, ageSkew: ageSkew || null,
  note: `${gender === 'female' ? 'F' : 'M'} · ${character}${ageSkew ? ` · reads ${ageSkew}` : ''}`,
}));

// Accent -> BCP-47 locale for Gemini. Locale is a STRONGER accent lever than
// prompt wording alone and costs nothing, but it was plumbed through the engine
// and never set by the caster — so all 87 available locales collapsed to en-US.
// American regions are tested FIRST on purpose: our accent directions are
// phrased "<origin> accent, speaking English", so a bare /english/ test sent
// "deep New Orleans Southern Black accent, speaking English" to en-GB.
export function localeFor(accent) {
  const t = String(accent || '').toLowerCase();
  if (/new orleans|southern|american|creole|nola|african american|texan|midwest/.test(t)) return 'en-US';
  if (/irish|dublin/.test(t)) return 'en-IE';
  if (/british|english|london|cockney|scottish|welsh|rp\b/.test(t)) return 'en-GB';
  if (/indian|delhi|mumbai|bengali|punjabi/.test(t)) return 'en-IN';
  if (/australian|aussie/.test(t)) return 'en-AU';
  if (/nigerian|kenyan|west african|ghanaian/.test(t)) return 'en-NG';
  if (/south africa/.test(t)) return 'en-ZA';
  return 'en-US';
}

// our age bands -> the labels ElevenLabs actually publishes on voices
export function ageToEleven(band) {
  return { child: 'young', teen: 'young', 'young-adult': 'young', adult: 'middle aged', elderly: 'old' }[band] || null;
}

// accentDirection() returns a prose direction ("Irish accent"); matching a roster
// needs a short key. Kept separate from casting.mjs so its tests stay untouched.
export function accentKey(direction) {
  const t = String(direction || '').toLowerCase();
  const keys = ['irish', 'scottish', 'british', 'australian', 'american', 'italian', 'french',
    'german', 'russian', 'indian', 'swedish', 'polish', 'spanish', 'japanese', 'chinese', 'african'];
  return keys.find((k) => t.includes(k)) || null;
}
