# How DRAMATIS Works — plain English

DRAMATIS turns a written story into a full-cast cinematic audiobook: a narrator,
a different voice per character, sound effects, room ambience, and music —
mixed and mastered. This is the map: every model, what it's for, and how the
app uses it.

## The five departments (every sound belongs to one)

| Department | What it makes | Models we use | Cost |
|---|---|---|---|
| **VOICE** | narrator + every character | Kokoro (free), Qwen3 (free), ElevenLabs, Gemini | free → paid |
| **FOLEY** | sound effects (a door, a gunshot) | CLAP retrieval + our house library + ElevenLabs generate | free → cheap |
| **ATMOS** | the room/world under a scene | CLAP retrieval of real recordings + synth | free |
| **SCORE** | music underscore | ElevenLabs Music (clean license) | cheap |
| **SET-PIECE** | a whole dense moment in one shot | Seed Audio (on fal) | ~$0.19/min |

## The voice models — who we use for what

- **Kokoro** (local, free): the workhorse **narrator** and background cast.
  Preset voices, unlimited, instant. Not for accents or specific ages.
- **Qwen3** (local, free): **character voices you describe in words**, and — the
  big one — **cloning**. It can copy a premium voice and then speak unlimited
  lines for free.
- **Gemini** (paid, ~$0.001/line): **the director's-chair engine, our #1 for
  characters.** You write a director's note ("elderly, New Orleans accent,
  weathered") and it acts it. This is how we get accents and age right.
- **ElevenLabs** (paid, ~$0.22/1k chars): premium **hero moments** and real
  named voices from your roster (including real aged/ethnic voices). Also
  **generates sound effects** into our house library.
- **Seed Audio** (paid, one pass): a whole **trailer or action beat** — voice +
  effects + music baked together in a single generation. Can use OUR character
  voices as a reference.

## Character actors — the money-saver (proven tonight)

The trick that makes premium quality affordable:

1. **Seed** a character once on Gemini (paid, perfect — accent, age, feeling).
2. **Clone** that voice into Qwen3 (`clone-from-audio.py`) → now she speaks
   **unlimited lines for FREE** in the same voice.
3. **Reuse** her forever: any book, plus Seed Audio trailers (her voice as a
   reference). She's a saved company member in `actors/<name>/`.

So far the company: **nola-elder** (New Orleans grandmother) and **liu-xiao**
(elderly Mandarin-accented man). Each folder holds her seed clip + transcript +
the exact recipe, so any engine can re-hire her.

## How casting decides who to hire (gender / age / ethnicity)

When a book comes in, each character gets a **casting sheet** — gender, age band,
ethnicity/accent — determined two ways (`src/casting.mjs`):

1. **From the description** the analyzer wrote ("elderly Chinese man", "a little
   boy of eight", "young lady of fifteen").
2. That maps to a **voice recipe**: which engine, which voice, and a directed
   prompt that stacks the specifics (age in years, aging cues, accent as
   origin→target). A child → a young high voice; an elderly Southern woman →
   Gemini directed for New Orleans; a generic adult → free Qwen3.

**How we make sure it's right (honest about what's checkable):**
- **Gender** — machine-verified by pitch (the register gate: female >170 Hz,
  male <150 Hz). A voice that comes back the wrong gender is refused before you
  ever hear it.
- **Child/young** — machine-flagged: a kid should read clearly high-pitched; if
  a child role comes back adult-low, the gate flags it.
- **Age (elderly) & ethnicity/accent** — **not** measurable by a machine. These
  are delivered by the directed prompt and confirmed by **your ear** in the
  Studio. We don't pretend a computer can hear "sounds 70" or "sounds Creole" —
  that's a human approval, and every voice is auditioned before it ships.

## Cast management — two kinds of notes (deliberately separate)

- **Actor notes** live with the company (`actors/<name>/notes.md`) and **travel
  to every book that actor appears in** — craft knowledge like "rolls her R's if
  you over-direct the accent" or "keep reference clips under 15s". Edit them in
  Casting Room → The Company; they show read-only on any Cast card using that
  actor. This is the whole point of having a company: what you learn once
  applies forever.
- **Role notes** live in the book (`entity.notes`) and are direction for **this
  production only** — "she's grieving from Part III on, play her rawer." They
  never leak into another book.

## Safety nets (things that now refuse rather than fail silently)

- **Register gate** — a designed voice whose gender doesn't match its
  description is refused before you hear it.
- **Cast validation** — a character with no voice used to render silently in the
  narrator's voice; the render now stops and names the problem.
- **Scene coverage** — every compiled line must land in a scene; lines above the
  first anchor used to vanish and crash the mixer half an hour later.
- **Golden tests** (`node --test test/attribution.test.mjs`) — snapshots of
  who-says-what across all books, so a said-verb tweak shows its blast radius in
  seconds instead of an audiobook listen.

## How you actually use it

- **Studio** (`start-studio.cmd` → localhost:4600): paste a story → it drafts the
  cast, scenes, and sound cues → you tune voices (audition any of 139), approve
  or swap sounds, hit Render, listen. Nothing images/video generates on its own.
- **Free quick tool** (`node say.mjs "your text"`): drop text, get a free mp3,
  with a timer. No API, no cost.
- **The showcase** (`out/showcase/`): the best results, organized, with a README
  that says what each one proves.

## What's verified vs. what's next

Verified by ear tonight: Gemini characters, the clone economy, house Foley, real
ambience, Seed Audio set-pieces & trailers, three finished books. Next: produce
one flagship book with real character voices throughout, and teach the Studio to
suggest the casting recipe automatically (it's computed in `src/casting.mjs`;
the UI just needs to show it).
