# DRAMATIS — System Requirements

Two honest tiers: what it takes to RUN the app, and what it takes to run the
LOCAL AI engines. The cloud engines (ElevenLabs, Gemini) work from
any laptop — the GPU is only for the free local tier.

## Tier 1 — Minimum (app + Kokoro + all cloud engines)

| Component | Requirement |
|---|---|
| OS | Windows 10/11 (built & tested here); the code is plain Node/Python and should port |
| Node.js | ≥ 20 (developed on 25) |
| ffmpeg / ffprobe | on PATH (mixing, mastering, every audio conversion) |
| Python | 3.12 via `uv venv` (Kokoro needs only `kokoro-onnx soundfile`) |
| CPU / RAM | any modern 4-core, 8 GB RAM |
| GPU | **none** — Kokoro is ONNX on CPU; ElevenLabs/Gemini are APIs |
| Disk | ~1 GB app + models (Kokoro ~330 MB) + your `out/` renders |
| Network | only for the paid engines and corpus downloads |

What works at this tier: the whole Studio, full book production with Kokoro
narration + cloud character voices, Quick Narrate, mixing, mastering, M4B
binding. What doesn't: Qwen3 designed voices/cloning, CLAP retrieval, forced
alignment (SFX land at line start + offset instead of exact word onsets).

## Tier 2 — Full local stack (what this machine runs)

| Component | Requirement |
|---|---|
| GPU | NVIDIA, **8 GB VRAM minimum**, 12–24 GB comfortable (dev box: RTX 4090 24 GB) |
| CUDA | torch 2.13 + cu126 wheels (`uv pip install torch torchaudio --index-url .../cu126`) |
| Python deps | `kokoro-onnx soundfile onnxruntime qwen-tts qwen-asr librosa transformers` |
| Disk for models | ~16 GB HF cache (Qwen3-TTS ×3 checkpoints + ForcedAligner + CLAP) + 7 GB SFX corpus |
| RAM | 16 GB+ recommended (CLAP indexing peaks high) |

VRAM appetite per engine (co-resident is fine on 24 GB, slow on 8 GB):
Qwen3-TTS ~5–8 GB · CLAP ~2 GB · ForcedAligner ~1.5 GB · (optional local
Ollama analyzer 9 GB — route the analyzer to OpenRouter instead on small cards).

## Rules that keep it healthy

- **Never `uv pip install` while a render's Python is alive** (Windows DLL locks
  corrupt the venv — this has cost a full reinstall).
- One render at a time (the Studio enforces it — one GPU).
- Models auto-download on first use to `D:\hf_cache` / `models/` — first Qwen3
  run is slow (~14 GB pull), everything after is warm.

## Starting it

`start-studio.cmd` (double-click) or `node studio/server.mjs` → localhost:4600.
Keys are read from `.env` in the repo root (gitignored) or the known env files.
Verify an install with: `node studio/smoke.mjs` (13 checks) and
`node --test test/attribution.test.mjs` (10 tests).
