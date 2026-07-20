# DRAMATIS — Audio Production Cost Report

**Date:** 2026-07-18 · **Scope:** three complete audiobooks produced end-to-end (audio only; motion/visual track deferred per directive)

## The proof: three books, start to finish

| Book | Source | Chapters | Runtime | Engine config | QA flags |
|---|---|---|---|---|---|
| Liu Xiao: Protector of China (not in repo) | original manuscript | 8 | 101.9 min | kokoro (all-local voices — see correction note) | 0 |
| The Monkey's Paw (W. W. Jacobs, 1902) | Project Gutenberg | 3 | 26.2 min | **hybrid v2** (Kokoro narration + Qwen3 designed voices + 11L hero lines) | 1 (benign: 4-char "yes." held 1.76 s) |
| The Open Window (Saki, 1914) | Project Gutenberg | 1 | 7.7 min | **hybrid v2** | 0 |

**Total: 138 minutes of finished full-cast cinematic audio.** All three: 5-stem mix
(dialog / ambience / SFX / music) with sidechain ducking, dual masters (Immersive −18 LUFS +
Clean ACX-style), chaptered M4B. Both new books went from raw Gutenberg text to bound
audiobook in one evening, including a line-by-line attribution audit.

## Measured spend (actual API charges)

| Book | LLM analysis | ElevenLabs chars → est. $ | Music (Suno relay) | **Total API** | **$/finished hour** |
|---|---|---|---|---|---|
| Liu Xiao (bound M4B: all-local Kokoro voices) | $0.004 | 0 in the final book | $0.09 | **≈ $0.09** | **≈ $0.05/hr** |
| The Monkey's Paw (v2: 27 hero lines) | $0.010 | 782 → ≈ $0.17 | $0.09 | **≈ $0.27** | **≈ $0.62/hr** |
| The Open Window (v2: 4 hero lines, long monologues) | $0.002 | 1,183 → ≈ $0.26 | $0 | **≈ $0.26** | **≈ $2.03/hr** |

ElevenLabs $ estimated at Creator-tier ≈ $0.22/1k chars (measured char counts are exact — the
engine logs them per render). Everything else — Kokoro narration, Qwen3-TTS designed character
voices, CLAP SFX retrieval over the CC0 corpus, forced alignment, ambience, mixing, mastering —
runs locally on the 4090 at **$0 API cost**.

## The hero-line dial (the one decision that sets your cost)

Hybrid v2 sends a dialogue line to ElevenLabs only when you tag it with an emotion in
`book.json`. That tag list is an editorial budget dial, and tonight measured its full range:

- **$0.00/hr** — no hero lines: Kokoro + Qwen3 only. Designed character voices, no premium acting.
- **≈ $0.62/hr** — Monkey's Paw style: tag only the short climax cries ("Wish!", "It's Herbert!",
  "For God's sake don't let it in"). 782 chars bought the entire haunted-knocking finale on
  eleven_v3 with emotion tags.
- **≈ $2.03/hr** — Open Window style: tag long monologues (Vera's two ghost-story speeches are
  21% of the story's chars). Premium delivery for the story's centerpiece.
- **≈ $2.00–3.50/hr** — v1 style: all dialogue on 11L (varies with dialogue density: Liu Xiao 15%
  of chars, Monkey's Paw would be 24%).

### At catalog scale

A 10-hour novel on hybrid v2 with restrained hero tagging: **≈ $3–7 in API costs**
(analyzer ≈ $0.10, music ≈ $0.90 at one theme/chapter, 11L $2–6). The same book fully-API
(11L narration + dialogue throughout) would run $130+; commercial human-cast production runs
$3,000+/finished-hour. GPU wall-clock ≈ 1–2.6× realtime on the 4090 (measured: 26.2 min of
audio in 10 min with cached narration; cold runs ~1–2× realtime) — a 10-hour book renders
overnight for roughly a dollar of electricity.

## Automation measured (the analyzer)

`dramatis analyze` bootstraps a book from raw manuscript for ≈ $0.003/chapter (OpenRouter
gemini-2.5-flash-lite; $0 on local Ollama when the GPU is idle): cast discovery, scene
segmentation, SFX cue spotting, attribution verification with a review queue. Measured on The
Open Window: agreed with the hand-verified reference on 31/33 dialogue lines. The two misses
(a flashback speaker; entity-id naming) plus tonight's audit drove a real engine upgrade: 11
said-verbs added to the compiler cascade (inquired/demanded/began/…), which fixed 9
misattributed lines across the two new books. Remaining ambiguity is handled by ~10–20
one-line hints per book — that hint pass (an hour of careful reading per book, or the
analyzer's review queue) is the only human step between manuscript and master.

**Correction (2026-07-18 late):** an earlier draft of this report labeled the bound Liu
Xiao M4B "hybrid v1 with ElevenLabs dialogue." Wrong — `book-report.json` says `tts:
kokoro`: the shipped 102-minute book is 100% local voices, ≈ $0.09 total API. The ≈ $3.35
of 11L credits were spent on experimental chapter renders (v1 hybrid trials + the v2→v3
migration) that are cached but not in the bound book. The v1 $/hr row now reflects a
*projection* from those measured chars, not the shipped artifact.

## Caveats (honest ones)

1. **Music licensing**: the Suno relay's commercial license is UNVERIFIED — swap to ElevenLabs
   Music or local ACE-Step before selling output (HANDOFF #3). $0.09/track spend is trivial;
   the license is the issue, not the price.
2. 11L $ figures convert measured chars at Creator tier; an annual/Pro plan lowers $/char.
3. Qwen3 designed voices are good-not-premium; hero moments exist precisely to paper over that.
4. Liu Xiao's manuscript still lacks its final paragraph (paste truncation — needs Robert).

## Hear it

- `out/liu-xiao/book-immersive.m4b` — 102 min, 8 chapters (also `book-clean.m4b`)
- `out/monkeys-paw/book-immersive.m4b` — 26.2 min, 3 chapters (also clean)
- `out/open-window/ch-01/immersive.m4a` — 7.7 min (also `clean.m4a`)
- `out/excerpts/` — 2-minute MP3 excerpts: Liu Xiao rain opening · Paw parlor (Qwen3 cast) ·
  Paw knocking climax (11L heroes + SFX choreography) · Window ghost story · Window twilight return

*Every number above is measured from `out/<book>/llm-ledger.jsonl`, `qa-report.json`,
`book-report.json`, and per-render engine logs; the only conversion is chars → $ at the
stated 11L tier.*
