# Improvement Loop — progress report

**Read this top-down. Newest findings first. Safe to stop the loop at any time.**

- **Loop:** `/loop 20m` — cron job `30073754`, `*/20 * * * *`. Session-only, auto-expires in 7 days. Cancel with CronDelete + that ID.
- **Mandate:** run tests, research improvements from the results, report. **No code changes.** This file is the only thing being written.
- **Last updated:** iteration 1
- **HEAD:** `cf6b7d6` — working tree clean

---

## Status at a glance

| | |
|---|---|
| Test suite | **51 tests, 51 pass** (4 consecutive clean runs) |
| Suite runtime | ~20 s |
| Flake observed | **1 run in 6** — 11 failures, all cascading from one root cause (see F-1) |
| Studio smoke | 3 pre-existing failures, unchanged (need rendered media in `out/`) |
| Real render corpus | 10 cached line renders, 3.5 MB. **No full chapter render exists** |
| Blocking gap | Nothing has been heard. Every conclusion below is machine-measured only |

---

## Iteration 1

### What ran
- `npm test` × 6
- `node --test` on the two mix/loudness files in isolation
- Deliberate dirty-state reproduction attempt
- ffmpeg defect diagnostics across all 10 real renders

### Repo state discovery (read this first)

HEAD `cf6b7d6` — *"Absorb the parallel mix work, and gate every master it produces"* — merged the mixer work from this session with a **parallel instance's** `src/master.mjs` and `test/master-loudness.test.mjs`. The working tree is clean; everything landed. The suite grew 40 → 51 tests.

That parallel work reached the same conclusion independently: its test *"the gate actually bites: the OLD single-pass loudnorm chain fails it"* passes, confirming from a second direction that single-pass `loudnorm` was compressing every master.

---

## Ranked findings

### F-1 — One failed `before` hook cascades into 8 misleading failures · **highest value**

**Evidence.** One run in six produced 11 failures. The signature is unambiguous:

```
✖ D:\...\test\loudness-measurement.test.mjs (2.3274ms)   <- file-level hook failure
✖ a scene with no ambience gets no bed (0.163ms)          <- 0.163ms = no work done
✖ lines are levelled to a common target (0.1018ms)
✖ the retail master is MP3 and clears ACX (0.0954ms)
```

Sub-millisecond durations mean those assertions never ran real work — `result` was undefined because the `before` hook died, and every dependent test threw a `TypeError` that the runner reported as a *domain* failure.

**Why it matters more than the flake itself.** The suite reported *"a scene with no ambience gets no bed"* as broken. That is a false accusation against a correct feature. Under law 1, a gate that misnames what failed is worse than no gate — it sends the next person to the wrong file.

**Root cause.** That run coincided with 8 background research agents finishing. The `before` hook spawns 3 ffmpeg processes plus a full `mix()`; under CPU contention a spawn can fail. Confirmed *not* dirty-state: I planted debris in both fixed temp dirs and the tests still passed 9/9 — the `before` hooks clean up correctly.

**Proposed solutions**, cheapest first:
1. Set a module-level `setupError`; have each test assert it is null first, so a hook failure reports once, correctly, instead of 8 times wrongly.
2. Retry the ffmpeg fixture spawns once on failure — the repo already has this pattern in `gemini.mjs`'s gated render.
3. Switch the two fixed temp dirs (`ams-mix-test`, `ams-loudness-test`) to `mkdtempSync`. **Every other test file in the suite already does this** — these two are the only outliers. Not the proven cause, but it is a one-line consistency fix that removes a whole class of cross-run interference.

---

### F-2 — The internal-gap defect detector over-flags in its naive form

Ran the detector the QC research ranked as *"the single cheapest, most discriminative TTS defect detector"* against all 10 real renders:

```
file       dur     speech%  gaps  worst_gap   naive verdict
18d581d8   10.52s    80%      5    0.559s     STALL
200b3f57    1.81s   100%      0    0s         ok
5c6639c2    4.56s    54%      4    0.936s     STALL   <- genuinely defective
6d0286e3    1.83s   100%      0    0s         ok
84f272db   13.88s    76%      7    0.809s     STALL
a327acd3   11.96s    69%      8    0.748s     STALL
bd376986    9.40s    93%      2    0.387s     ok
bebf1279    1.86s   100%      0    0s         ok
c2703f46   10.40s    76%      5    0.939s     STALL
d53665a8    9.24s    92%      3    0.283s     ok
```

**A flat "internal gap > 0.5 s" threshold flags 5 of 10 — but most are legitimate.** A 0.56 s pause inside a 10.5 s multi-sentence line is a sentence boundary, not a stall. The pattern is plain: every short line is 100% speech and clean; every long line has gaps, because long lines contain sentence breaks.

**The real discriminator is gap length relative to what the line contains.** `5c6639c2` stands out for a reason the flat threshold misses — it is a *short* line (4.56 s) that is only 54% speech with a 0.94 s hole. The other flagged lines are long and 69–80% speech.

**Proposed solution.** Normalise before thresholding — the Production Script already carries the text, so expected sentence count is free:
- flag when `speech% < 60` **and** the line is short, or
- flag when `worst_gap > 0.5 s` **and** `gaps > expected_sentence_breaks + 1`

Shipping the flat threshold would put a warning on half of all normal narration — a gate everyone learns to ignore is a gate that is not there.

---

### F-3 — Nothing has been heard, and the suite cannot tell you that

All 51 tests pass against **synthetic tones**. `out/` contains no chapter render — no `.m4a`, no `.mp3`, no `qa-report.json`. Every claim about room tone, levelling, ducking and ACX compliance is verified by measurement on 1 kHz sine waves.

That is the correct order under law 1 (machine gates first, human ear last) — but the ear has not ruled, and the suite has no way to report that. It reports 51/51 green on a pipeline whose output nobody has listened to.

**Proposed solution.** A single reference render (one chapter, Kokoro, free) would convert every measured claim into a heard one and populate the 3 failing smoke checks at the same time. It is the highest-information next action available and it costs nothing but CPU.

---

### F-4 — Smoke test failures are real but permanently masked

`node studio/smoke.mjs`: 3 failures, unchanged across every run this session — *rollup has minutes + spend*, *chapter has media path*, *unexpected error → `Failed to parse URL from http://localhost:4699null`*.

All three trace to `out/` having no rendered media, so they have been "known-failing, ignore" for the whole session. That is how a real regression hides. The third one is not a data gap at all — `http://localhost:4699null` is a string-concatenation bug where an undefined value is being appended to a base URL.

**Proposed solution.** Separate "needs fixtures" from "broken" in the smoke runner so the count means something; the `4699null` case should be investigated on its own — it is not explained by missing media.

---

## Watch list (carried forward, unverified this iteration)

From the earlier full-application audit and research, still open and untested:

| Item | Where | Status |
|---|---|---|
| `hybrid.mjs:17` — emotion recasts the character mid-scene | `engines/tts/hybrid.mjs` | unfixed |
| `stripMd` destroys the author's italics before any engine sees them | `src/compile.mjs:11` | unfixed |
| Word onsets computed, used for cue placement, then discarded — `timing.json` is line-level | `src/align.mjs` | unfixed |
| Casting misfires ("Mrs. Coleman" → male; "black coat" → ethnicity inference) | `src/casting.mjs` | unfixed |
| Three older tests that pass while proving nothing | test suite | unfixed |

---

## Method notes

- No code was changed. This file is the only artifact written.
- Findings are ranked by *evidence strength × cost to act*, not by severity alone.
- Where a run disagreed with a previous run, I re-ran rather than reported the first result — F-1 exists because of that.
