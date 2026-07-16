# DRAMATIS (working title)

Local-first studio that turns a manuscript into a fully produced, full-cast
audiobook — voices, ambience, and sound effects rendered from a single
editable **Production Script**. Apache-2.0, clean-room, no cloud required.

Spec: [docs/SPEC.html](docs/SPEC.html) — the source of truth for architecture,
mix targets, QA gates, and milestones.

## Status: M0+ — full books, neural voices

The whole pipeline runs end to end, per chapter, then binds a chaptered M4B:

```
Ingest -> Compile -> Cast -> Render (cached) -> Mix (4-stem, ducked) -> Master -> Bind
```

```bash
# one-time: fetch the Kokoro model (~340 MB, Apache-2.0)
powershell scripts/setup-kokoro.ps1

node bin/dramatis.mjs produce books/liu-xiao/book.json --tts kokoro
# -> out/liu-xiao/book-immersive.m4b   (whole book, chapter markers, 4-stem mix)
# -> out/liu-xiao/book-clean.m4b       (voice only, ACX-style targets)
# -> out/liu-xiao/ch-NN/               (per chapter: masters, IR, timing.json, qa-report.json)
# options: --chapter N (single chapter) · --tts sapi (zero-install fallback)
```

## Engine slots (all pluggable)

| Slot | Engines today | Next |
| --- | --- | --- |
| Narrator/character TTS | **Kokoro-82M** (Apache-2.0, ONNX, 11-voice cast) · SAPI fallback | Chatterbox (cloning + emotion) |
| Ambience beds | ffmpeg procedural (seeded: rain, crowd, city-night, lab-cold, battle, room-hum) | Stable Audio Open |
| SFX one-shots | ffmpeg procedural recipes (thunder, boom, riser, sphere-hum, keening, helicopter, radio, snap) | CLAP retrieval over CC0 corpus |
| Analyzer | book.json heuristics + hints (cited spans) | Local LLM (Ollama) / Claude |

Renders are content-addressed: `hash(engine|voice|params|text)`. Editing one
line re-synthesizes one line. Same inputs → bit-identical audio.

## Layout

- `bin/dramatis.mjs` — CLI
- `src/compile.mjs` — manuscript → Production Script (cited lines/scenes/cues)
- `src/mix.mjs` — stem assembly, sidechain ducking, dual masters, mix QA
- `engines/` — TTS / ambience / SFX plugins
- `books/<id>/book.json` — cast, voices, scene map, cue sheet
- `samples/` — test manuscripts
