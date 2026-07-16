# DRAMATIS (working title)

Local-first studio that turns a manuscript into a fully produced, full-cast
audiobook — voices, ambience, and sound effects rendered from a single
editable **Production Script**. Apache-2.0, clean-room, no cloud required.

Spec: [docs/SPEC.html](docs/SPEC.html) — the source of truth for architecture,
mix targets, QA gates, and milestones.

## Status: M0 walking skeleton

The whole pipeline runs end to end, thin:

```
Ingest -> Compile -> Cast -> Render (cached) -> Mix (4-stem, ducked) -> Master
```

```bash
node bin/dramatis.mjs produce books/liu-xiao/book.json
# -> out/liu-xiao-ch1/chapter-immersive.m4b  (dialog + ambience + SFX)
# -> out/liu-xiao-ch1/chapter-clean.m4b      (voice only, ACX-style targets)
# -> out/liu-xiao-ch1/production-script.json (the IR)
# -> out/liu-xiao-ch1/qa-report.json         (loudness measurements)
```

## Engine slots (all pluggable)

| Slot | M0 fallback (works today) | Target engine |
| --- | --- | --- |
| Narrator/character TTS | Windows SAPI (David/Zira, SSML prosody) | Kokoro-82M / Chatterbox |
| Ambience beds | ffmpeg procedural synthesis (seeded) | Stable Audio Open |
| SFX one-shots | ffmpeg procedural recipes | CLAP retrieval over CC0 corpus |
| Analyzer | book.json heuristics + hints | Local LLM (Ollama) / Claude |

Renders are content-addressed: `hash(engine|voice|params|text)`. Editing one
line re-synthesizes one line. Same inputs → bit-identical audio.

## Layout

- `bin/dramatis.mjs` — CLI
- `src/compile.mjs` — manuscript → Production Script (cited lines/scenes/cues)
- `src/mix.mjs` — stem assembly, sidechain ducking, dual masters, mix QA
- `engines/` — TTS / ambience / SFX plugins
- `books/<id>/book.json` — cast, voices, scene map, cue sheet
- `samples/` — test manuscripts
