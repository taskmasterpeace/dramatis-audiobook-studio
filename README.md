# DRAMATIS

**Turn a manuscript into a full-cast, cinematic audiobook — on your own machine.**

Every character gets their own voice. Scenes get ambience, sound effects land on the
exact word that triggers them, and a score sits underneath, ducked so the dialogue
always wins. The output is a chaptered M4B you can put on a shelf.

Apache-2.0. Local-first — the free path needs no API key and no network.

```
Ingest → Compile → [Analyze] → Cast → Render → Align → Mix → Master → Bind
```

---

## What actually works today

This is a working system, not a roadmap. Six books are in the repo, fifteen chapters
produced end to end, including a full 8-chapter novel rendered to a 104-minute M4B
with zero QA flags.

- **Every line is attributed to a speaker** by a deterministic cascade (said-tags,
  paragraph structure, A/B alternation, action beats), with golden-file tests so a
  heuristic tweak shows its blast radius in seconds instead of an audiobook listen.
- **Casting is computed, not typed.** Describe a character in plain English and
  DRAMATIS infers gender, age band and accent, then picks the best voice on *every*
  engine and lets you audition them side by side on the same line.
- **Voices you keep.** Approve an audition and it becomes a company member — a seed
  clip plus the recipe that made it. Pay once for a great voice on a premium engine,
  clone it locally, and re-hire that actor in any book for free, forever.
- **Sound effects are retrieved, not guessed** — CLAP similarity search over a local
  CC0 corpus, re-ranked, then placed at word-onset by forced alignment. Every cue
  carries a confidence score and can be auditioned or swapped before it reaches a mix.
- **Two masters, always**: an immersive mix at −18 LUFS and a clean, dialogue-only
  ACX-compliant master at −19.

## Quickstart

The free path — no keys, no GPU, no network after setup:

```bash
# no npm install — DRAMATIS has zero runtime dependencies. Node 20+, ffmpeg, and
# a Python venv for the local voice models is the whole story.
uv venv --python 3.12 .venv
uv pip install --python .venv/Scripts/python.exe kokoro-onnx soundfile onnxruntime

node bin/dramatis.mjs produce books/the-open-window/book.json --tts kokoro
```

Or open the Studio and work visually:

```bash
node studio/server.mjs           # → http://localhost:4600
```

The Studio is the whole app: a bookshelf, a casting room with every hireable voice,
a voice designer, per-chapter render with a live console, and a listening room.
It is plain `node:http` and vanilla JavaScript — no build step, no framework, no
bundler. `ffmpeg` and `ffprobe` must be on your PATH.

See **[docs/SYSTEM-REQUIREMENTS.md](docs/SYSTEM-REQUIREMENTS.md)** for the two honest
tiers (what runs on any laptop vs. what needs an NVIDIA GPU) and
**[docs/HOW-DRAMATIS-WORKS.md](docs/HOW-DRAMATIS-WORKS.md)** for the pipeline in depth.

## Engines — bring your own, or use none

Nothing here is locked to a vendor. Every slot is pluggable, and the defaults are free
and local.

| Slot | Free / local | Premium (optional, your key) |
| --- | --- | --- |
| Narration | **Kokoro-82M** — Apache-2.0, ONNX, CPU-only | ElevenLabs |
| Character voices | **Qwen3-TTS-1.7B** — Apache-2.0, voice design + cloning | **Gemini 3.1 Flash TTS**, ElevenLabs v3 |
| Word timing | **Qwen3-ForcedAligner-0.6B** — Apache-2.0 | — |
| Sound effects | **CLAP retrieval** over a CC0 corpus | — |
| Ambience | procedural beds + retrieval | — |
| Score | — | ElevenLabs Music |
| Scene analysis | local LLM via Ollama | OpenRouter |

The premium engines are for the handful of lines where a performance really matters.
The measured all-in cost of a finished hour with restrained use is under a dollar; the
full breakdown, including what happens if you route everything premium, is in
**[docs/COST-REPORT.md](docs/COST-REPORT.md)**.

## Why it's built this way

**Renders are content-addressed.** Every line is keyed on
`hash(engine | voice | params | text)`. Edit one line and exactly one line
re-synthesizes. The same inputs always produce the same audio, so a render is
resumable, diffable, and cheap to iterate. LLM calls are cached and ledgered the same
way.

**The machine checks its own work.** Bad audio is expensive to discover by ear, so
gates run first: designed voices are pitch-verified against the gender they were
written for and refuse to ship if they drift; Gemini renders are duration-gated, since
a style prompt that gets read aloud instead of performed produces audio that is
obviously too long; every book is validated for unmapped voices before a render starts.
The human ear is the last check, never the first.

**Nothing is cast by default.** Candidates are auditioned in isolation and a person
picks. The same discipline applies to sound effects — cues are approved, swapped or
rejected before they reach a mix.

## Layout

```
bin/dramatis.mjs      CLI — produce, analyze
src/compile.mjs       manuscript → Production Script (cited lines, scenes, cues)
src/casting.mjs       character description → voice recipe + what the gate must verify
src/voicedesign.mjs   description → an audition slate across every engine
src/mix.mjs           stem assembly, cue placement, ducking, dual masters, QA
src/align.mjs         forced alignment (word onsets), cached per line
engines/              TTS / SFX / ambience / music / align plugins
studio/               the local web Studio (zero dependencies)
books/<id>/book.json  cast, voices, scene map, cue sheet
samples/              public-domain manuscripts to try it on
```

Run the tests with `node --test`.

## Credits

DRAMATIS stands on other people's work:

- **[Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M)** (Apache-2.0) — narration.
- **[Qwen3-TTS](https://github.com/QwenLM)** and Qwen3-ForcedAligner (Apache-2.0,
  Alibaba) — local character voices, cloning, and word timing.
- **[FSD50K](https://zenodo.org/records/4060432)** — the sound-effect corpus, filtered
  to its CC0 subset. FSD50K is community audio from
  [Freesound](https://freesound.org); please honour the per-clip licences if you
  extend the corpus beyond CC0.
- **[LAION-CLAP](https://github.com/LAION-AI/CLAP)** — text-to-audio retrieval.

Sample manuscripts are public domain: *The Monkey's Paw* (W. W. Jacobs, 1902),
*The Open Window* (Saki, 1914), *The Signal-Man* (Charles Dickens, 1866).

## Voice cloning, responsibly

DRAMATIS can clone a voice from a short reference clip. It ships **no celebrity
voices and no recordings of real people** — the actors in `actors/` are model output,
seeded from a text description.

The tool cannot tell whose voice is in a reference clip, so that judgement is yours.
Clone voices you generated, or voices whose owner gave you explicit permission for
this use. Cloning a real person without consent may be illegal where you live —
Tennessee's ELVIS Act and a growing number of right-of-publicity laws cover
synthesized voice specifically, and some reach distribution of the audio, not just
its creation. If you clone a real person, record who consented and to what, and
honour it if they withdraw.

## Licence

Apache-2.0 — see [LICENSE](LICENSE). Commercial use, forks and derivative products are
all permitted, today and permanently. No delayed conversion, no field-of-use
restriction, no separate licence for competing with us.

The grant covers the **code**. Sample manuscripts and the generated voice clips carry
their own terms — see [NOTICE](NOTICE), which also holds the required attribution for
FSD50K and the model weights, and one packaging caveat: `kokoro-onnx` pulls in a
GPL-3.0 phonemizer, which matters if you ever redistribute DRAMATIS as a bundled
binary.
