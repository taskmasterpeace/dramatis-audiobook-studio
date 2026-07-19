# DRAMATIS Studio — Design Spec

**Date:** 2026-07-18 · **Status:** approved-pending-review · **Mockup:** `docs/mockups/studio-mockup.html` (artifact ddfb3822, cool-graphite theme)

## 1. Purpose

A local web cockpit for the DRAMATIS pipeline. One person (Robert) produces full-cast
cinematic audiobooks: sees status and what's left, enters new stories, casts voices and
faces by **auditioning tested candidates** (never locking in blind), approves sound
effects, watches renders live with cost shown before commit, and plays the results.

**The product principle (Robert's, verbatim intent):** *draft → preview in isolation →
approve or swap → then it's used.* Applied identically to voices, SFX, and character
sheets. Selection over lock-in.

## 2. Constraints

- **Not over-engineered, not a throwaway POC** (Robert's words). A keeper tool, lean.
- Zero new dependencies: `node:http` server + one vanilla HTML/JS/CSS app. No build
  step, no framework, no database — `books/` and `out/` on disk ARE the state.
- Localhost only (bind 127.0.0.1). No auth, no multi-user.
- Matches repo idiom (plain `.mjs` modules).

## 3. Architecture

```
studio/server.mjs      node:http server, ~6 route groups + SSE + static
studio/app/            index.html + app.js + studio.css (vanilla, no build)
src/scaffold.mjs       analysis JSON -> draft book.json (shared with CLI `dramatis scaffold`)
engines/tts/gemini.mjs Gemini 3.1 Flash TTS engine (5th engine; Replicate or Google AI)
```

Server reads filesystem truth per request (no cache layer). Mutations write `book.json`
atomically (temp file + rename, JSON-validated first). Renders spawn
`bin/dramatis.mjs produce` as a child process — **one at a time** (one GPU); a second
request gets 409 + "what's rendering". Logs stream to the UI over SSE by relaying the
pipeline's already-structured stdout lines (`[render:tts]`, `[mix]`, `[produce]`).

## 4. Screens (per the mockup)

### 4.1 Bookshelf
Card per book: title/author, engine badge, chapters-done meter, minutes, measured spend,
and a **LEFT** line (unrendered chapters, stale chapters, review-queue count, book-level
warnings like Liu Xiao's missing final paragraph). + New Book card.

### 4.2 Production board (per book)
Row per chapter: stage chips (Compiled/Rendered/Mixed/Mastered), minutes, LUFS, flags,
play button (streams the actual master with Range support). **Render panel** shows the
pre-flight cost estimate (lines per engine, hero chars → $) before the Render button;
below it the live console (SSE log + progress). Stale = `book.json` mtime >
`production-script.json` mtime.

### 4.3 Cast & Voices (per book)
Card per entity: aliases, **visual brief** (editable — feeds character sheets), voice
DNA per engine (Kokoro id+speed, Qwen3 persona sentence, ElevenLabs candidates+detents,
Gemini voice+style prompt), hero-line list with char counts and $.

**Auditioning (core feature):** per role, render N candidates (cross-engine) of 1–2
signature lines as isolated voice-only clips; play side by side; **Pick** writes the
choice to `book.json` and marks it locked. The narrator is presented as the first and
biggest casting decision. Audition clips are content-cached (repeat plays free; paid
engines show char/token cost before the button fires). Discipline per the
`tts-casting` skill: one variable at a time.

**Character sheets:** each card gets Generate sheet (Directors Palette, from the visual
brief) → thumbnail → Approve / Regenerate. Same preview-approve motion as voices.

### 4.4 Script (per chapter)
Screenplay view of the production script: scene heads (id + ambience + music), lines
with color-chipped speakers, emotion badges showing premium routing, **SFX pins on
their anchor words** (confidence + source shown). Click a line → popover: reassign
speaker / set emotion → saves a **hint** to `book.json` (never touches the manuscript),
marks chapter stale. Click an SFX pin → **hear that exact clip in isolation** →
Approve / Swap (next-best corpus match) / Reject (drop). Analyzer review-queue items
surface here first.

### 4.5 New Book
Paste title/author/manuscript (or file path) → saves `samples/<slug>.md` → optional
Analyze (~$0.01, ledgered) → review analyzer draft (cast, scenes, cues, review queue) →
Create writes `books/<slug>/book.json` from the draft + house voice template →
lands on Cast screen to tune. Step strip: Paste → Analyze → Review → Create.

## 5. Approval model (decided: optional polish)

- Auto-picks always allow one-click render — nothing blocks on unreviewed items.
- Anything explicitly **picked/approved is locked**: stored in `book.json` and never
  silently overridden by re-analysis or template changes.
- Storage: per-entity `voices.<engine>` + new per-entity `engine` override consumed by
  the hybrid router (engine-per-ROLE, e.g. narrator→elevenlabs "Battlerap Algorithm",
  liu→qwen3 Mandarin design, minor parts→kokoro); per-cue `approval` field on the cue
  (`"approved" | "rejected" | { "swap": "<corpus file>" }`) consumed by the SFX
  resolver; per-entity `sheet` status for character art.

## 6. Engines touched (pipeline work the Studio needs)

1. **`engines/tts/gemini.mjs`** — new engine slot. Voice map `{ voice, prompt }`;
   `line.emotion` → inline tags; 4k/8k byte limits enforced by chunking at line level
   (lines are naturally small); content-addressed cache like every other engine;
   measure real $/finished-minute on first render and record it in the `tts-casting`
   skill. Keys: `REPLICATE_API_TOKEN` or `GEMINI_API_KEY`.
2. **`engines/tts/hybrid.mjs`** — honor per-entity engine overrides before
   kind-based routing (small change).
3. **`engines/sfx/retrieve.mjs`** — honor per-cue `approval` (skip rejected, use
   swapped file, top-1 otherwise).
4. **`src/scaffold.mjs`** — analysis JSON → draft book.json (entities + scenes + cues +
   house voice template). Also exposed as `dramatis scaffold`.

## 7. API surface

```
GET  /api/books                    shelf rollup (status, spend, what's-left)
GET  /api/books/:id                book.json + per-chapter artifact status + pre-flight
                                   estimate (runs the pure compile stage in-process when
                                   no fresh production-script exists — deterministic, free)
PUT  /api/books/:id/entity/:eid    visual brief / voice DNA / engine override / lock
POST /api/books/:id/hints          add-or-replace hint (speaker/emotion)
POST /api/books/:id/cues/:cueId    approval: approved | rejected | swap
POST /api/books                    create from paste {title, author, text, analyze?}
POST /api/render                   {book, chapter?, tts} -> 202 | 409 if busy
GET  /api/render/stream            SSE: relayed pipeline log + stage events
POST /api/audition                 {book, entity, engine, voice?, lineId?} -> clip URL + cost
POST /api/sheet                    {book, entity} -> DP character sheet job -> thumbnail URL
GET  /media/*                      Range-capable audio/image from out/
```

## 8. Error handling

- Render child exits non-zero → job state `failed`, last 50 log lines shown red,
  Render button re-enabled. Server restart orphans the child → UI shows "render died
  with the server; re-run (cache makes it cheap)".
- `book.json` writes: validate JSON + schema-lite (required keys) before atomic rename;
  a failed write never half-corrupts state.
- Paid audition/render calls surface the engine's error verbatim (e.g. 11L voice not
  found lists the candidates tried).
- Busy GPU: 409 with the current job's book/chapter/elapsed.

## 9. Testing & verification

- `studio/smoke.mjs`: boots server on a test port, exercises every GET against the real
  repo, round-trips scaffold on a fixture manuscript, PUTs an entity edit to a temp
  book copy, asserts atomicity; exit 0/1.
- Manual: drive the real UI against the three real books (bookshelf truth, render a
  chapter, audition a voice, approve an SFX cue, paste-create a test book) before done.

## 10. Visual identity (decided tonight)

Cool carbon graphite ground (#0D1116 family), signal-cyan accent (#3EC5CF — mixing-desk
LED), bone text, semantic green/amber/red for states, per-character chip colors,
Courier for screenplay lines, VU-segment progress motif. **No purple, no warm-brown.**
Single-theme dark (a console has no light mode).

## 11. Build order

1. **P1 — See:** server + Bookshelf + Production board (status, players, render +
   SSE console, pre-flight cost). The tool is useful the day P1 lands.
2. **P2 — Cast:** Gemini engine + Cast screen + cross-engine audition matrix
   (narrator matrix first: bm_george vs "Battlerap Algorithm" vs Gemini
   Charon/Schedar/Algieba vs Qwen3 storyteller) + engine-per-role overrides.
3. **P3 — Direct:** Script screen + hint popover + SFX audition/approve/swap.
4. **P4 — Intake:** New Book flow + `src/scaffold.mjs` + `dramatis scaffold`.
5. **P5 — Faces:** character sheets via Directors Palette (generate/approve on Cast).

## 12. Non-goals (v1 build)

Manuscript editing, waveform editing, render queueing, auth/multi-user, MCP server
(separate spec §12 track), mobile layout, light theme. Video is design-in-scope
(§13) but build-later.

## 13. Image track — stills on a 15–20 s grid (video generation explicitly deferred)

Robert's direction (2026-07-18 late): **no video generation yet.** The visual tier is
an image every 15–20 seconds of audio — an illustrated slideshow locked to the
audiobook. Verified tonight: the grid derives from `timing.json`, snapping shot
boundaries to line starts and scene boundaries (never mid-word) — Monkey's Paw
Part III (8 min) → 22 shots, each carrying timecode, scene, cast present, and the
manuscript text it must depict.

**Models (verified live on DP, 2026-07-18):** `nano-banana-2-lite` (5 pts, ~6 s,
14 reference images) and `gpt-image-2` (2 pts, ~25 s) — a full chapter ≈ 110 pts,
a book ≈ 300–500 pts. `nano-banana-2` (10 pts) reserved for hero frames.

**Style is a mandatory, user-chosen decision — never a silent default.** (Lesson:
the first motion panels shipped "illustration" style with no one choosing it.) Each
book carries a **style bible**: a named style phrase + an **approved anchor image**,
picked by auditioning the same test frame in 3–5 candidate styles (the standard
preview-approve motion).

**The anchor formula (measured 2026-07-18, two-scene consistency test):** every shot
passes BOTH the anchor (`reference_image` + `reference_category: "styles"`) AND the
restated style phrase in the prompt — the anchor alone is not enough. Test result:
two different scenes against the ink-wash anchor came out mutually consistent (same
paper, same linework — a real series look) but drifted from monochrome into tinted
watercolor. Countermeasures: restate the phrase's hard constraints in every prompt
("stark monochrome ink, no color"), tune `reference_strength`, and re-anchor on the
first APPROVED production frame. DP also supports `style_reference` on character-sheet
generation (sheets are made inside the book's look) and `reference_tag` to register
the anchor as e.g. `@paw-style`; style LoRAs on flux-2-klein-9b are the heavy-duty
fallback for a locked series look.

**Prompt grammar (Robert's fix, measured 1/4 → 4/4 scene accuracy):** never deliver
style as a detached block (`<scene>. STYLE: <phrase>.` let the style clause replace
the scene on 3 of 4 frames — the engraving invented a jungle temple). Weave it into
one sentence: `<full scene description>, painted/drawn/shot/engraved in the style of
<style phrase>`. Re-run with identical model/seed conditions produced the correct
scene in all four styles. This grammar is the shot-builder's law.

**Reference-image discipline (per shot, not per book):** references are selected
shot-by-shot — the style anchor image travels with every shot, but a character sheet
is attached **only when that character is in frame** (attaching unused refs degrades
output; models latch onto them). Empty/establishing shots carry the style anchor
alone. DP `@character_name` prompt tags bind each attached sheet to its name in the
scene text. The model accepts 14 references — budget: 1 style anchor + up to N
cast-in-frame sheets. The shot grid already tracks cast-in-frame per window, so this
is mechanical.

**Studio surface (phase P6 — Storyboard screen):** the shot grid as cards: timecode,
basis text, generated frame → approve / regenerate / re-prompt; chapter assembly =
stills on the audio timeline (the existing Ken Burns assembler in `src/motion.mjs`,
already written, fixed filter pending re-run). Per-shot and per-chapter pts cost
shown before generation.

**Paste-time implication:** the analyzer gains a fifth ledgered purpose,
`visual-beats` — drafting the shot grid's content descriptions at intake so a pasted
manuscript arrives storyboard-ready. Schema addition only; no build until P6.

**SFX depth (folded from tonight's finding):** retrieval is verified but the corpus
(2,399 CC0 clips) is thin — a "door slam" query top-matched a towel thump at 0.67.
Roadmap: full FSD50K dev set + Sonniss GDC packs; a text-to-SFX generation fallback
(Stable Audio Open / 11L SFX) between "weak retrieval" and "procgen"; and the per-cue
approve/swap gate (§4.4) as the human floor under all of it.
