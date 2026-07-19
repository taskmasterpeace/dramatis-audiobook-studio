# DRAMATIS (working title)

Local-first studio that turns a manuscript into a fully produced, full-cast
audiobook — voices, ambience, sound effects, and score rendered from a single
editable **Production Script**. Apache-2.0, clean-room, no cloud required.

Spec: [docs/SPEC.html](docs/SPEC.html) — the source of truth for architecture,
mix targets, QA gates, and milestones.

## Status: graphic audio — full book shipped, five stems live

The whole pipeline runs end to end, per chapter, then binds a chaptered M4B:

```
Ingest -> Compile -> [Analyze] -> Cast -> Render (cached) -> Align -> Mix (5 stems) -> Master -> Bind
```

- Full novel rendered: `out/liu-xiao/book-immersive.m4b` + `book-clean.m4b`,
  8 chapters, 104 min, 0 QA flags.
- Dialogue in per-character **designed local voices** with per-line emotion;
  narration in tireless Kokoro; hero lines on ElevenLabs v3 audio tags.
- SFX retrieved from a local CC0 corpus by CLAP similarity and placed at
  word-onset by forced alignment — every cue carries a confidence score.
- Music underscore on its own stem, ducked against dialog.

```bash
# one-time: Python sidecar env (Kokoro model ships via scripts/setup-kokoro.ps1)
uv venv --python 3.12 .venv
uv pip install --python .venv/Scripts/python.exe torch torchaudio --index-url https://download.pytorch.org/whl/cu126
uv pip install --python .venv/Scripts/python.exe kokoro-onnx soundfile onnxruntime qwen-tts qwen-asr librosa

node bin/dramatis.mjs produce books/liu-xiao/book.json            # hybrid default
node bin/dramatis.mjs produce books/liu-xiao/book.json --chapter 2 --tts qwen3
node bin/dramatis.mjs analyze samples/liu-xiao-protector-of-china.md --chapter 1   # LLM analyzer
node scripts/ledger-report.mjs                                     # LLM usage/cost
# options: --chapter N · --tts kokoro|qwen3|elevenlabs|hybrid|sapi · --llm ollama|openrouter
```

## Engine slots (all pluggable)

| Slot | Engines today | Next |
| --- | --- | --- |
| Narrator TTS | **Kokoro-82M** (Apache-2.0, ONNX) | — |
| Character TTS | **Qwen3-TTS-1.7B** (Apache-2.0, VoiceDesign → frozen clone prompt, emotion instruct) · **ElevenLabs eleven_v3** (audio tags, hero lines) | Chatterbox (cloning alt) |
| Analyzer | **Ollama qwen3:14b** (local default) · **OpenRouter** (fallback) | per-book calibration |
| SFX one-shots | **CLAP retrieval over FSD50K CC0** (2.4k clips) · ffmpeg procedural fallback | Stable Audio 3.0 generation, bigger corpus |
| Ambience beds | ffmpeg procedural (seeded) | CLAP retrieval from long-form ambiences |
| Score | **muapi/Suno** (preview; license unverified) | ElevenLabs Music / ACE-Step (local, Apache-2.0) |
| Word timing | **Qwen3-ForcedAligner-0.6B** (Apache-2.0, 80 ms) | — |

Renders are content-addressed: `hash(engine|voice|params|text)`. Editing one
line re-synthesizes one line. Same inputs → bit-identical audio. LLM calls are
cached and ledgered the same way (`out/<book>/llm-ledger.jsonl`).

## Layout

- `bin/dramatis.mjs` — CLI (`produce`, `analyze`)
- `src/compile.mjs` — manuscript → Production Script (cited lines/scenes/cues/emotions)
- `src/analyze.mjs` + `src/llm.mjs` — LLM analyzer + provider client + usage ledger
- `src/mix.mjs` — stem assembly, word-aligned cue placement, sidechain ducking, dual masters, mix QA
- `src/align.mjs` — forced alignment (word onsets), cached per line
- `engines/` — TTS / ambience / SFX / music / align plugins
- `books/<id>/book.json` — cast, voices, scene map, cue sheet, music cues
- `corpus/` — CC0 SFX library + CLAP index
- `samples/` — test manuscripts
