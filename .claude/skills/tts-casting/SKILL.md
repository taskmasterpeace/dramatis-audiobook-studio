---
name: tts-casting
description: Use when casting voices, choosing TTS engines, writing voice personas/style prompts, auditioning candidates, or budgeting voice spend for any DRAMATIS book. Covers Kokoro, Qwen3-TTS, ElevenLabs v3, Gemini 3.1 Flash TTS, and SAPI — voice rosters, control surfaces, pricing, per-engine gotchas, and the audition discipline. Triggers - "cast this book", "pick voices", "which engine for", "narrator voice", "accent", "audition", "voice DNA", "hero lines".
---

# TTS Casting — every engine, every voice, when to use which

**REQUIRED SIBLING:** the `sound-design` skill governs SFX cues and ambience —
including the law that the cast are the ONLY voices in the mix (no vocal SFX cues).

The product rule this skill enforces: **nothing is cast by default — candidates are
auditioned in isolation and a human picks.** Robert's words: "I'm more concerned about
having a selection that's been tested" than locking into one engine.

## The five engines

| Engine | Voice selection | Control surface | Cost | Best for |
|---|---|---|---|---|
| **Kokoro-82M** (local, CPU) | ~26 preset ids (`af_*`, `am_*`, `bf_*`, `bm_*`) + `speed` | none beyond speed | $0 | long narration, fast drafts; NOT accents |
| **Qwen3-TTS 1.7B** (local, GPU) | **a sentence you write** (VoiceDesign → frozen clone) + per-line instruct | full voice design incl. **accents**, age, timbre; emotion via instruct | $0 | authentic character casting (e.g. "light Mandarin-accented English"), any accent Kokoro/11L can't do |
| **ElevenLabs eleven_v3** (API) | account roster **by name** (with fallback candidates) | audio tags `[angry]` `[whispers]`…; stability detents 0 / 0.5 / 1 | ≈ $0.22/1k chars (Creator) | premium acting on hero lines; Robert's custom narrator voices |
| **Gemini 3.1 Flash TTS** (API — Google or Replicate) | 30 named voices | **strongest direction**: style `prompt` (persona + scene + director's notes) + inline `[tags]` mid-sentence | $2/M input tok + $0.04/1k output tok (≈ measure $/min on first render before trusting any estimate) | emotional cast members, directed performances; Robert: "said to be the absolute best emotional model, dirt cheap" |
| **SAPI** (Windows) | installed system voices | SSML rate/pitch | $0 | legacy fallback only — Robert: NO Windows voices in product output |

## Casting rules (learned the hard way)

1. **The narrator is a cast member.** Biggest single voice decision in any book —
   narration is ~85% of chars. Currently all three books use Kokoro `bm_george`.
   Robert leans ElevenLabs for the narrator (he has a favorite narrative voice in his
   roster — confirm which). 11L narrator math: 10-hr book ≈ 500k chars ≈ $110 — decide
   with eyes open, per book.
2. **Accent is a hard requirement, not a nice-to-have.** Liu Xiao (elderly Chinese
   masseur) shipped voiced by `am_onyx` — an American preset. Wrong. When a character's
   identity implies an accent, only Qwen3 (design sentence) or Gemini (style prompt
   "Accent: …") can deliver it. Never cast a preset-voice engine against an accent
   requirement.
3. **A/B one variable at a time.** The first Liu comparison clip swapped the narrator
   AND the actor at once — useless. Audition = one role, one line, voice-only
   (cut from `stem-dialog.wav` or render the single line), engines/candidates varied
   one at a time.
4. **Audition before committing.** Render candidates for a role BEFORE a full chapter
   render. Per-line caching makes auditions ~free to re-play; a wrong full-book cast
   costs hours of GPU or real credits.
5. **Hero-line dial = the 11L/Gemini budget.** In hybrid routing, only emotion-tagged
   lines hit paid engines. Measured: restrained tagging (short climax cries) ≈
   $0.62/finished-hr all-in; tagging long monologues ≈ $2/hr; all-dialogue-premium ≈
   $2–3.50/hr. Zero tags = $0.
6. **Engine-per-ROLE, not engine-per-book.** The voice map already supports it
   (hybrid `@refs`). Target state: narrator on 11L, Liu on Qwen3 (Mandarin accent),
   minor parts on Kokoro, emotional cast on Gemini — all in one book.

## THE VOICE DESIGNER — describe a person, hire an actor (built 2026-07-20)

Casting Room → **✨ Design a Voice**. Robert's ask: "we need an easier way to design
our own voice… calculate all that stuff behind the scenes and make my new cast member."
Flow: plain-English description → `determine()` infers gender/age/accent → a
**slate of one candidate per engine**, each carrying the reasoning that picked it →
audition all → **Hire** writes `actors/<slug>/`. Code: `src/voicedesign.mjs`
(`candidateSlate`), routes `POST /api/casting/{design,audition,hire}`.

**The approved take IS the seed clip** — that's why the audition line is ~13 s
(`SEED_LINE`), inside the 8–15 s clone sweet spot. `hire` ffmpeg-normalises to
24 kHz mono, so an 11L mp3 preview and a Gemini wav both land as valid clone refs.
One render, no second pass.

Selection logic worth keeping straight:
- **Gemini**: gender is a hard filter; then TEXTURE (description words → Google's
  published one-word characteristic) then AGE. **Age must outrank texture** —
  "warm elderly woman" has to land on Gacrux (the only aged-reading female, our
  ear-approved `nola-elder`), not Sulafat (Warm).
- **ElevenLabs**: scored against the user's OWN roster labels; absent, never
  invented, when the roster can't be fetched.
- **Kokoro**: best published GRADE that fits gender+accent, and it self-declares
  `⚠ can't do accents` when an accent was detected.

## KOKORO — the published quality grades (researched 2026-07-20)

**54 voices installed** (we were only exposing 28). Upstream publishes a grade per
voice and NOTHING else — no timbre notes; the entire catalog's character metadata is
three emoji. The grade is the field that matters and we were discarding it: it
separates the ~5 audiobook-grade voices from the 20 that sound rough.

**The only voices worth narrating with:** `af_heart` **A** (flagship), `af_bella`
**A-**, `af_nicole` **B-** (close-mic), `bf_emma` **B-** (best UK), `ff_siwis` **B-**
(French). Then a C+ tier (`af_aoede/af_kore/af_sarah`, `am_fenrir/am_michael/am_puck`,
`jf_alpha`). Our house narrator `bm_george` is only a **C**; `am_adam` is **F+** —
never cast it. Full table: `src/voice-tables.mjs`.

**Voice BLENDING works** and is the free tier's real design lever — pass a numpy
array as `voice=` instead of a string: `(v1*0.6 + v2*0.4).astype(np.float32)` over
`get_voice_style()` output. Verified deterministic (self-blend is bit-exact with the
plain voice, so blends cache correctly). **Gotcha:** blend the WHOLE `(510,1,256)`
array — the style is length-conditioned and indexed by token count, so a `(1,256)`
slice raises IndexError. There is **no pitch control** — the ONNX graph takes only
tokens/style/speed. Blend or post-process; that's all there is.

**Bug found + fixed 2026-07-20:** `kokoro-batch.py` derived language as
`"en-gb" if voice.startswith("b") else "en-us"` — so all 26 non-English voices were
fed **American English phonemes**. Now `LANG_BY_PREFIX`. Note `fr-fr` and `cmn` are
the valid codes; bare `fr` and `zh` are rejected.

## GEMINI — the tag hazard that was in our shipped audio (researched 2026-07-20)

Google documents **four tag behaviours**, and one of them is a trap:
- Mode 1 non-speech (`[sigh] [laughing] [uhm]`) — safe, documented.
- Mode 2 style modifiers (`[sarcasm] [robotic] [shouting] [whispering]`) — safe.
- **Mode 3 VOCALIZED — the tag is SPOKEN ALOUD as a word.** Triggered by exactly the
  adjective/adverb shape. Google: *"likely an undesired side effect for most use cases."*
- Mode 4 pacing (`[short pause]` ≈250 ms, `[medium]` ≈500, `[long]` ≈1000+) — safe.

**We were emitting Mode-3 shapes on every emotional line** — `[angrily]`,
`[sadly]`, `[curiously]` — with a fallback that emitted bare nouns (`[sadness]`), the
highest-risk shape of all. **Fix: emotion now rides in the PROMPT, not in tags**
(`EMOTION_DIRECTION` in `gemini.mjs`), which is also what Google recommends. `prompt`
and `text` are separate API fields and the prompt is built per call, so per-line
direction costs nothing.

Two more prompt rules, each traceable to a documented failure:
- Header must be **`PERFORMANCE`**, never `DIRECTOR'S NOTES` — that literal string has
  been observed spoken, apostrophes being a classifier hazard.
- **Never send a vague prompt.** Google warns it can trip the synthesis classifier
  (`PROHIBITED_CONTENT`) or make the model read the notes aloud. Always open with an
  explicit synthesis imperative.

**THE LENGTH GATE — and the phrasing law it uncovered (2026-07-20).** Removing the
tags was not enough: Google's *other* documented failure is reading the style
direction **aloud**, and prose direction can trigger it. There is no ASR here, so
the machine gate is **duration** — a spoken direction adds seconds of speech that
is not in the script. Measured on a 33-char line (8 emotions × 2 prompt shapes ×
3 reps): legitimate delivery lands **0.9–2.1×** the neutral duration; the fault
reproduced at **3.8–6.2×**. `synthJobGated()` budgets `max(3× expected, expected+3 s)`
at 14 chars/sec, **re-rolls twice** (generation is non-deterministic) and then
**throws with the line id, entity and prompt tail** — same discipline as the Qwen3
register gate: measure the output, retry, refuse. A `+8 s` floor was tried first
and let a 4.1× render through on a short line; +3 s catches it.

**PHRASING LAW: every emotion direction must read `This line is <adjective> —
<delivery detail>.`** The one entry that deviated (`This line lands as a shock — …`)
rendered **3.83× over length, reproducibly, on every single pass**. Swapping ONLY
the opener to `This line is shocked` — identical trailing clause — measured
**0.99×**. It was the unusual phrasing, not the content, the length, or the
em-dash. Also never instruct an unbounded non-speech sound ("a caught breath
before it") — describe the speech and let delivery imply it. Verified clean run:
all 8 emotions 1.05–1.43×. Clips: `out/eartest-gemini/`.

**`language_code` is free accent leverage** (87 values; `en-GB` / `en-IN` / `en-AU`
are stronger than prompt wording alone) — now set from the detected accent. Trap:
our accent directions all end "…speaking English", so a naive `/english/` test sent
**New Orleans to en-GB**. American regions must be tested first.

**Custom voices on Gemini: definitively NO.** The `voice` field is a closed enum of
30; cloning lives on a different, allow-listed model family (Chirp 3). So a Gemini
character IS `(voice, prompt, language_code)` — which is exactly why seed-then-clone
-into-Qwen3 is not a workaround but the only way to make one permanent.
Only 4 of the 30 carry any age/texture signal in Google's own words: **Leda**
(Youthful), **Gacrux** (Mature), **Algenib** (Gravelly), **Enceladus** (Breathy).
Multi-speaker is NOT supported on the Replicate endpoint — one voice per call.

## ELEVENLABS — voice design, and the limit that actually bites

`POST /v1/text-to-voice/design` → returns **exactly 3 previews** → `POST /v1/text-to-voice`
saves one. Only `voice_description` is required (**20–1000 chars**); `text` 100–1000;
`model_id` is `eleven_multilingual_ttv_v2` (default) or `eleven_ttv_v3` (the only one
taking reference audio). **Cost = 1 credit per character of preview text, charged ONCE
for all three** — so a design call can never exceed ~1000 credits. Quota accounting
lags 1–2 min; don't read-after-write.

**The scarce resource is voice SLOTS, not characters.** Account (2026-07-20): Pro,
**982,767 chars/cycle with 899,836 left**, overage enabled up to +1M — ~2M characters
before any wall, i.e. rendering is effectively unlimited. But **144 of 160 voice slots
are used, only 16 free, and `can_extend_voice_limit: false`.** Designing and
previewing costs NO slot (nothing persists until you save), so audition freely — but
**never auto-save a designed voice into the account.** DRAMATIS saves the preview
audio as a local seed clip instead: same voice, zero slots, and it clones into Qwen3
for free volume.

Per-request caps: flash_v2_5 40k · flash_v2 30k · multilingual_v2 10k · **eleven_v3 5k**.
Exceeding tier concurrency queues (~50 ms), it does not error.

## Kokoro — preset ids proven in production

`bm_george` (house narrator so far), `am_onyx` (deep US male), `am_eric`, `am_michael`,
`am_adam`, `am_echo`, `am_liam`, `am_puck` (young), `am_fenrir`, `af_sarah`, `af_nicole`,
`bm_lewis`, `bf_emma`, `af_heart`, `af_bella`. Full list: `python -c "from kokoro_onnx
import Kokoro; ..."` or kokoro-onnx docs. Speed 0.9–1.1 is the useful range.
Voice map shape: `{ "voice": "bm_george", "speed": 1.0 }`.

## THE REGISTER GATE — no designed voice ships unheard by a machine

**Incident 2026-07-19 (Robert, furious, correctly):** an "elderly Black woman
from New Orleans" design was delivered sounding unmistakably MALE. Autopsy by
measurement: the clone step drifted the female design to 106 Hz; a poisoned
pre-gate cached reference made it unfixable by retry; and the listener was the
first quality check. Three failures, three fixes, all in `qwen3-batch.py`:

1. **Design refs are pitch-gated** at creation (librosa pyin; female > 170 Hz,
   male < 150 Hz, from gender words in the design text) with reinforced-prompt
   retries; a failing design RAISES — it never caches.
2. **Cached refs are re-verified on every load** (pre-gate cache poisoning was
   the actual root cause).
3. **Clone output is gated too** (first line per entity) — drift → corrective
   instruct re-clone → still wrong → RuntimeError, refusing to ship. Verified
   live: the gate refused twice, then a clean regeneration measured 203 Hz.

**Standing regiment:** `node scripts/voice-regiment.mjs` — 8 gendered/aged/
accented designs, one batch, every output independently pitch-verified over
the engine's own gate; exit 1 on any mismatch; report at
`out/voice-regiment-report.json`. Run it after ANY change to the qwen3 engine,
models, or venv. **First full run 2026-07-19: 8/8 PASS in 244 s** (females
185–311 Hz, males 87–136 Hz — incl. a fresh NOLA-elder design at 214 Hz). Auditions of designed voices: check `pitch-check.py` output
before delivering to a human, always — the human ear is the last gate, never
the first.

## ROUTING LAW — match the tier to the job (the obstacle Robert named 2026-07-19)

Every quality failure this project has hit was the CHEAP tier asked to do a HARD
job. The fix is never "gate harder" — it's route right.

- **Qwen3 VoiceDesign is weak on fine attributes.** It nails "a distinct voice,
  free, at scale" and (post-gate) gender. It does NOT reliably deliver AGE
  ("elderly NOLA woman" came back sounding young-as-hell at 203 Hz), specific
  regional accent texture, or a signature character timbre. Use it for
  background/minor cast, not hero voices with specific age/accent.
- **Hero voices with age/accent/character → premium tier.** ElevenLabs first
  (real aged timbre lives on the roster: "[ElevenVoices] African Female Old",
  "Madison - wise old lady", "Sarah/Bill - Mature"), then Gemini (mature voices
  like Gacrux + heavy director's note), then Seed Audio (age+accent+emotion in
  one shot). Measured: 11L elder = 180 Hz aged female; Gemini mature = 152 Hz.
- **The local tier is the FLOOR, not the goal.** Free + unlimited + decent.
  Premium is the ceiling, spent where it matters. DRAMATIS's value is the
  ROUTING + approval, not "everything free."

## CHARACTER ACTORS — the confirmed economic engine (ear-verified 2026-07-19)

Robert's ranking for characterful voices: **Gemini #1** ("really got her talking
like she's from New Orleans"), 11L #2, Qwen3 design distant. The pattern that
makes it scale, ALL steps ear-confirmed on the NOLA elder:
1. **Seed** the character once on Gemini (directed prompt) or 11L — paid, perfect.
2. **Clone** the seed into Qwen3 (`clone-from-audio.py`, 8–15 s ref + transcript)
   → unlimited FREE lines in that voice. Robert on the clone speaking a brand-new
   line: "sounds like a Black lady, she sounds older... really, really good."
   Both 24 s-ref and 12 s-ref clones passed his ear (12 s is still the spec).
3. **Set-pieces/trailers**: the same seed clip goes to Seed Audio as
   `audio_urls` reference (@Audio1) — the character narrates trailers with full
   cinematic sound in one pass (verified: TRAILER-water-remembers-nola.mp3).
A saved seed clip = a PERMANENT company member. Seeds live in the tracked
`actors/<name>/` (seed.wav + transcript.txt + origin.json = engine/voice/prompt)
so any engine (Qwen3 clone via clone-from-audio.py, Seed Audio `audio_urls` ref,
future 11L clone) can re-hire them. Company so far: **nola-elder** (Gemini Gacrux,
New Orleans elder — Robert's #1) and **liu-xiao** (Gemini Enceladus, elderly
Mandarin-accented — the redo of the wrong Kokoro-American original).

## Qwen3-TTS — DEEP research (2026-07-19, corroborated across repo + HF + report)

It's **Alibaba** (not ByteDance), Apache-2.0, three separate checkpoints:
VoiceDesign / CustomVoice / Base. Output is **24 kHz mono** ("12Hz" = tokenizer
frame rate, not audio). English is first-class. Use the 1.7B, never 0.6B.

**Why "elderly NOLA woman" came out young — now understood:** a ONE-SENTENCE
design is the wrong mental model. The model weights concrete acoustic descriptors
far above the bare "old"/"elderly" token, and short utterances destabilize
timbre. Age drifts unless you (a) use **specific years** ("in her 80s" not "old"),
(b) **stack aging physiology** (reedy, quavering, breathless, scratchy, slow, low
energy), (c) write **2–4 sentences / 40–80 words** (instruct caps 2048 chars), and
(d) reuse the EXACT string (generation is non-deterministic). Accent is fragile
even so — always phrase origin→target ("New Orleans accent speaking English").

**Design recipe (elderly/accented):** key-value + stacked cues, e.g.
"Gender: female. Age: in her late 70s. Pitch: low, warm. Texture: reedy,
weathered, a slight quaver, breathy with age. Pace: slow, unhurried, musical.
Accent: deep New Orleans Southern Black, speaking English." Keep the SPOKEN line
short-to-medium; keep the instruct rich.

**CLONING BEATS DESIGN for age+accent (the key finding).** Age/accent carried in
a reference survive better than described ones. Engine: `clone-from-audio.py`
(`create_voice_clone_prompt(ref_audio, ref_text)` once → reuse; then
`generate_voice_clone`). Requirements that MATTER:
- **Reference 8–15 s, mono, ≥24 kHz, clean, one speaker.** Quality DEGRADES past
  ~15 s (measured: our 24 s ref gave a wobblier clone than a 12 s trim).
- **Provide ref_text** (accurate transcript) — raises speaker similarity ~0.75→0.89.
- **Cloning from another engine's output WORKS** — this is the "premium seed,
  local volume" pattern: voice a hero line on Gemini/11L (great, paid), clone it
  into Qwen3, generate unlimited lines free. THIS is what "character actors"
  means in practice — a small stable of cloned premium voices reused across books.
- **`instruct` does NOT work on clone** (only Design/CustomVoice). Per-line emotion
  on a cloned voice = bake it into the reference clip, or route that line elsewhere.

**CustomVoice presets** (exact `speaker=`): Ryan, Aiden (English males); Vivian,
Serena, Uncle_Fu, Dylan, Eric (Chinese); Ono_Anna (JP), Sohee (KR). CustomVoice
DOES honor instruct — the one mode with preset timbre + per-line emotion.

**Gotchas:** infinite-generation loops (cap max_new_tokens); duration instructions
ignored; keep lines 500–1500 chars.

## Qwen3-TTS — write the voice as a sentence

Voice map shape: `{ "design": "<persona sentence>" }` or `{ "speaker": "Ryan" }` (preset).
Design sentences that worked tonight:
- "Elderly Chinese man in his 70s; thin, weathered voice with quiet strength; slightly
  breathy; light Mandarin-accented English." (Liu — the accent lever, verified)
- "Elderly Englishwoman; soft motherly voice that can turn sharp, keening and frantic;
  aged but strong." (Mrs. White)
- "Deep weathered baritone; measured, haunted, formal." (Sgt.-Major Morris)
Pattern: age/identity + timbre + delivery + accent. The design renders ONE reference
clip (cached in `out/voices/qwen3/`), then all lines clone from it — so the persona is
frozen per character; per-line emotion goes through instruct ("Speak with a very
fearful tone."). Engine: `engines/tts/qwen3.mjs` + `qwen3-batch.py` (resumable chunks).

## ElevenLabs — Robert's account roster (fetched 2026-07-18)

Stock: George, Brian, Daniel, Bill, Callum, Archer, Alice, Matilda, Rachel*, Sarah,
Laura, Charlie, Chris, River, Harry, Liam, Jessica, Eric, Bella, Adam, Roger, Will,
Lily, Hope, Juniper. (*Rachel resolves via fallback; verify.)
**Custom / narrator-flavored (the interesting ones):** "Robert Task Smith (Narrator)",
"Bruce - Deep American Narrator Voice", "Action Novel: PERFECT male narrator",
"Alexander Kensington - Studio Quality", "W. L. Oxley", "Michael Caine™ - British Icon",
"Madison - wise old lady", "Narrator A", plus ~100 "Dynamic Voice <timestamp>" entries
(AIOBR-generated; ignore for casting).
Resolution: name matched case-insensitively against `name.split(' - ')[0]` — so
candidates use base names. Voice map shape:
`{ "candidates": ["George","Eric","Bill"], "stability": 0.5, "style": 0.4 }`.
v3 snaps stability to 0/0.5/1. Emotion → tag prepended (`[angry] `). Model id is in
the cache key (v2/v3 renders coexist).

## Gemini 3.1 Flash TTS — the direction-heavy engine (BUILT & ROBERT'S #1 for characters)

**Status: live** in `engines/tts/gemini.mjs` via Replicate (`REPLICATE_API_TOKEN`),
~7 s/line, and Robert's #1 for characterful voices — it's the only engine that
takes a director's note as first-class input ("deep New Orleans Southern Black"
landed an elderly NOLA woman that made his jaw drop). Voice map shape (REAL, not
planned): `{ voice: "Gacrux", prompt: "<style prompt>" }`.

Endpoints: Google AI (`ai.google.dev/gemini-api/docs/speech-generation`) or Replicate
(`replicate.com/google/gemini-3.1-flash-tts`). Replicate inputs: `text` (≤4,000 bytes,
supports inline `[tags]`), `voice` (default Kore), `prompt` (style, ≤4,000 bytes),
`language_code` (BCP-47). text+prompt ≤ 8,000 bytes; output ≤ ~655 s/call.

**30 voices** (gender · character): Zephyr F·Bright, Puck M·Upbeat, Charon M·Informative,
Kore F·Firm, Fenrir M·Excitable, Leda F·Youthful, Orus M·Firm, Aoede F·Breezy,
Callirrhoe F·Easy-going, Autonoe F·Bright, Enceladus M·Breathy, Iapetus M·Clear,
Umbriel M·Easy-going, Algenib M·Gravelly, Despina F·Smooth, Erinome F·Clear,
Laomedeia F·Upbeat, Achernar F·Soft, Algieba M·Smooth, Schedar M·Even, Gacrux F·Mature,
Pulcherrima F·Forward, Achird M·Friendly, Zubenelgenubi M·Casual, Vindemiatrix F·Gentle,
Sadachbia M·Lively, Sadaltager M·Knowledgeable, Sulafat F·Warm, Alnilam M·Firm,
Rasalgethi M·Informative.

**Style prompt pattern** (per character, maps 1:1 onto our `design` concept):
```
AUDIO PROFILE: <name>, <role>
THE SCENE: <where they are, what's happening>
DIRECTOR'S NOTES:
- Style: <delivery quality you must hear>
- Accent: <specific accent>
- Pace: <cadence>
```
**Inline tags**: `[whispering] [shouting] [sarcasm] [extremely fast] [sigh] [laughing]
[uhm] [short pause] [medium pause] [long pause]` + freeform (`[excitedly]`, `[bored]`…)
— test freeform tags before production (some get spoken aloud). Maps directly from
`line.emotion`.
**Pricing**: $2/M input tokens, $0.04/1k output tokens → measured ≈ **$0.001/line**
at audiobook line lengths (a hero line is cheap; whole-book narration would add up,
so it stays a character/hero engine, not the default narrator). Key:
`REPLICATE_API_TOKEN` (in `D:/git/aiobr/.env`).
**Robert's take**: best emotional model, dirt cheap, "very good for our actual actors."

## Casting is computed, not typed (src/casting.mjs — wired into the Studio)

`castingRecipe(entity)` reads the character description → `{gender, ageBand,
accent}` → a voice recipe (character tier = Gemini directed when there's an
accent or the age is child/teen/elderly; free Qwen3 design otherwise) plus what
the gate must verify. The Cast screen shows it as a Suggested strip with Apply;
**Screen Test** renders the same line through every configured engine side by
side with one-click "Cast this".

**Text-matching traps this cost us (all now covered by tests):**
- `\bwoman\b` never matches **"Englishwoman"** — compounds need `[a-z]*woman`,
  and `(?<!wo)man` so "woman" doesn't read as "man".
- Alias lists carry OTHER characters' possessives — **"his wife"** made every
  wife read male and cancel to unknown. Strip pronouns from `names` before
  gender inference.
- **"middle-aged"** contains `aged` — a middle-aged clerk was cast elderly.
Verifiable by machine: gender + child-high-pitch. NOT verifiable: elderly-age
and accent/ethnicity — those are directed + confirmed by ear, always.

## Robert's ear rulings (2026-07-19 listening session — these are canon)

- **Narrator = "Battlerap Algorithm" on `eleven_v3` (#1), `eleven_turbo_v2` (#2).**
  Ranked blind across the surviving models on identical news copy. (He expected
  to prefer the retired v1; among survivors v3 won outright.)
- Seed Audio set-pieces (car-crash interlock + lighthouse scene): "amazing" —
  SET-PIECE dept is ear-confirmed, not just probed.
- FSD50K door knock (119833): "really good" — retrieval quality confirmed.
- Fight-proof v1 REJECTED: wild-recording footsteps read as "barefoot on
  cement", the city-night bed read as "a helicopter", timing off. Fixes now in
  code: house-foley rank bonus (+0.08) in the SFX resolver; per-scene
  `ambience.source: "procgen"` override; cue-level swaps to house clips.

## The Casting Room (built 2026-07-19)

Studio → Casting Room: the full talent roster, auditionable BEFORE any book —
139 named voices (28 Kokoro + 30 Gemini + ~81 ElevenLabs account roster,
"Dynamic Voice *" junk filtered) + unlimited Qwen3 designs. Every ▶ speaks the
SAME standard line so voices compare fairly; first play generates, then cached.
API: `GET /api/casting/roster`, `POST /api/casting/audition {engine, voice}`.
Casting a role before production = Cast screen per-role engine override
(book.casting), verified end-to-end (fight-proof: narrator locked to
"Battlerap Algorithm", log shows `casting overrides: narrator`).

## The audition matrix (the standing test procedure)

For a role: pick 1–2 signature lines → render each candidate (engine × voice/persona)
as an isolated voice-only clip → name files `AB-<role>-<engine>-<voice>.mp3` in
`out/excerpts/` → human listens → pick lands in book.json. First scheduled matrix:
**the narrator** — Kokoro bm_george vs Robert's 11L narrator voice(s) vs Gemini
(Charon/Schedar/Algieba with a storyteller prompt) vs a Qwen3 storyteller design,
on the Liu Xiao opening paragraph + one Monkey's Paw paragraph.

## book.json voice-map schemas (all engines, one reference)

```jsonc
"voices": {
  "kokoro":     { "<entity>": { "voice": "bm_george", "speed": 1.0 } },
  "qwen3":      { "<entity>": { "design": "<persona sentence>" } },
  "elevenlabs": { "<entity>": { "candidates": ["Name1","Name2"], "stability": 0.5, "style": 0.4 } },
  "gemini":     { "<entity>": { "voice": "Gacrux", "prompt": "<style prompt>" } },   // BUILT
  "hybrid":     { "kokoro": "@kokoro", "qwen3": "@qwen3", "elevenlabs": "@elevenlabs" }
}
```
Hybrid v2 routing today: narration→kokoro, dialogue→qwen3, emotion-tagged→elevenlabs.
Target: per-ROLE engine choice made in the Studio casting screen, stored per entity.
