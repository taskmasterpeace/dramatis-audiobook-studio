# DRAMATIS — Handoff (2026-07-18, late-night: STUDIO SHIPPED)

Read `README.md` + `docs/SPEC.html` first. This file is the live state.

## LATE-NIGHT SESSION: DRAMATIS Studio v1 BUILT AND VERIFIED

`node studio/server.mjs` → http://localhost:4600 (or Studio launch config in
`.claude/launch.json`). Zero dependencies. Spec: `docs/superpowers/specs/
2026-07-18-dramatis-studio-design.md`. Smoke: `node studio/smoke.mjs` (13/13).

**Verified live in the browser tonight (all through the UI, not just API):**
- Bookshelf with truthful staleness + warnings; Production board with stage
  chips, LUFS/flags, chapter players, pre-flight cost BEFORE render
- Render button → spawned produce → SSE console streaming real pipeline logs
- Cast screen: 4-engine voice DNA editing, per-role engine override (writes
  book.casting; hybrid router honors it), one-click AUDITIONS — verified
  kokoro (cache-hit instant), elevenlabs, qwen3 (75s cold / ~5s warm), and
  the NEW gemini engine (live via Replicate, 7s)
- Script screen: screenplay view, hint popover (verified write + revert),
  SFX cue pins → panel with current clip + CLAP library alternatives →
  Approve/Swap/Reject persisted to book.json and honored by the mixer
- New Book intake: pasted The Signal-Man (Dickens) → analyzer drafted 3
  entities/21 scenes/58 cues (trains, bells, rumble) → book.json scaffolded
  (src/scaffold.mjs; also `dramatis scaffold` CLI) → rendered via the UI
- NARRATOR MATRIX delivered to Robert: same line through kokoro/Battlerap
  Algorithm(11L)/gemini-Charon/qwen3 — his ear picks; Studio locks it
- Ambience is retrieval-first now (engines/ambience/retrieve.mjs): real CC0
  recordings, same source clip per type (consistent), procgen fallback,
  provenance in qa-report.beds[]
- SFX capabilities verified: gunshot 0.61, car-door 0.52, rain 0.61 in corpus
- Images/video: MANUAL ONLY (banner in UI; nothing auto-generates)
- Style bible recorded for monkeys-paw: live-action (period film still),
  anchor URL + phrase, auto_generate false

**New/changed since evening:** studio/ (server+app+smoke), src/scaffold.mjs,
engines/ambience/retrieve.mjs, engines/tts/gemini.mjs, hybrid per-role
routing, sfx approval honoring, mix beds report, said-verbs already in.
Known rough edges: analyzer still over-cues (58 on Signal-Man — approval
gate is the filter); qwen3 first-audition model load ~75s; screenshot tool
in the dev browser pane flaky (page itself fine).

## EVENING SESSION (Robert's directive: AUDIO ONLY — motion/visuals DEFERRED)

Goal was: prove the audio process on a couple of stories + report cost. DONE:

- **Three complete audiobooks now exist** (see `docs/COST-REPORT.md` for full numbers):
  - `out/liu-xiao/book-immersive.m4b` — 104.1 min, 8 ch (hybrid v1, from afternoon)
  - `out/monkeys-paw/book-immersive.m4b` — 24.7 min, 3 ch, **hybrid v2** (new tonight)
  - `out/open-window/ch-01/immersive.m4a` — 7.7 min, 1 ch, **hybrid v2** (new tonight)
- **Two NEW public-domain books built from raw manuscript in one evening**: Gutenberg
  fetch -> normalize (curly quotes -> straight; compiler only sees `"` quotes) ->
  book.json (cast/scenes/cues/hints) -> kokoro validation pass -> line-by-line
  attribution audit -> hybrid v2 render. Books at `books/monkeys-paw/`,
  `books/open-window/`; manuscripts at `samples/the-monkeys-paw.md`,
  `samples/the-open-window.md`.
- **Attribution engine improved**: 11 said-verbs added to SAID_VERBS in src/compile.mjs
  (inquired/demanded/began/exclaimed/bawled/remarked/screamed/faltered/announced/
  pursued/admitted) — fixed 9 real misattributions. Hint semantics documented by use:
  `match` is startsWith on the dialogue segment; entity applies per-paragraph,
  emotion per-line (src/compile.mjs:130,173).
- **Hero-line dial**: emotion hints in book.json are the ElevenLabs budget knob.
  Monkey's Paw: 27 hero lines = 534 chars ≈ $0.12. Open Window: 4 hero lines
  (Vera's long monologues) = 1,183 chars ≈ $0.26. Everything else local ($0).
- **Housekeeping**: stale 5.4 GB motion segment deleted (zombie ffmpeg from the
  crashed encode killed); `corpus/`, `.venv/`, `__pycache__/` gitignored (corpus is
  6.9 GB — NEVER commit it).
- Motion comic (P5) untouched per directive — its state is unchanged below.

## What this is
Local-first full-cast cinematic audiobook studio (Apache-2.0, clean-room vs. Castwright
which is FSL-licensed — NEVER open Castwright's source, spec from behavior only).
North star: "graphic audio" (full cast + ambience + SFX + score) now, motion comic
(audio + Directors Palette visuals -> MP4) next. Test book: Robert's story
`samples/liu-xiao-protector-of-china.md` (NOTE: final paragraph truncated by a paste
limit — ask Robert for the ending, marker is in the file).

## State: WORKING — five phases landed today

- **P0 DONE: full book rendered end-to-end.** `out/liu-xiao/book-immersive.m4b` +
  `book-clean.m4b` bound, 8/8 chapters, 104 min, 0 QA flags, -18 LUFS.
  Two old blockers (tremolo f=0.09, voice-cast miss) confirmed fixed. Third failure
  today was `spawn python ENOENT` — fixed permanently: engines resolve Python via
  `pythonExe()` in src/util.mjs (env DRAMATIS_PYTHON > repo .venv > PATH).
- **Runtime: uv-managed `.venv`** (Python 3.12.9, torch 2.13.0+cu126, RTX 4090 24GB).
  Setup: `uv venv --python 3.12 .venv` then
  `uv pip install --python .venv/Scripts/python.exe torch torchaudio --index-url https://download.pytorch.org/whl/cu126`
  + `kokoro-onnx soundfile onnxruntime qwen-tts qwen-asr librosa`.
  NEVER uv-install while a render's python is alive (Windows DLL locks corrupt the env
  — happened once, cost a reinstall). Models cache to user-level `D:\hf_cache`.
- **P1 DONE: qwen3 TTS engine** (engines/tts/qwen3.mjs + qwen3-batch.py, Apache-2.0).
  VoiceDesign persona -> frozen clone prompt (Base 1.7B) per character; clone path
  ACCEPTS per-line instruct (verified) so emotion flows. Voices map: book.json
  `voices.qwen3` with `design:` personas. Smoke test passed; full ch-1 render running.
- **P1 DONE: ElevenLabs -> eleven_v3** with audio tags from line.emotion
  (`[angry]` etc. prepended; stability snapped to 0/0.5/1 detents). Verified render.
- **Emotion in the IR**: compile emits `line.emotion` from book.json hints that carry
  an `emotion` payload (12 hints annotated in liu-xiao). Analyzer (P2) will emit
  emotions per line from prose; schema is the spec's `{ anger: 0.7, ... }`.
- **hybrid v2 (new default)**: narration->kokoro, dialogue->qwen3,
  emotion-carrying "hero" lines->elevenlabs. Cuts 11L spend to hero lines only.
- **P2 DONE: analyzer slot** (`dramatis analyze <manuscript.md> --book <id> --chapter N
  [--llm ollama|openrouter]`, src/analyze.mjs + src/llm.mjs). Ollama qwen3:14b local
  default (installed today, server at :11434), OpenRouter fallback
  (OPENROUTER_API_KEY in yourehired/.env). Four ledgered purposes:
  entities -> scenes -> sfx-cues -> attribution (LLM verifies draft attribution at
  confidence>=0.7 + assigns emotions; ambiguous -> reviewQueue). Per-call JSONL
  ledger at out/<book>/llm-ledger.jsonl (provider/model/purpose/tokens/cost,
  content-addressed response cache in out/cache/llm/). Report: `node
  scripts/ledger-report.mjs [book]`. LLM fetch rewritten over node:http (undici's
  300s headers timeout killed long Ollama calls under GPU contention).
  Verified ch-1 via OpenRouter: 91% attribution (10/11 vs hand-verified ref; the
  one miss is the genuinely ambiguous "Liu Xiao!" call), 7 entities, $0.003/chapter.
  Ollama works but is starved when the GPU is busy rendering — use OpenRouter then.
- **P3 DONE: SFX v1.** Corpus: FSD50K eval set (5,001 wavs, CC0-filtered to 2,399;
  note eval_audio.zip is multipart — we have part 1 only, more available).
  CLAP index (transformers ClapModel laion/clap-htsat-unfused) at corpus/fsd50k/index.
  Retrieval-first engine engines/sfx/retrieve.mjs: CLAP top-1 -> normalize; below
  threshold 0.25 -> procgen; unknown free-text spec + weak match -> skip + report.
  Verified ch-1: 6/6 cues retrieved (sim 0.41-0.66), placed at anchor-word onset
  +100ms by Qwen3-ForcedAligner (parser: result.items[].text/start_time), per-cue
  confidence 0.92-0.94 in qa-report.json. Mix at -18 LUFS, 0 flags.
- **P4 DONE: music stem.** engines/music/suno.mjs (muapi relay, MUAPI_API_KEY in
  aiobr/.env; LICENSE UNVERIFIED for commercial use — see SPEC §7). 5th stem in the
  mix at -20dB, ducked like ambience. book.json chapter `music:` cues
  (anchor/spec/dur/gain_db); ch-1 has a theme (verified in the mix). License
  recorded per cue in qa-report.

## Pipeline (current)
```
Ingest -> Compile (deterministic + hints) -> [Analyze (LLM, optional, ledgered)]
-> Cast (kokoro | qwen3 | elevenlabs v3 | hybrid) -> Render (cached)
-> Align (Qwen3-FA) -> Mix (5 stems: dialog/ambience/SFX/music, ducking, cue confidence)
-> Master (immersive+clean) -> Bind (chaptered M4B)
```

## Known issues / next improvements (in rough priority)
1. Full book not yet re-rendered with hybrid v2 (qwen3 dialogue). ~600 dialogue
   lines; validate ch-1/ch-2 by ear first, then decide.
2. ElevenLabs spend for P0 v2-model renders was duplicated by the v3 migration
   (model in cache key) — expected, one-time. Ch8 dialogue is v3; ch1-7 bound M4B
   has v2 dialogue + new v3 for re-synthesized lines.
3. Music licensing: muapi/Suno is a relay — resolve (11L Music / Stable Audio /
   ACE-Step local) before selling output.
4. Ambience beds still procgen; retrieval-first beds from the corpus are the next
   step (same CLAP index, longer clips).
5. GPU contention: qwen3 TTS + Ollama + CLAP + ForcedAligner can co-resident in 24GB
   but slow each other; a simple scheduler/queue would help.
6. Mix re-renders stems every run (~30s/chapter) — stems could be content-addressed.
7. MCP server (spec §12) not started. CLI + book.json is the only interface.
8. samples/ manuscript missing its final paragraph (truncation note at file end).

## P5 (next big thing): motion comic
Directors Palette (DP_API_KEY in aiobr/.env): character sheets from Production Script
entities, location refs from scene envs (Master Location Reference Sheet recipe),
scene-anchored panels, word timestamps from src/align.mjs for panel timing,
image->video (seedance/wan via DP). Output: chapter MP4. Not started.

## Context docs
- Spec artifact (source of truth): docs/SPEC.html (local copy; needs the §7 engine
  matrix refresh to match this file — DO IT when phases settle)
- Git log tells the build story; all work committed on master.
