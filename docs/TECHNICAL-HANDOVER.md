# DRAMATIS — Technical Handover

**Date:** 2026-07-18 · **State:** five of six goal phases shipped and verified; motion-comic assembly is one encode away from done · **Repo:** `D:/git/dramatis` (master, Apache-2.0)

This document is the engineering handover: what exists, how it works, how to operate it, what to watch out for, and what's next. Read this before `README.md` (user-facing) and `docs/SPEC.html` (product source of truth). `HANDOFF.md` remains the terse live-state file.

---

## 1. What this is

DRAMATIS is a **local-first, full-cast cinematic audiobook studio**. Manuscript in → produced audiobook out: per-character voices, ambience beds, text-anchored sound effects, and a music underscore, mixed as five stems with sidechain ducking, exported as dual masters (Immersive + ACX-style Clean) and a chaptered M4B. A second track renders the same Production Script into a **motion comic** (Directors Palette art + word-timed panels → MP4).

Positioning: the differentiator against the closest competitor (Castwright, FSL-1.1 licensed) is the sound-design layer — every competitor stops at voices. **Clean-room rule (hard): never open Castwright's source code.** Public README/docs/wiki and observed behavior only. This is load-bearing for the Apache-2.0 license story.

Design principles that the code actually enforces:

1. **The Production Script is the truth** — a cited JSON IR between prose and audio; everything renders from it.
2. **Deterministic + content-addressed** — `hash(engine | voice | params | text)` keys every artifact (TTS lines, SFX, beds, music, LLM responses, alignments, panels). Same inputs → bit-identical output. Edit one line → re-synthesize one line.
3. **Dialog is sacred** — immersive layers are ducked against dialog by construction; a Clean master always exists.
4. **Permissive parts only** — bundled defaults are Apache-2.0/MIT/CC0; anything else (ElevenLabs, Suno relay, Stable Audio) is an optional, clearly-labeled plugin.
5. **Local-first, cloud-optional** — local defaults for every slot (Ollama, Qwen3-TTS, CLAP, ForcedAligner); APIs are opt-in accelerants, logged and priced.

---

## 2. Verified state (as of 2026-07-18 ~16:00 EDT)

| Proof | Evidence |
|---|---|
| Full book rendered end-to-end | `out/liu-xiao/book-report.json`: **8/8 chapters, 104.1 min, 0 QA flags**, -17.9..-18.5 LUFS. `book-immersive.m4b` (103 MB) + `book-clean.m4b` (75 MB), chapter markers. |
| qwen3 local voices chapter | `out/liu-xiao-qwen3/ch-01/`: 59 lines, **6 designed voices** (VoiceDesign→clone prompt), emotion instruct live, -18.4 LUFS, 14.3 min. |
| eleven_v3 audio tags | `out/cache/fc439322620db2ec0cf33e61.wav` — `[angry]`-tagged line rendered via `eleven_v3`. |
| Hybrid v2 routing chapter | `out/liu-xiao-qwen3/ch-02/`: 46 narration→Kokoro, 31 dialogue→Qwen3, 1 hero→ElevenLabs v3; 13.4 min, -18.1 LUFS. |
| Analyzer + ledger | `out/liu-xiao/analysis-chapter-one-….json` + `out/liu-xiao/llm-ledger.jsonl` — 4 purposes, per-call provider/model/tokens/cost; **91% attribution (10/11)** vs hand-verified reference; $0.003/chapter via OpenRouter; cache hits on repeat calls. |
| SFX v1 | ch-01 `qa-report.json`: 6/6 cues retrieved from CC0 corpus (CLAP sim 0.41–0.66), placed at **anchor-word onset +100 ms** by forced alignment, **confidence 0.92–0.94**. |
| Music stem | ch-01 `qa-report.json.music[]`: Suno track ducked in at -20 dB, license string recorded. |
| Motion art | `out/liu-xiao/motion/characters/` (11 character sheets), `out/liu-xiao/motion/ch-01/` (5 scene panels, reviewed visually). |
| Motion MP4 | **Pending one re-run** — see §5.9 and §9. |

Spend to date: ElevenLabs ≈ $3 of credits, OpenRouter < $0.01, Suno $0.09, DP ~220 pts of 942k. All under the $25 run cap and ledgered.

---

## 3. Repository layout

```
bin/dramatis.mjs            CLI: produce | analyze | motion
src/
  compile.mjs               manuscript -> Production Script (deterministic; also exports chapterParagraphs/listChapters)
  analyze.mjs               LLM analyzer: entities -> scenes -> sfx-cues -> attribution (+emotion, review queue)
  llm.mjs                   provider-agnostic LLM client (Ollama/OpenRouter), JSONL ledger, content-addressed cache, postJson
  align.mjs                 forced-alignment driver (per-line cache)
  mix.mjs                   5-stem mix: timing, cue placement + confidence, ducking, dual masters, qa-report
  motion.mjs                motion-comic: DP cast sheets + panels -> scene spans -> zoompan segments -> MP4
  util.mjs                  contentKey/cache helpers, ffmpeg/ffprobe/loudness, pythonExe()
engines/
  tts/kokoro.mjs + kokoro-batch.py     Kokoro-82M ONNX narration (CPU)
  tts/qwen3.mjs + qwen3-batch.py       Qwen3-TTS designed voices (GPU)
  tts/elevenlabs.mjs                   ElevenLabs eleven_v3 (audio tags)
  tts/hybrid.mjs                       v2 routing: narration->kokoro, dialogue->qwen3, hero(emotion)->elevenlabs
  tts/sapi.mjs + render-batch.ps1      Windows SAPI fallback (legacy)
  align/qwen3fa.py                     Qwen3-ForcedAligner-0.6B word onsets
  sfx/retrieve.mjs                     retrieval-first SFX resolver (CLAP -> procgen -> skip+report)
  sfx/clap-index.py                    builds embeddings.npy + manifest.json over the corpus (transformers ClapModel)
  sfx/clap-query.py                    batch text->clip queries
  sfx/procgen.mjs                      seeded ffmpeg recipes (fallback tier)
  ambience/procgen.mjs                 seeded ffmpeg beds (rain, crowd, city-night, lab-cold, battle, room-hum, roomtone-morning)
  music/suno.mjs                       muapi.ai Suno relay (instrumental underscore)
books/liu-xiao/book.json    cast/voices/scenes/cues/music/visuals/hints (the book's source of truth)
books/liu-xiao/qwen3.json   derived variant (id liu-xiao-qwen3) — REGENERATE after book.json edits
models/kokoro/              Kokoro ONNX weights (via scripts/setup-kokoro.ps1)
corpus/fsd50k/              FSD50K eval audio (5,001 wavs) + metadata + CLAP index (2,399 CC0 clips)
scripts/
  ledger-report.mjs         LLM spend report (provider x purpose)
  compare-analysis.mjs      analyzer output vs reference script (attribution agreement)
  setup-kokoro.ps1          Kokoro model fetch
docs/SPEC.html              product & engineering spec (source of truth)
docs/TECHNICAL-HANDOVER.md  this file
samples/                    test manuscripts
out/                        all artifacts + content-addressed cache (out/cache, out/cache/llm, out/voices/qwen3)
```

Python: uv-managed `.venv` (CPython 3.12.9, torch 2.13.0+cu126). All engine Python goes through `pythonExe()` (src/util.mjs): `DRAMATIS_PYTHON` env → `.venv/Scripts/python.exe` → PATH `python`.

---

## 4. The Production Script (IR)

Compiled per chapter to `out/<book>/ch-NN/production-script.json`:

```jsonc
{
  "book": "liu-xiao", "chapter": "Chapter One — …", "revision": 1,
  "entities": [{ "id": "liu", "kind": "character", "names": ["Liu", "Liu Xiao"], "visual": "…" }],
  "scenes": [{
    "id": "c1-parlor", "env": {...}, "ambience": { "type": "rain", "intensity": 0.35 },
    "lines": [{
      "id": "lin_0007", "para": 4, "kind": "dialogue", "entity": "liu",
      "text": "Finished. You carry your worry here…",
      "emotion": { "anger": 0.7 },          // optional; drives v3 tags + qwen3 instruct
      "cite": [11031, 11067]                // manuscript offsets — every line/scene/cue is cited
    }]
  }],
  "cues":  [{ "id": "c1-snap", "sfx": "tentacle-snap", "anchor": "A tentacle uncoiled…", "at_line": "lin_…", "offset": 1.2, "gain_db": -3 }],
  "music": [{ "id": "c1-theme", "spec": "somber cinematic underscore…", "at_line": "lin_…", "dur": 90, "gain_db": -6 }]
}
```

`book.json` (per book) supplies: `entities` (with `visual` descriptions for motion art), `protagonist`, `voices` per engine (`sapi | kokoro | qwen3 | elevenlabs | hybrid`), `hints` (entity overrides + optional `emotion` payloads), per-chapter `scenes` (text `anchor`s, `ambience`, `visual`, `characters`), `cues`, `music`. The `hybrid` voice map composes other maps via `"@kokoro"`-style references.

---

## 5. Pipeline, stage by stage

```
Ingest -> Compile -> [Analyze] -> Cast -> Render -> Align -> Mix (5 stems) -> Master -> Bind
                                                      \-> Motion (panels/spans/MP4)
```

### 5.1 Compile (src/compile.mjs, deterministic)

- Chapter isolation by `## ` heading; paragraphs keep manuscript offsets (cites). `listChapters()` skips front matter (H1 title) — front-matter-as-chapter-1 was an early analyzer bug.
- Segmentation: quotes `"…"` → dialogue; remainder → narration.
- Speaker attribution cascade (verified 11/11, 37/37, 30/30 on ch 1/4/6): **hint > said-tag > single-name-in-narration > paragraph-initial actor > two-name-other > A/B exchange alternation (scene-reset turn tracking) > action-beat > protagonist fallback.** Scene boundaries reset turn state.
- Emotion: a `hints[]` entry may carry `emotion: { anger: 0.7 }`; compile attaches it to the matching dialogue line.
- Cues + music resolve their text `anchor` to a concrete `at_line`.

### 5.2 Analyzer (src/analyze.mjs + src/llm.mjs)

`dramatis analyze <manuscript.md> --book <id> --chapter N --llm ollama|openrouter`

Four ledgered purposes per chapter, JSON-schema-constrained:

1. **entities** — cast discovery (id/kind/names/description). Prompt enforces shortest-name ids and no mentioned-only characters (fixed the `liu_xiao`-vs-`liu` aliasing miss).
2. **scenes** — contiguous segmentation with `start_para` + env + ambience type/intensity.
3. **sfx-cues** — every explicit sound event with paragraph index + exact `anchor_text` + gain.
4. **attribution** — the deterministic compiler first produces a draft script from the LLM cast/scenes; the LLM then verifies each dialogue line's speaker (batched 40/call) and may assign emotion. Overrides at confidence ≥ 0.7; below that → `reviewQueue` (never silently guessed).

The LLM client (`src/llm.mjs`):

- **Providers:** Ollama (`http://localhost:11434`, default model `qwen3:14b`, JSON-schema `format`) and OpenRouter (default `google/gemini-2.5-flash-lite`, `response_format: json_schema`, `usage.cost` read per response). Env knobs: `DRAMATIS_LLM`, `DRAMATIS_OLLAMA_MODEL`, `DRAMATIS_OPENROUTER_MODEL`, `OLLAMA_URL`, `OPENROUTER_API_KEY`.
- **Cache:** `hash(provider | model | purpose | schema | prompt)` → `out/cache/llm/<key>.json`. Cache hits are free and logged as `[cache hit]`.
- **Ledger:** one JSONL row per call in `out/<book>/llm-ledger.jsonl`: `{ts, provider, model, purpose, scope, cache_key, tokens_in, tokens_out, cost_usd, latency_ms, status}` — the "who did we call and for what" requirement. `scripts/ledger-report.mjs` aggregates.
- **Transport:** raw `node:http` POST with a 15-min socket timeout. Do NOT reintroduce `fetch` — undici's 300 s `headersTimeout` killed long Ollama calls under GPU contention.

Verified on ch-1: 91% attribution (the one miss, "Liu Xiao!", is genuinely ambiguous), 7 sensible entities, scenes over-segmented (11 vs 5 — harmless), 32 eager cues (confidence layer filters downstream).

### 5.3 TTS engines (engines/tts/)

All engines export `renderLines(lines, voices, cacheRoot) -> { lineId: wavPath }` and self-cache per line.

**kokoro** — Kokoro-82M ONNX, CPU, `kokoro-onnx` + `soundfile` in the venv. Narration workhorse.

**qwen3** (qwen3.mjs + qwen3-batch.py) — the local character-voice engine:
- Voice map entries: `{ design: "<persona>" }` (VoiceDesign) or `{ speaker: "Ryan" }` (CustomVoice preset).
- Flow: for each design entity, synthesize one reference clip with `Qwen3-TTS-12Hz-1.7B-VoiceDesign` from a mid-length line (closest to 80 chars, deterministic) → cache under `out/voices/qwen3/<hash>.wav` → `create_voice_clone_prompt()` on `…-1.7B-Base` → chunked `generate_voice_clone` (8 lines/chunk, writes per chunk — **resumable at line granularity**; the earlier whole-entity all-or-nothing batch was killed at 60 min and rewritten for exactly this reason).
- **Emotion:** `line.emotion` → dominant ≥ 0.4 → instruct `"Speak with a (very) <adj> tone."` The clone path **accepts per-line instruct** (verified by probe with TypeError fallback).
- Models (bf16, `device_map="cuda:0"`, SDPA — no flash-attn on Windows): ~5 GB resident each, co-resident fine on the 4090 (24 GB). HF cache: user-level `D:\hf_cache` (script's `HF_HOME` setdefault defers to it).
- `engines/tts/qwen3-batch.py` phases: VoiceDesign (only for uncached refs) → Base clone → CustomVoice (only if used).

**elevenlabs** — `eleven_v3` (migrated from multilingual_v2):
- `line.emotion` → dominant emotion → v3 audio tag (`[angry]`, `[sad]`, `[fearful]`, …) prepended to the verbatim text.
- Stability snapped to the v3 detents 0 / 0.5 / 1 (creative/natural/robust). Model is part of the cache key, so v2 and v3 renders coexist.
- Voices resolved by **name** against the account roster with per-entity fallback candidates (book.json) — portable across accounts.

**hybrid** (v2, production default): `narration → kokoro`, `dialogue → qwen3`, `dialogue with emotion → elevenlabs`. The spend rule: credits only on hero moments. (v1 — all dialogue to 11L — is superseded.)

### 5.4 Forced alignment (src/align.mjs + engines/align/qwen3fa.py)

- `Qwen3-ForcedAligner-0.6B` (Apache-2.0, auto-downloads 1.4 GB on first use), 80 ms grid.
- `align(audio=wavPath, text=lineText, language="English")` returns `[ForcedAlignResult]`; **the words live at `result.items[]` with `.text/.start_time/.end_time`** (getting this shape wrong produced empty alignments once — parser fixed and verified).
- Cached per line as `<contentkey>.align.json` beside renders. Reused by cue placement (S3) and panel timing (motion).

### 5.5 SFX (engines/sfx/)

**retrieve.mjs — retrieval-first:**
1. Batch all chapter cues into one `clap-query.py` call (transformers `ClapModel` `laion/clap-htsat-unfused` over `corpus/fsd50k/index`: 2,399 CC0 clips, `embeddings.npy` + `manifest.json`, built by `clap-index.py`).
2. Top-1 cosine ≥ **0.25** → ffmpeg-normalize (48 kHz mono, cap 15 s or `dur`) → cache (`sfx@2` key).
3. Below threshold → procedural recipe (`procgen.mjs`, seeded/deterministic).
4. Unknown free-text spec + weak match → **skip and report** (never play the wrong sound).
Observed sims: thunder 0.63, impact 0.66, helicopter 0.55, crowd 0.46 — headroom above threshold.

**Placement (src/mix.mjs `placeCue`):**
- Anchor word = first non-stopword (≥4 chars) of the cue's anchor phrase; prefix-match (first 5 chars) against the line's aligned words.
- Transient at **anchor onset + 100 ms** (film-sync convention); ≥ **500 ms** between one-shots (shift forward); clamp to line span; fallback `line.start + manual offset`.
- **Confidence** = 0.4·word-matched + 0.3·alignment-coverage + 0.3·source-quality (retrieval: min(1, sim/0.35); procgen: 0.5; cached: 0.8). Written per cue to `qa-report.json` with method/source/sim/caption. ch-1: all six cues 0.92–0.94.

### 5.6 Ambience (engines/ambience/procgen.mjs)

Seeded ffmpeg beds (rain, crowd, city-night, lab-cold, battle, room-hum, roomtone-morning), one per scene, offset with a 1.5 s lead, `AMB_GAIN_DB=-16`. Retrieval-first beds from the corpus are the next upgrade (same CLAP index, longer clips).

### 5.7 Music (engines/music/suno.mjs)

- muapi.ai Suno relay: POST `/api/v1/suno-create-music` (`x-api-key`), poll `/api/v1/predictions/{id}/result`, take variation A, normalize to 48 kHz WAV. Content-keyed.
- **License is recorded per cue and is UNVERIFIED for commercial use** (relay ToS gap). Before selling output, swap the slot: ElevenLabs Music (clean license), Stable Audio 2.5 (fal.ai), or local ACE-Step 1.5 (Apache-2.0).
- Mix: own stem at `MUS_GAIN_DB=-20`, ducked like ambience.

### 5.8 Mix & masters (src/mix.mjs)

- Dialog stem: lines concatenated with 0.45 s line gaps / 2.2 s scene gaps; timeline (id/start/dur) → `timing.json`.
- Immersive master: `[amb -16 dB][mus -20 dB] both sidechain-compressed against dialog (threshold 0.02, ratio 6, attack 180 ms, release 1100 ms), amix(normalize=0), loudnorm I=-18 TP=-2 LRA=11`, AAC 128k 44.1 kHz.
- Clean master: dialog only, loudnorm -19/-3, AAC 96k.
- QA: duration-vs-text heuristic flags (WARN), loudness measured on both masters, `qa-report.json` = `{lines, flaggedLines, cues[], music[], immersive, clean}`. (One known benign flag: very short lines like "Yes," rendered slowly.)
- Bind (bin/dramatis.mjs): per-chapter masters → ffmetadata chapter map → `book-immersive.m4b` / `book-clean.m4b` + `book-report.json`.

### 5.9 Motion (src/motion.mjs)

`dramatis motion <book.json> --chapter N`

1. **Cast sheets:** every entity with a `visual` field → DP `/characters/generate` (turnaround + expressions), cached in `out/<book>/motion/characters/cast.json`. (Seed note: Liu's entry was seeded manually to reuse an earlier generation.)
2. **Panels:** one per scene from `scene.visual` + env, lead character's sheet as `reference_image`, `nano-banana-2`, cached by prompt hash.
3. **Spans:** scene start = first line start (from `timing.json`); dur = next scene start − start.
4. **Assemble:** per-panel zoompan (Ken Burns, alternating push-in/pull-out) → xfade concat → mux `immersive.m4a` → `out/<book>/motion/ch-NN.mp4`.

**DP API notes:** base URL is `https://directors-palette-v2.vercel.app` (**not** directorspalette.com — that domain doesn't resolve here); `DP_API_KEY` bearer; job results at `data.result.url` (not `image_url`). Balance: ~942k pts.

**Two encode bugs, both fixed (re-run pending):**
- 8000 px zoompan was absurdly slow → 2560 px.
- **zoompan frame multiplication:** `-loop 1 -t dur -i panel` on the input side materializes `dur·fps` input frames and `d=frames` then multiplies them (quadratic → a 565 MB runaway segment). Correct idiom (tested): input `-loop 1` **without** input-side `-t`; output-side `-t dur` caps at the first input frame's `d` outputs. `src/motion.mjs` carries the corrected filter; the leftover segment file must be deleted (`taskkill //PID <ffmpeg> //F` if busy) and the command re-run (~10–15 min).

---

## 6. Runtime environment

- **Hardware:** RTX 4090 24 GB, Windows, Git Bash shell. Node 25.8, ffmpeg 8.1.2 on PATH.
- **Python:** `uv venv --python 3.12 .venv` →
  `uv pip install --python .venv/Scripts/python.exe torch torchaudio --index-url https://download.pytorch.org/whl/cu126` →
  `uv pip install … kokoro-onnx soundfile onnxruntime qwen-tts qwen-asr librosa`
- **Models:** Kokoro ONNX (`models/kokoro/`); Qwen3-TTS VoiceDesign/Base/CustomVoice 1.7B + Qwen3-ForcedAligner-0.6B (HF cache `D:\hf_cache`, ~14 GB); CLAP `laion/clap-htsat-unfused` (~2 GB, same cache); Ollama `qwen3:14b` (9.3 GB, server auto-starts).
- **CRITICAL OPS RULE:** never `uv pip install` into `.venv` while a render's Python is alive — Windows DLL locks corrupt the env (numpy lost its dist-info once; recovery: `rm -rf .venv/Lib/site-packages/numpy*` + reinstall).
- **GPU contention:** TTS (~8 GB) + Ollama (9.3 GB) + aligner/CLAP (~2 GB) co-resident, but LLM latency degrades badly while the GPU is rendering — use `--llm openrouter` during renders. A simple job scheduler is future work.

## 7. Caching & determinism (the resume story)

| Artifact | Key | Location |
|---|---|---|
| TTS line | `engine | voice params | emotion/instruct | text` | `out/cache/*.wav` (+`-48k.wav` normalized) |
| Voice design ref | `design | ref_text` | `out/voices/qwen3/*.wav` |
| SFX one-shot | `sfx@2 | spec | dur` | `out/cache/*.wav` |
| Ambience bed | recipe | seed = `hash(book+scene.id)` | `out/cache/*.wav` |
| Music track | `suno-muapi@1 | spec | dur` | `out/cache/*.wav` |
| LLM response | `llm@1 | provider | model | purpose | schema | prompt` | `out/cache/llm/*.json` |
| Alignment | `align@1 | text | wav` | `out/cache/*.align.json` |
| Panel | `panel@1 | prompt | style` | `out/<book>/motion/ch-NN/*.png` |
| Cast sheet | entity id | `out/<book>/motion/characters/` + `cast.json` |

Every phase is re-entrant: re-running after a kill only redoes missing keys. Stale-input pitfalls learned: (a) derived `books/liu-xiao/qwen3.json` must be regenerated after `book.json` edits; (b) changing an engine constant (e.g. TTS model id) must change the key inputs — it does by construction here.

## 8. APIs, keys, spend

| Service | Key location | Use | Notes |
|---|---|---|---|
| ElevenLabs | `D:/git/yourehired/.env` `ELEVENLABS_API_KEY` | v3 hero dialogue | name-resolved voices; `with-timestamps` unverified for v3 (we forced-align instead) |
| OpenRouter | `D:/git/yourehired/.env` `OPENROUTER_API_KEY` | analyzer fallback | `usage.cost` per response, ledgered |
| muapi (Suno) | `D:/git/aiobr/.env` `MUAPI_API_KEY` | music stem | $0.09/track; **license unverified** |
| Directors Palette | `D:/git/aiobr/.env` `DP_API_KEY` (+`DP_BASE_URL`) | cast sheets, panels, (later) image→video | base = `…vercel.app`; result field `data.result.url`; balance ~942k pts |

Keys are loaded into process env at run time (grep→cut→export), never printed, never committed. Spend is logged (LLM ledger; music/engine notes in qa-report).

## 9. Known issues / honest limitations

1. **Motion MP4 not yet regenerated** post-filter-fix (the only open item; see §5.9).
2. Qwen3-TTS full-book dialogue (~600 lines) not yet run — ch-1/ch-2 only. Chunked batch is resumable; expect ~1.5–2 h on the 4090.
3. Analyzer: emotions come back null with flash-lite (prompt needs examples); scene segmentation over-segments; cues are eager (confidence layer mitigates).
4. Music licensing unresolved for commercial distribution (see §5.7).
5. Corpus is FSD50K eval part 1 of 2 (multipart zip — 5,001 of ~10k files; 2,399 CC0 indexed). Dev set (~19 GB) + Sonniss GDC bundles are the expansion path.
6. Ambience beds still procedural; retrieval beds next.
7. Mix re-renders stems every run (~30 s/chapter) — stems aren't content-addressed yet.
8. No EPUB ingest (md/txt only), no MCP server (spec §12), no series memory (spec M2).
9. `samples/liu-xiao-protector-of-china.md` is missing its final paragraph (paste truncation — ask Robert).
10. QA gates are acoustic + loudness only; ASR transcript match and speaker-fingerprint gates (spec §11) are unimplemented.

## 10. Next steps (priority order)

1. Finish the ch-1 MP4 (delete stale `out/liu-xiao/motion/_seg*.mp4`, `taskkill` any ffmpeg holding them, re-run `dramatis motion … --chapter 1`; verify duration ≈ 14 min and frames).
2. Full-book hybrid v2 render (qwen3 dialogue); spot-check voices per character, then decide the production default.
3. Emotion pass in the analyzer (few-shot examples in the attribution prompt) so emotion flows without hand-authored hints.
4. Retrieval ambience beds; Stable Audio 3.0 Small-SFX generation fallback for retrieval misses.
5. Music engine swap for commercial-safe scoring (11L Music or ACE-Step local).
6. Full-book motion comic once 1–3 are stable; then MCP + series memory (spec M2).

## 11. Ops runbook (copy-paste)

```bash
# env (once)
export PATH="$HOME/.local/bin:$PATH"
uv venv --python 3.12 .venv
uv pip install --python .venv/Scripts/python.exe torch torchaudio --index-url https://download.pytorch.org/whl/cu126
uv pip install --python .venv/Scripts/python.exe kokoro-onnx soundfile onnxruntime qwen-tts qwen-asr librosa

# keys (per shell; values never printed)
export ELEVENLABS_API_KEY="$(grep -m1 '^ELEVENLABS_API_KEY=' /d/git/yourehired/.env | cut -d= -f2- | tr -d '\r')"
export OPENROUTER_API_KEY="$(grep -m1 '^OPENROUTER_API_KEY=' /d/git/yourehired/.env | cut -d= -f2- | tr -d '\r')"
export MUAPI_API_KEY="$(grep -m1 '^MUAPI_API_KEY=' /d/git/aiobr/.env | cut -d= -f2- | tr -d '\r')"
export DP_API_KEY="$(grep -m1 '^DP_API_KEY=' /d/git/aiobr/.env | cut -d= -f2- | tr -d '\r')"

# produce
node bin/dramatis.mjs produce books/liu-xiao/book.json                    # whole book, hybrid v2
node bin/dramatis.mjs produce books/liu-xiao/book.json --chapter 2 --tts qwen3
# analyze
node bin/dramatis.mjs analyze samples/liu-xiao-protector-of-china.md --chapter 1 --llm openrouter
node scripts/ledger-report.mjs liu-xiao
node scripts/compare-analysis.mjs out/liu-xiao/analysis-*.json out/liu-xiao/ch-01/production-script.json
# motion
node bin/dramatis.mjs motion books/liu-xiao/book.json --chapter 1

# regenerate the derived test book after editing book.json
node -e "const b=require('./books/liu-xiao/book.json'); b.id='liu-xiao-qwen3'; require('fs').writeFileSync('books/liu-xiao/qwen3.json', JSON.stringify(b,null,2))"
```

---

*Handover prepared from live verification of the repo state on 2026-07-18. Where a number appears above, it was measured; where a limitation appears, it was hit in practice.*
