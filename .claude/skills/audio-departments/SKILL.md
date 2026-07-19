---
name: audio-departments
description: Use when deciding which engine or pipeline handles a piece of audio in DRAMATIS — routing a new sound need, evaluating a new audio model/API, planning a scene's audio, or asking "what kind of audio is this and whose job is it". Triggers - "which engine for this", "where does this sound come from", departmentalize audio, new audio model evaluation, Seed Audio, single-pass audio, trailer audio, set-piece.
---

# Audio Departments — who makes every sound, and why

## Overview

Every sound in a DRAMATIS production belongs to exactly ONE of five departments.
The mix is 5 stems (dialog / ambience / SFX / music + master bus); a department
owns its stem, its engines, and its rules. When a new model appears (it will,
monthly), the question is never "should we switch?" — it's "which department
does it serve, and does it beat the incumbent THERE?"

## The departments

| Dept | Owns | Engines (incumbent first) | Law |
|---|---|---|---|
| **VOICE** | narration, actor dialogue, hero lines | Kokoro (narration $0), Qwen3 (actors $0, accents), ElevenLabs v3 (hero, ~$0.22/1k chars), Gemini 3.1 TTS (directed, ~$0.001/line) | The cast are the ONLY voices anywhere in the mix. Per-role casting via book.casting; audition before commit (Casting Room, 139 voices) |
| **FOLEY** | SFX one-shots, sequences | CLAP retrieval over FSD50K+house (2,409 clips) → 11L sound-generation into house library → procgen → skip | Never vocal; caption read on sim<0.5; approval gate; generated clips are SAVED (house compounds) |
| **ATMOS** | ambience beds per scene | CLAP retrieval (real recordings, same clip per type) → procgen | 7 known types only; consistency beats variety |
| **SCORE** | music underscore | ElevenLabs Music (commercial-safe default) → Suno/muapi (opt-in, license unverified) | Instrumental only, no vocals — Eleven Music sings lyrics if you let it |
| **SET-PIECE** | ≤2-min single-pass mixed sequences | **Seed Audio 1.0** (ByteDance via Segmind — NOT yet keyed/built) | Output is ONE BAKED FILE — treat as sourced material, never as the mix |

## APPROVED PROVIDERS (Robert's law, 2026-07-19)

**Replicate, fal.ai, or ElevenLabs — nothing else for now.** No Higgsfield, no
Segmind, no per-model one-off accounts. Any new model must be reachable through
one of these three (fal key lives in directors-palette-v2/.env.local as FAL_KEY;
Replicate token in aiobr/.env; ElevenLabs in yourehired/.env).

## SET-PIECE dept — Seed Audio 1.0 facts (PROBED LIVE on fal, 2026-07-19)

- **API (verified working):** `POST https://fal.run/bytedance/seed-audio-1.0`,
  header `Authorization: Key ${FAL_KEY}`. Input: `{ prompt, output_format
  (mp3|wav|pcm|ogg_opus), sample_rate (8k-48k), voice?, audio_urls? (≤3 refs,
  ≤30s each, tag as @Audio1..3 in prompt), image_url?, speed?, pitch? }`.
  Output: `{ audio: { url, duration, file_size, ... } }`. ~**$0.003/second**.
- **Probe A (interlocking SFX, no voices):** car-crash sequence — tires,
  impact, glass, hubcap spiral, engine death, siren — 19.8 s in one pass,
  ≈ $0.06. `out/excerpts/SEEDAUDIO-A-car-crash-sequence.mp3`.
- **Probe B (calibration, Robert's lighthouse prompt verbatim):** 55.7 s
  full scene (narrator + 2 characters + storm + fire + waves), ≈ $0.17.
  `out/excerpts/SEEDAUDIO-B-lighthouse-calibration.mp3`.
- **Prompt format is a screenplay** (this is the part that blew Robert away):
  `Name (voice adjectives, pace): "line"` per speaker, `[Background: wind picks
  up, low creaking]` for cues, stage directions in brackets. Stack descriptors
  (age + timbre + emotion + ROLE — "mentor" changes delivery). Specify output
  language explicitly. Emotions/timing/mix come back interlocked in one pass.
- **The dealbreaker for books: NO STEMS.** One mixed file — no ducking control,
  no per-line cache, no surgical re-render, no per-line QA, and multi-character
  voice consistency across chapters is not repeatable without reference audio
  everywhere. Robert's ruling: "I'd rather just use the actors." VOICE dept is
  not threatened.
- **Where it WINS (the good uses to find):**
  1. **Interlocking SFX sequences** — a car chase, a collapsing building, a
     bar brawl: effects that need to time against EACH OTHER. Generate the
     sequence as one designed clip → save to house library → place as ONE cue
     on the Foley stem. Fits our architecture perfectly (a cue is a cue).
  2. **Standalone set-pieces ≤2 min** — trailers, promos, intros/outros,
     radio-drama moments, social clips. Whole deliverable in one pass, no
     pipeline needed.
  3. Zero-shot voice cloning utility (30 s sample) — future casting tool.
- **Known weaknesses:** highly specific foley drifts (their own docs say keep
  foley direction abstract); news-anchor register sounds robotic; probably
  weaker than dedicated engines at each single thing — its power is the
  INTERLOCK, not the parts.
- **Next step when Robert supplies a SEGMIND_API_KEY:** probe with (a) one
  interlocking-SFX sequence (no voices — cast law holds even here) and (b) one
  lighthouse-style scene for capability calibration; record measured results
  here; then decide whether `engines/setpiece/seedaudio.mjs` earns a slot.

## Routing procedure for any new sound need

1. Is it a human utterance? → VOICE (cast it; never Foley, never Set-Piece in a book).
2. Is it one sound at one moment? → FOLEY (retrieve → generate-into-house → procgen).
3. Is it the room/world under a scene? → ATMOS (typed bed).
4. Is it emotional scoring? → SCORE (instrumental).
5. Is it many sounds that must time against each other, or a ≤2-min standalone
   deliverable? → SET-PIECE (single-pass; import result as sourced material).

## Evaluating the next new audio model (standing procedure)

Name the department it claims. Compare against that incumbent on: cost /
finished-minute, controllability (can we direct it?), repeatability (cache?
re-render?), stems-or-baked, license for commercial output. A model that beats
nobody in a department but does "everything at once" is a SET-PIECE candidate.
Record findings in this file — dated, with prices.
