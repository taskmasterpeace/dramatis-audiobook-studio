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
models, or venv. Auditions of designed voices: check `pitch-check.py` output
before delivering to a human, always — the human ear is the last gate, never
the first.

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

## Gemini 3.1 Flash TTS — the direction-heavy engine (NOT YET BUILT — engine slot open)

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
**Pricing**: $2/M input tokens, $0.04/1k output tokens. Effective $/finished-minute
unknown until first render — MEASURE IT and record here. Keys: `GEMINI_API_KEY`
(Google) or `REPLICATE_API_TOKEN` (check `D:/git/aiobr/.env`).
**Robert's take**: best emotional model, dirt cheap, "very good for our actual actors."

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
  "gemini":     { "<entity>": { "voice": "Charon", "prompt": "<style prompt>" } },   // planned shape
  "hybrid":     { "kokoro": "@kokoro", "qwen3": "@qwen3", "elevenlabs": "@elevenlabs" }
}
```
Hybrid v2 routing today: narration→kokoro, dialogue→qwen3, emotion-tagged→elevenlabs.
Target: per-ROLE engine choice made in the Studio casting screen, stored per entity.
