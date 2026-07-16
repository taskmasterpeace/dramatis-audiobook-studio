# DRAMATIS — Handoff (2026-07-16)

Read `README.md` + `docs/SPEC.html` first. This file is the live state.

## What this is
Local-first full-cast cinematic audiobook studio (Apache-2.0, clean-room vs. Castwright
which is FSL-licensed — NEVER open Castwright's source, spec from behavior only).
Test book: Robert's story `samples/liu-xiao-protector-of-china.md` (NOTE: final
paragraph truncated by a paste limit — ask Robert for the ending, marker is in the file).

## State: WORKING
- Full pipeline: manuscript -> Production Script (cited IR) -> per-character TTS ->
  procedural ambience/SFX -> 4-stem ducked mix -> per-chapter m4a -> chaptered book M4B.
- `node bin/dramatis.mjs produce books/liu-xiao/book.json [--chapter N] [--tts kokoro|hybrid|elevenlabs|sapi]`
- Chapter One verified end-to-end on kokoro AND hybrid: 14 min, 0 QA flags, -18 LUFS.
  Outputs in `out/liu-xiao/ch-01/`, older SAPI M0 render in `out/liu-xiao-ch1/`.
- TTS engines: kokoro (default; ONNX model in models/, re-fetch via `scripts/setup-kokoro.ps1`),
  elevenlabs (key read from env ELEVENLABS_API_KEY — Robert keeps it in D:/git/yourehired/.env),
  hybrid (narration->kokoro, dialogue->elevenlabs — the production default Robert wants;
  he explicitly said NO Windows SAPI voices in real output),
  sapi (fallback only).
- Attribution engine (src/compile.mjs): hint > tag > single-name > paragraph-initial actor >
  two-name-other > exchange alternation (scene-reset turn tracking) > protagonist.
  Verified: ch1 11/11, ch4 37/37, ch6 30/30 dialogue lines correct.
- Content-addressed caching everywhere (out/cache) — re-runs only synth changed lines.

## IMMEDIATE NEXT STEP (was mid-flight when handed off)
The final full-book hybrid render. Last run died on an ElevenLabs voice-cast miss;
book.json was JUST fixed (dr_han->Alice, muyang->Archer, president fallback Eric) but
that fix is committed right before this handoff — nothing else pending. Run:

```powershell
cd D:\git\dramatis
$line = Select-String -Path D:\git\yourehired\.env -Pattern "^ELEVENLABS_API_KEY=" | Select-Object -First 1
$env:ELEVENLABS_API_KEY = ($line.Line -split '=',2)[1].Trim()
node bin/dramatis.mjs produce books/liu-xiao/book.json --tts hybrid
```
~10-15 min (ch1-5 narration cached; ch6-8 kokoro synth + ~150 dialogue lines to 11L,
roughly 10-15K chars of credit). Produces `out/liu-xiao/book-immersive.m4b` +
`book-clean.m4b` with chapter markers, `book-report.json` summary.
Then LISTEN to a chapter and sanity-check the ElevenLabs character voices.

## Known issues / next improvements (in rough priority)
1. Full book not yet rendered end-to-end (see above). Two earlier full runs died:
   tremolo f=0.09 bug (fixed) and the voice-cast miss (fixed).
2. ElevenLabs dialogue has flat prosody control — consider next-gen model (eleven_v3)
   with audio tags, or per-line emotion from the Production Script's emotion field
   (schema supports it; compile doesn't emit emotions yet).
3. Robert floated Qwen3-TTS ("Quinn") for actors as a local alternative — engine slot
   exists, not built.
4. Mix stage re-renders stems every run (~30s/chapter) — stems could be content-addressed too.
5. MCP server (spec §12) not started. CLI + book.json is the only interface.
6. Ambience is procedural ffmpeg noise-craft — fine for beds, but Stable Audio Open
   is the spec'd upgrade (engine slot ready in engines/ambience/).
7. samples/ manuscript missing its final paragraph (truncation note at file end).

## Context docs
- Spec artifact (source of truth): https://claude.ai/code/artifact/4c632b7b-1415-4a87-96b2-d355e73f26e8
- Memory: ~/.claude/projects/D--git/memory/project_dramatis_audiobook_studio.md
- Git log tells the build story; all work committed on master.
