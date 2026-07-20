# CLAUDE.md — working on DRAMATIS

DRAMATIS turns a manuscript into a full-cast cinematic audiobook on the user's
own machine: every character gets a voice, sound effects land on the word that
triggers them, ambience and score sit under the dialogue, output is a chaptered
M4B. Public repo, Apache-2.0. This file is the handover: read it and you can
work here without re-learning the lessons that are already paid for.

## The laws (non-negotiable, each one bought with a real incident)

1. **Machine gates first, human ear last.** Bad audio is expensive to discover
   by listening. Designed voices are pitch-gated against their cast gender
   (`engines/tts/pitch-check.py`), Gemini renders are duration-gated (a style
   prompt read ALOUD instead of performed runs 3.8–6.2× long), books are
   validated before render (`src/validate.mjs`). The ear is the final check —
   it rules on things machines can't (a gate once called "register failure"
   what the ear correctly identified as *lost age*).
2. **Nothing under narration may sing or speak except the cast.** Music engines
   pin instrumental (caption law + `[Instrumental]` lyrics + `force_instrumental`
   where the API offers it); SFX retrieval has a vocal-caption guard.
3. **Verify code and weights licences SEPARATELY.** They differ (MusicGen: MIT
   code, non-commercial weights) and pipelines inherit their worst part
   (DiffRhythm looked Apache but its VAE inherits Stability's licence).
   **"Unverifiable" means NO** — a music relay was deleted for exactly that.
4. **Free tier is the default; premium is routed, not sprayed.** Kokoro narrates,
   Qwen3 does character volume, ACE-Step scores. Paid engines (ElevenLabs,
   Gemini) take hero lines, age/accent-critical casting, and anything the ear
   demands. Casting a preset-voice engine against an accent requirement is a
   known-wrong move.
5. **Everything expensive is content-addressed.** `hash(engine|voice|params|text)`
   across TTS, LLM analysis, alignment, SFX retrieval. If a change alters the
   AUDIO an existing key would return, **bump the engine tag** (`kokoro-onnx@2`)
   — a key that keeps promising audio it no longer produces is a broken key.
6. **Audition before committing; approve cues before they reach a mix.** Nothing
   is cast by default. The Casting Room and per-cue approval exist for this.
7. **NO PURPLE anywhere in any UI, ever.** House look: carbon graphite + signal
   cyan (#0D1116 / #3EC5CF). This is absolute.
8. **Incident → fix → captured lesson.** When something breaks, the fix is step
   one; writing the lesson down (test, gate, or doc) is the deliverable.
9. **Test candidates instead of trusting papers.** GLAP beat our CLAP on every
   published table and lost 28.3%→73.3% on our own corpus benchmark. Standing
   batteries: `scripts/retrieval-bench.py`, `scripts/candidate-tts-battery.py`,
   `scripts/voice-regiment.mjs`. Run them before adopting anything.

## Architecture in one paragraph

`bin/dramatis.mjs produce <book.json>` runs per chapter:
**Compile** (`src/compile.mjs` — manuscript → Production Script: speaker-attributed
lines with citations, scenes, cues; deterministic, golden-file-tested) →
**Cast** (voice maps per engine in `book.json`; `src/casting.mjs` infers
gender/age/accent, `src/voicedesign.mjs` builds audition slates) →
**Render** (`engines/tts/*` behind `engines/tts/registry.mjs` — the single
source of truth for engine ids, limits, chunking) →
**Align** (`src/align.mjs`, word onsets; an enhancement — failures degrade to
line-start cue placement, never kill a render) →
**Mix** (`src/mix.mjs` — 4 stems: dialog/ambience/SFX/music, sidechain ducking,
dialog sacred) → **Master** (immersive −18 LUFS + clean −19) → **Bind** (M4B).
The Studio (`studio/server.mjs` + `studio/app/` — zero-dependency node:http +
vanilla JS, no build step) is a cockpit over the same files. The filesystem is
the database: `books/<id>/book.json` is config, `out/` is renders, `actors/` is
the saved voice company (seed clip + recipe = a re-hirable actor).

## What to run

```
npm test                 # 15 tests incl. attribution snapshots + Gemini tag safety
node studio/smoke.mjs    # 13 integration checks against a live server
npm start                # Studio → http://localhost:4600
npm run doctor           # what's installed/missing, per dependency and engine
npm run setup            # fetch the Kokoro model (~340 MB)
UPDATE_SNAPSHOTS=1 npm test   # accept intended attribution changes
```

Keys/config: `.env` (gitignored) via `src/keys.mjs` — shared by CLI and Studio.
`.env.example` documents every name. Never print key values. Never commit `.env`.

## The model landscape (details: docs/MODELS.md, live table: Studio → Models)

Voices: Kokoro (free CPU narration; 509-PHONEME hard cap — chunk by phonemes,
chars lie), Qwen3-TTS (free GPU characters + cloning; **instruct is silently
dropped on clones** — per-line emotion on a clone is impossible, route it),
Gemini 3.1 Flash TTS (paid; the directed-performance engine; adjective bracket
tags get SPOKEN ALOUD — emotion goes in the prompt), ElevenLabs (paid; v3 tags;
**v3 silently ignores style/speed**; caps are real and chunked-around).
Music: ACE-Step 1.5 local free (default, by ear ruling), ElevenLabs Music opt-in.
SFX: CLAP retrieval over a CC0/CC-BY corpus (~7 GB, built locally, not in repo).
Chatterbox: adopted-gated (identity survives cloning, AGE doesn't, the emotion
dial is also a pitch dial). Seed Audio (fal): researched for trailers/set-pieces
— one-pass produced scenes, no stems, never a replacement for assembly.

## Pitfalls that have already cost time (don't rediscover them)

- **uv/pip install while a render's Python runs** corrupts the venv (Windows
  DLL locks). Check nothing is rendering first.
- **This tooling displays `//` as `\`** in some outputs — never transcribe
  comment/regex lines from tool output into an edit; type them.
- **PowerShell 5.1**: no `&&`, no ternary; native-arg quoting eats quotes in
  here-strings — use `git commit -F <file>` for multi-line messages; bulk-edit
  files with the Bash tool's `sed`, not `node -e` through PowerShell.
- **`node --test test/` (directory form) is broken on Node 25** — use bare
  `npm test` (the package script globs correctly).
- **Line endings are correctness here**: `.gitattributes` forces LF because
  `compile.mjs` cites by raw character offset; CRLF checkouts shifted every
  citation and broke snapshot tests with a baffling "0 lines changed" diff.
- **A fully-commented-out file passes `node --check`.** After any bulk edit,
  verify the DIFF, not just the syntax.
- **Windows venv layout** is `.venv/Scripts/python.exe` (POSIX: `.venv/bin/python`);
  `src/util.mjs pythonExe()` handles both — use it, don't hardcode.
- **Don't trust vendor 200s**: ElevenLabs accepts and ignores `style` on v3;
  Qwen3 accepts and drops `instruct` on clones. Silent acceptance ≠ support —
  verify effects, not responses.

## Working style that fits this repo

Comments explain WHY and cite the incident/measurement that motivated the code
("measured 2026-07-20: ..."). Zero npm runtime deps is deliberate — think before
adding any. Small files, plain JS (ESM), no build step, no framework. Tests are
`node:test` with golden files. When you fix a defect, leave the lesson where the
next person will trip: in the code comment, the test, or docs/MODELS.md. The
user's ear rulings are canon — record them verbatim where they decide something.
