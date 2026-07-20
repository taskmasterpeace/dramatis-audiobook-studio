# DRAMATIS

**Turn a manuscript into a full-cast, cinematic audiobook — on your own machine.**

Every character gets their own voice. Scenes get ambience, sound effects land on the
exact word that triggers them, and a score sits underneath, ducked so the dialogue
always wins. The output is a chaptered M4B you can put on a shelf.

Apache-2.0. Local-first — narration and character voices run on your own machine with
no API key and no network.

```
Ingest → Compile → [Analyze] → Cast → Render → Align → Mix → Master → Bind
```

---

## What actually works today

This is a working system, not a roadmap. Four sample books ship in the repo, produced
end to end. The pipeline has also taken a full 8-chapter novel through to a
102-minute chaptered M4B with zero QA flags — that manuscript is the author's own
unpublished work, so it isn't included here.

- **Every line is attributed to a speaker** by a deterministic cascade (said-tags,
  paragraph structure, A/B alternation, action beats), with golden-file tests so a
  heuristic tweak shows its blast radius in seconds instead of an audiobook listen.
- **Casting is computed, not typed.** Describe a character in plain English and
  DRAMATIS infers gender, age band and accent, then picks the best voice on *every*
  engine and lets you audition them side by side on the same line.
- **Voices you keep.** Approve an audition and it becomes a company member — a seed
  clip plus the recipe that made it, saved to `actors/`. Pay once for a great voice on
  a premium engine, clone it locally with Qwen3, and reuse it. Casting a saved actor
  into a new book is a manual step today, not an automatic one.
- **Sound effects are retrieved, not guessed** — CLAP similarity search over a local
  CC0 corpus of ~2,400 clips, re-ranked, then placed at word-onset by forced
  alignment. Every cue carries a confidence score and can be auditioned or swapped
  before it reaches a mix.
- **Two masters, always**: an immersive mix at −18 LUFS and a clean, dialogue-only
  master at −19 aimed at ACX's loudness targets. It hits the loudness numbers; it does
  not yet measure noise floor, so treat it as ACX-style rather than ACX-certified.

## Quickstart

**Windows — just install it:** grab `DRAMATIS-Setup.exe` from
[Releases](https://github.com/taskmasterpeace/dramatis-audiobook-studio/releases).
It installs per-user (no admin), then downloads everything it needs on first run —
portable Node and ffmpeg only if your machine lacks them, the Python voice stack, and
the Kokoro model (~700 MB total on a bare machine). The Start Menu shortcut opens the
Studio in your browser. The installer is unsigned for now, so SmartScreen will warn:
*More info → Run anyway*.

**Any platform — from source.** The free path: no keys, no network after setup, and
no GPU. DRAMATIS has zero runtime npm dependencies; you need Node 20+, `ffmpeg` and
`ffprobe` on your PATH, and a Python venv for the local voice models.

```bash
npm run setup                    # fetches the Kokoro model (~340 MB)

uv venv --python 3.12 .venv
# Windows:
uv pip install --python .venv/Scripts/python.exe kokoro-onnx soundfile onnxruntime
# macOS / Linux:
uv pip install --python .venv/bin/python kokoro-onnx soundfile onnxruntime

npm run doctor                   # tells you what's ready and what's missing
node bin/dramatis.mjs produce books/open-window/book.json --tts kokoro
```

Or open the Studio and work visually:

```bash
npm start                        # → http://localhost:4600
```

The Studio is the whole app: a bookshelf, a casting room with every hireable voice,
a voice designer, per-chapter render with a live console, and a listening room.
It is plain `node:http` and vanilla JavaScript — no build step, no framework, no
bundler.

**One gap to know about up front:** the sound-effects layer needs a CLAP corpus —
~7 GB of CC0 audio you assemble locally. It isn't in the repo and there's no
one-command fetch for it yet, so a fresh clone renders voices and ambience but not
retrieved effects. Everything else, including word-level alignment, now runs on CPU.
If that gap matters to you, a corpus fetcher is the single most useful contribution
available.

See **[docs/SYSTEM-REQUIREMENTS.md](docs/SYSTEM-REQUIREMENTS.md)** for the two honest
tiers (what runs on any laptop vs. what needs an NVIDIA GPU),
**[docs/HOW-DRAMATIS-WORKS.md](docs/HOW-DRAMATIS-WORKS.md)** for the pipeline in depth,
and **[docs/MODELS.md](docs/MODELS.md)** for every model we run — licences verified,
measured behaviour, and the alternatives we evaluated and why.

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
| Score | **ACE-Step 1.5** — MIT (code *and* weights), runs on your GPU | ElevenLabs Music |
| Scene analysis | local LLM via Ollama | OpenRouter |

The premium engines are for the handful of lines where a performance really matters.
The measured all-in cost of a finished hour with restrained use is under a dollar; the
full breakdown, including what happens if you route everything premium, is in
**[docs/COST-REPORT.md](docs/COST-REPORT.md)**.

## Why it's built this way

**Everything expensive is content-addressed** — not just speech, but LLM analysis,
forced alignment, and sound-effect retrieval, all on the same key scheme
(`hash(engine | voice | params | text)`). Edit one line and exactly one line
re-synthesizes; everything else is served from cache. That makes a render resumable
and cheap to iterate.

To be precise about what this does and doesn't guarantee: the *cache* is
deterministic — the same key always returns the same file. The neural engines
themselves are not. Ask Gemini for the same line twice and you get two different
takes. Caching is what makes a render reproducible, not the models.

**The machine checks its own work.** Bad audio is expensive to discover by ear, so
gates run first: designed voices are pitch-verified against the gender they were
written for and refuse to ship if they drift; Gemini renders are duration-gated, since
a style prompt that gets read aloud instead of performed produces audio that is
obviously too long; every book is validated for unmapped voices before a render starts.
The human ear is the last check, never the first.

**Nothing is cast by default.** Candidates are auditioned in isolation and a person
picks. The same discipline applies to sound effects — cues are approved, swapped or
rejected before they reach a mix.

## Prior art, and where DRAMATIS differs

DRAMATIS was inspired by **[Castwright](https://github.com/dudarenok-maker/Castwright)**,
which got to multi-voice audiobook generation first and is a genuinely good piece of
engineering — a local pipeline, a real analyzer, an Android companion app, and a
release cadence most solo projects never manage. If DRAMATIS doesn't fit you, look at
it. This repository is clean-room with respect to it: no code, no docs, no
configuration has been copied.

There are two honest differences.

**The licence.** Castwright ships under the Functional Source License
(`FSL-1.1-ALv2`). That is source-available, not OSI open source, and its maintainers
say so plainly themselves. You may read it, run it internally at a company, modify it,
fork it, and sell audiobooks you make with it — the licence binds the software, not
its output. What you may not do is offer it to others as a commercial product or
service that competes with it. Each release converts to Apache-2.0 on its own second
anniversary, rolling per release.

DRAMATIS is Apache-2.0 today, for everything, permanently. Build a competing product
on it if you want to. There is no delayed conversion, no competing-use clause, and no
future version where the terms tighten. If your business can't sit on a licence that
might matter in two years, that difference is the whole pitch.

**The soundstage.** Castwright produces voices — as of v1.13.0 (July 2026) it has no
sound-effects, ambience, or music layer, and none is on its roadmap. That is a
difference in scope, not a deficiency. DRAMATIS is built around the idea that a
full-cast audiobook is a *mix*: retrieved effects landed on the word that triggers
them, ambience beds per scene, a score ducked under dialogue, and separate stems so
any of it can be rebalanced.

Where they're ahead, they're ahead: Castwright imports EPUB, PDF, MOBI and more, where
DRAMATIS reads Markdown; it runs in five languages to our English; it exports to more
formats; and its cast memory across a series is automatic where ours is manual. Both
projects cache aggressively, both are local-first, both are multi-engine, and both
make the cloud opt-in — those aren't differentiators in either direction.

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
