---
name: sound-design
description: Use when adding, triaging, or debugging SFX cues and ambience beds in DRAMATIS — before rendering a new book's cue list, when a listener reports a wrong/out-of-place sound, when writing cue specs by hand, or when reviewing analyzer-drafted cues. Triggers - "weird sound in the mix", "background talking", "wrong sound effect", cue triage, ambience type unknown, retrieval picked a bad clip.
---

# Sound Design — cue and ambience discipline

## Overview

CLAP retrieval matches **meaning, not correctness**. A cue spec is a search query
against 2,399 real recordings; the top hit is a candidate, never a verdict. Every
law below was paid for in production on 2026-07-18/19.

## The Laws

**1. The cast are the only voices in the mix.**
Never write an SFX cue for anything a human utters — the TTS cast already performs
every line. A vocal cue double-casts the scene with a stranger from the library.
*Paid for:* analyzer cue "human voice calling out" retrieved "Attention Class.wav —
Teacher screaming at class" into minute 1:48 of Dickens' The Signal-Man; 14 sibling
cues placed the same horror scream (Scream.aif) eight times.
Enforced in code: `src/scaffold.mjs` drops vocal specs (regex over
voice/yell/scream/whisper/laugh/sing/…); `engines/sfx/retrieve.mjs` fetches top-3
and skips candidates whose CAPTION reads as speech unless the spec explicitly asks
for vocals. Do not weaken either filter; extend both if a new vocal synonym slips
through.

**2. Similarity is not correctness — read the caption.**
sim ≥ threshold means "closest in the library," not "right."
*Paid for:* "door slam bang" → top-1 at 0.67 was a **towel hitting a wall**;
"low rumble, vibration" → 0.436 was **two notes on a bass guitar**.
Rule: before trusting any cue with sim < 0.5, read `qa-report.json` →
`cues[].caption`. Category mismatch (musical instrument for a mechanical sound,
weather for an object, speech for anything) → swap or reject in the Studio's
Script tab, or set `approval` on the cue in book.json.

**3. Analyzer cue lists are drafts, not decisions.**
The analyzer over-cues by design (58 cues on one Signal-Man chapter; 15 were
vocal). Triage before the first render — see procedure below.

**4. Ambience must be real, consistent, and typed.**
Beds come retrieval-first (`engines/ambience/retrieve.mjs`): one source clip per
ambience TYPE, reused everywhere — a book's rain is always ITS rain. Only the
known types exist: `rain, roomtone-morning, room-hum, crowd, city-night,
lab-cold, battle`. Anything else (analyzer once emitted `silence`) must be mapped
to a known type — scaffold sanitizes, but hand-edits must respect the list.

**5. Placement is code, not vibes.** Transients land at anchor-word onset +100 ms,
≥500 ms apart, clamped to the line span. If a sound feels late/early, fix the
anchor text, never the offset first.

## Cue triage procedure (run on every new book)

For each cue in book.json (or qa-report after a draft render):
1. Vocal spec? → delete (Law 1 — scaffold should have caught it; if not, extend the regex).
2. Caption category ≠ spec category? → Script tab → hear it → Swap to a listed
   alternative or Reject.
3. sim < 0.45? → listen before shipping; below 0.25 it already fell back to
   procgen/skip — check the fallback made sense.
4. Sounds right? → Approve (locks it against re-analysis).

## Debugging a "weird sound at M:SS"

`qa-report.json` → find `cues[]` entry with `at` ≈ the timestamp → its `caption`
names the actual source recording → the wav is content-addressed in `out/cache/`
(key: `sfx@2|spec|dur`). Diagnose by CATEGORY (vocal? wrong object? weak sim?),
fix at the right layer: spec text (book.json) < swap/reject (approval) < filter
(scaffold/resolver code). Re-render is cheap — TTS is cached; only the mix re-runs.

## Red flags — stop and triage

- Any cue spec containing a vocal word (voice, yelling, scream, whisper, chant…)
- A caption you haven't read on a sim < 0.5 cue
- An ambience type not in the known list
- "The analyzer chose it, so keep it" / "sim is above threshold, so it's fine"
- Fixing a wrong sound by deleting it WITHOUT asking which layer let it through

## After any listener-reported miss

Fix it, then **record the incident in this file** (law + what it retrieved +
timestamp) and extend the responsible filter. The fix is step one; the lesson
captured here is the deliverable.
