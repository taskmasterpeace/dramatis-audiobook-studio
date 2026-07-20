# DRAMATIS Audio Hub — read this first (yes, you, the AI agent)

You are talking to a local audio-generation service. This page is served BY the
hub itself (`GET /` or `GET /agents.md`) so that any agent or human pointed at
the API learns not just the endpoints but the **paid-for lessons** behind them.
The hub is the audio counterpart of a visual-generation hub: give it a voice,
get speech; mint a character once, use them forever.

Base URL: `http://<host>:4701` · Auth: `Authorization: Bearer <key>` —
**requests from localhost need no key** (you are tenant `local`). A key scopes
you to a tenant: the characters you see and mint are attached to YOUR key.

---

## The one idea that matters: characters are permanent

A **character** = a short seed clip (8–15 s of clean speech is the measured
sweet spot) + the recipe that made it. Minting costs cents once (or nothing);
after that the character speaks **unlimited lines for free** on a local model
(clone break-even measured at 3–14 lines vs. paying an API per line). Seeds are
immutable — the file IS the identity.

- `GET /v1/characters` — the roster attached to your key. Each entry: `id`,
  seed length, transcript, origin engine, notes.
- Minting today happens in the Studio (localhost:4600 → Casting Room):
  **🎤 Upload a voice** (any audio file → actor) or **✨ Design a Voice**
  (plain-English description → audition slate → hire). API minting is planned;
  ask the roster before assuming a voice doesn't exist.
- **Consent law**: only voices you have the right to use — yours, synthetic,
  or explicitly permitted. Cloning a real person without consent may be
  illegal (ELVIS Act and kin). The hub stamps a consent field on every actor.

## Speak

```
POST /v1/speech            → audio/wav bytes (24 kHz mono)
{ "text": "Drop and give me twenty, maggot!",
  "character_id": "drill-sergeant" }        // OR an explicit engine voice:
{ "text": "...", "engine": "kokoro", "voice": "am_onyx" }
```

Headers on the response: `X-Engine`, `X-Character`, `X-Cache: hit|miss`,
`X-Seconds`. Identical requests are content-addressed — **a repeated line is a
cache hit and costs zero GPU time**, so cache your (character, text) pairs
client-side by all means, but don't fear re-asking.

`character_id` routes to a FREE local clone of that character's seed (Qwen3).
First request per character warms the model (~a minute); after that, seconds
per line. For **runtime** speed (a game reacting NOW), use `engine: "kokoro"`
(CPU, ~1 s per short line) with a preset voice — pre-bake character lines
ahead of time instead.

## Which engine, honestly (measured, not marketed)

| Need | Use | Why (measured) |
|---|---|---|
| A minted character speaking | `character_id` (Qwen3 clone) | $0/line, identity-stable; per-line EMOTION IS IMPOSSIBLE on clones (instruct is silently dropped — upstream-confirmed), so bake emotion into the seed or pre-bake variants |
| Fast runtime line, any decent voice | `kokoro` + preset | ~1 s CPU; 509-phoneme cap is chunked for you; NO emotion control at all |
| A directed one-off performance | `gemini` + a director's note | The only engine that takes free-text direction; ~7 s/line, ~$0.0065/line; adjective [tags] get SPOKEN ALOUD — put emotion in the prompt as "This line is <adjective> — <delivery>" |
| Hero-grade acted line | `elevenlabs` (v3) | Audio tags work; `style`/`speed` are silently IGNORED on v3; stability 1.0 suppresses tags; monthly credit pool is the real ceiling |

## Pre-baking packs (games: do this)

Batch your character's barks at build time — one request per line, let the
cache absorb repeats, ship the wavs with the game. 1,000 pre-baked clone lines
cost ~$0 and a coffee break of GPU time. A `POST /v1/packs` batch endpoint is
planned; until then, loop `POST /v1/speech`.

## Produced scenes — the Seed Audio card (planned endpoint, learn it NOW)

For trailers/set-pieces there is a fundamentally different tool: one-pass
PRODUCED audio — dialogue + SFX + music as a single balanced track
(`bytedance/seed-audio-1.0` on fal, verified against its live schema).
What an agent must know before reaching for it:

- **Your minted characters can star in it**: pass up to 3 reference clips
  (`audio_urls`, each ≤30 s) and address them as `@Audio1..3` in the prompt —
  a character's seed.wav is exactly the right input. Or pre-clone once for a
  `speaker_id` valid 12 months.
- **It also takes a reference IMAGE** (`image_url`) — a character portrait or
  keyframe can condition the scene. NOTE: image and audio refs are MUTUALLY
  EXCLUSIVE per call — choose voice-anchored OR image-anchored.
- **No stems. A print, not a session.** You cannot duck the music, fix one
  word, or master it afterward — you re-generate. Never use it for book
  chapters; always for shorts (~2 min max, ~$0.19/min).
- **Timing is prose, not timestamps**: speaker turns and bracketed directions
  work; numeric timing does not. Write the scene as ordered narrative beats.
- Emotional range: elderly voices evidenced; children/babies/distress are
  UNPROBED — budget a ~$1 test before promising them.

## Long-form (audiobooks)

The full manuscript → chaptered M4B pipeline lives in the same repo (the
Studio drives it; `POST /v1/books` is the planned hub wrapper). Everything is
per-line cached, so a re-render after an edit costs one line, not a book.

## Rules the hub enforces (don't fight them, they're load-bearing)

1. Machine gates first, human ear last — voices are pitch-gated, Gemini is
   duration-gated. A refused render is the system working.
2. Nothing under narration sings or speaks except the cast.
3. Engines whose licences we could not verify DO NOT EXIST here.
4. Free tier runs on free engines; paid engines are routed deliberately.
5. Everything expensive is content-addressed. Same input, same audio, no
   double billing.
