---
name: manuscript-intake
description: Use when turning a manuscript into a production script in DRAMATIS — pasting/scaffolding a new book, fixing who-said-what (misattributed dialogue lines), writing or debugging hints, running the LLM analyzer, or budgeting analysis cost. Triggers - "wrong speaker", "attribution", "who says this line", "said-verb", hint not firing, analyzer, review queue, paste a story, scaffold a book, curly quotes.
---

# Manuscript Intake — from pasted prose to production script

## Overview

Two machines turn text into a cast-attributed script: the **deterministic
compiler** (`src/compile.mjs` — segmentation + attribution cascade, runs free on
every produce) and the **LLM analyzer** (`src/analyze.mjs` — drafts cast/scenes/
cues and verifies attribution, ledgered, ~$0.003/chapter). Human `hints` in
book.json outrank both.

## Manuscript rules (violations fail silently or loudly)

- Chapters split on `## ` headings; H1 front matter is skipped. No `##` → the
  scaffold wraps the whole text as one chapter.
- **Dialogue detection sees ONLY straight quotes** (`/"([^"]+)"/g`). Curly
  quotes render as narration. The scaffold normalizes “”‘’ automatically —
  hand-added manuscripts must be normalized too.
- Scene anchors must **prefix-match a paragraph**; cue/music anchors must be a
  **substring of a line**. A missing anchor THROWS at compile — every anchor
  gets grep-verified against the manuscript before it goes in a book.

## The attribution cascade (order is law — earlier wins)

1. **hint** (book.json) 2. **said-tag** (name near a SAID_VERB) 3. single cast
name in the surrounding narration 4. paragraph-initial actor 5. two-name-other
disambiguation 6. A/B exchange alternation (turn state RESETS at scene
boundaries) 7. action-beat actor 8. protagonist fallback.

- SAID_VERBS lives in `src/compile.mjs` — 2026-07-18/19 added eleven verbs
  (inquired, demanded, began, exclaimed, bawled, remarked, screamed, faltered,
  announced, pursued, admitted) after each missing verb caused REAL
  misattributions (e.g. "inquired Mrs. White" fell through to the wrong
  speaker). **When a misattribution traces to an untagged said-verb, extend the
  list — that fixes every book at once; a hint fixes only one line.**
- Entity `names` do the narration matching: word-boundary, multi-word allowed
  ("the old woman", "his father"). Watch collisions across chapters ("the
  visitor" = Morris in ch1, the company man in ch2 — scope names accordingly).
- Measured accuracy after tuning: 11/11, 37/37, 30/30 on hand-checked chapters;
  the cascade + ~10-20 hints per book is production-grade.

## Hint semantics (from compile.mjs — exact, not approximate)

- `match` is **startsWith** against the dialogue segment text (quote content,
  no quote chars). Mid-segment matches never fire.
- **Entity applies per-PARAGRAPH** (all dialogue segments in the paragraph);
  **emotion applies per-LINE** (only the matching segment).
- An unmatched hint is a silent no-op — safe to leave, useless to keep.
- The Studio's Script tab writes hints with `match` = the full line text
  (exact-match by construction); hand-written hints should use a prefix long
  enough to be unique in the book.
- `emotion: { fear: 0.7 }` makes the line a HERO line → routes to the paid
  engine in hybrid. **Hints are also the 11L budget dial** (see tts-casting).

## The LLM analyzer (ledgered, optional, never trusted blindly)

`node bin/dramatis.mjs analyze <manuscript.md> --book <id> --chapter N --llm
ollama|openrouter` — four schema-constrained purposes: entities → scenes →
sfx-cues → attribution (batched verify; overrides only at confidence ≥ 0.7,
below that → reviewQueue, never silently guessed).

- **Provider routing rule:** Ollama (local qwen3:14b, $0) when the GPU is idle;
  **OpenRouter (gemini-2.5-flash-lite, ~$0.003/ch) whenever a render is
  running** — Ollama starves under GPU contention.
- **Transport is node:http on purpose** — undici/fetch's 300 s headersTimeout
  killed long Ollama calls. Do not "modernize" it back to fetch.
- Every call is a JSONL row in `out/<book>/llm-ledger.jsonl` (provider, model,
  purpose, tokens, cost) with a content-addressed response cache. Reports:
  `node scripts/ledger-report.mjs [book]`; attribution agreement:
  `node scripts/compare-analysis.mjs <analysis.json> <production-script.json>`.
- Known analyzer behaviors: over-segments scenes, over-cues SFX (58 on one
  chapter — triage per sound-design), invents its own entity ids (map them),
  emotions come back null without few-shot examples, and it writes cues for
  spoken dialogue (the scaffold's vocal filter strips them — sound-design Law 1).

## Casting intelligence (src/casting.mjs) — determine, cast, verify

Each character gets a **casting sheet** (gender / age band / ethnicity-accent),
determined from explicit fields first, then keyword inference from the
description. `castingRecipe(char)` maps the sheet → a voice recipe:
- **Needs the character tier** (accent, OR child/teen/elderly) → **Gemini**,
  directed prompt stacking specifics (age in years, aging cues, accent as
  origin→"speaking English"); then clone into Qwen3 for free volume.
- **Generic adult** → free **Qwen3 design**.
Age bands: child(~8, high-pitch expected) / teen(~15) / young-adult / adult /
elderly (stacked-quaver cues — labels alone fail, per Qwen research).

**Verification is honest about what's measurable:**
- **gender** → pitch-gated (register gate, refuses wrong-gender before ship).
- **child/young** → gated (kids read clearly high; adult-low on a child role flags).
- **elderly age & ethnicity/accent** → NOT machine-measurable → directed prompt
  + **human ear** in the Studio. Never claim a computer verified "sounds 70" or
  "sounds Creole" — that's an audition approval. See tts-casting (register gate,
  character actors).

`createBook` (src/scaffold.mjs; Studio New Book; `dramatis scaffold` CLI):
normalizes quotes, ensures `##`, one scene per chapter anchored at paragraph 1
(ambience room-hum), house voice template, optional analyzer pass merged in
(vocal cues stripped, unknown ambience types sanitized to the known set).
Output is a DRAFT — the Cast screen and cue triage finish it.

## Debugging "wrong speaker at M:SS"

timing.json (line at that timestamp) → production-script.json (line id, entity,
text) → why: check cascade order above against the paragraph's narration →
fix at the right layer: said-verb (all books) > entity names (this book) >
hint (this line). Re-render re-synthesizes only reassigned lines (~seconds).
