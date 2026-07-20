# The Models — what DRAMATIS runs, why, and what else was considered

Every model in the pipeline, with its licence (code and weights verified
separately — they often differ), hardware footprint, measured behaviour, and the
alternatives we evaluated. Dates are when the claim was last verified against a
primary source. Hardware baseline for "fits locally": a single 24 GB NVIDIA GPU;
CPU-only machines run the narration path.

---

## Voices

### Kokoro-82M — narration (free, CPU)
- **What**: 82M-parameter TTS, ONNX runtime, no GPU needed. The tireless
  narrator lane.
- **Licence**: Apache-2.0 (model and weights). ⚠ The `kokoro-onnx` Python
  package pulls `phonemizer-fork` (GPL-3.0) and the espeak-ng chain — fine to
  USE, not fine to REDISTRIBUTE in a bundled binary; see NOTICE.
- **Footprint**: ~340 MB weights, CPU-only, faster than realtime on a laptop.
- **The fact that matters**: upstream publishes a QUALITY GRADE per voice and
  almost nothing else. 54 voices installed; the audiobook-grade shortlist is
  `af_heart` (A), `af_bella` (A-), `af_nicole` (B-), `bf_emma` (B-),
  `ff_siwis` (B-). `am_adam` is an F+ — never cast it. Full table:
  `src/voice-tables.mjs`.
- **Gotchas we hit**: 510-phoneme hard cap per call (we chunk at ~280 chars and
  concat with breath gaps); language must come from the voice-id prefix
  (`fr-fr` and `cmn` are the valid codes — bare `fr`/`zh` are rejected).
- **Design lever**: voice BLENDING — pass a weighted sum of style vectors
  instead of a preset id. Verified deterministic (self-blend is bit-exact), so
  blends cache correctly. There is no pitch control; the ONNX graph takes
  tokens/style/speed and nothing else.

### Qwen3-TTS-1.7B — character voices + cloning (free, GPU)
- **What**: Alibaba's TTS family (VoiceDesign / CustomVoice / Base checkpoints).
  Our free character lane and the clone target for the voice company.
- **Licence**: Apache-2.0, code and weights both — verified on HF; none of the
  Tongyi-Qianwen extra terms (2026-07-20).
- **Footprint**: ~5–8 GB VRAM. 24 kHz mono output.
- **Measured behaviour**: cloning beats designing for age/accent — a reference
  clip carries what adjectives don't. Ref sweet spot **8–15 s** (quality
  degrades past ~15 s, measured); providing the transcript raises speaker
  similarity ~0.75→0.89. `instruct` (per-line emotion) works on Design and
  CustomVoice, NOT on clones. VoiceDesign is weak on AGE — "elderly" came back
  young until we stacked physiology cues and specific years, and hero
  age/accent roles route to the paid tier instead (the routing law).
- **The register gate**: every designed voice is pitch-verified (librosa pyin;
  female >170 Hz, male <150 Hz) at design, on cache load, and on clone output,
  with corrective retry then hard refusal. Born from a real incident: an
  elderly-woman design shipped sounding unmistakably male. Standing battery:
  `node scripts/voice-regiment.mjs` (8/8 pass on install).

### ElevenLabs (API, paid) — hero lines, user's own roster
- **Licence/terms**: subscription; commercial use per plan. ⚠ Their policy
  forbids redistributing OUTPUT under terms more permissive than their own —
  which is why no ElevenLabs audio is tracked in this repo and the seed clips
  in `actors/` must never be ElevenLabs renders.
- **Caps** (verified live 2026-07-20): eleven_v3 ≈ 5k chars/request;
  multilingual_v2 10k; flash_v2_5 40k. Concurrency over-cap queues (~50 ms),
  it doesn't error. **Voice slots are the scarce resource** — the roster cap
  cannot be raised on the plan we tested; design previews cost no slot, saving
  a voice does. DRAMATIS therefore saves designed voices as LOCAL seed clips,
  never into the account.
- **Voice design API**: 3 previews per call, cost = 1 credit per character of
  preview text charged once. `eleven_ttv_v3` is the only model taking
  reference audio.

### Gemini 3.1 Flash TTS (API via Replicate, paid) — directed character voices
- **What**: 30 fixed voices + a free-text style prompt — the only engine that
  takes a director's note as a first-class input. Our #1 for characterful
  voices by ear.
- **Caps** (schema-verified): `text` ≤ 4,000 bytes, `prompt` ≤ 4,000 bytes,
  combined ≤ 8,000 bytes, output ≈ 655 s max per call. We chunk at 3,200 bytes
  and ffmpeg-concat.
- **Custom voices: impossible.** The voice field is a closed enum; cloning
  lives on a different, allow-listed Google product. A Gemini character IS
  `(voice, prompt, language_code)` — which is why seed-then-clone-into-Qwen3
  is the only way to make one permanent.
- **The two failure modes we measured**:
  1. *Vocalized tags* — adjective/adverb bracket tags get SPOKEN ALOUD
     (documented by Google, reproduced by us). Emotion rides in the prompt now;
     a test pins the allowlist.
  2. *Direction read aloud* — one prompt phrasing rendered 3.8× over length,
     reproducibly; the fix was the phrasing law ("This line is <adjective> —
     <delivery>") plus a duration gate that re-rolls and then refuses.
- Only 4 of the 30 voices carry any age/texture signal in Google's own words:
  Leda (Youthful), Gacrux (Mature), Algenib (Gravelly), Enceladus (Breathy).
  `language_code` (en-GB/en-IN/en-AU…) is free accent leverage.

### TTS alternatives considered (surveyed 2026-07-20)

The headline finding: **in 2026 the moat in open TTS is licensing, not quality.**
The top of the open-weight quality field — Fish S2 Pro (#1 on TTS-Arena-V2),
IndexTTS-2, Voxtral TTS, Higgs TTS 3 — is uniformly blocked for a commercial
product. Nothing free beats Kokoro for CPU narration (hexgrad has shipped no
English successor since Apr 2025), and Qwen3-TTS-1.7B is the largest open
checkpoint in its family; the Flash tier stays API-only.

| Model | Code | Weights | Commercial | VRAM | Clone | Verdict |
|---|---|---|---|---|---|---|
| **Chatterbox / Turbo** (Resemble) | MIT | **MIT** | ✅ clean | ~4 GB | 10 s zero-shot | **Top adopt-candidate** |
| **VoxCPM2 2B** (OpenBMB) | Apache-2.0 | Apache-2.0 | ✅ | ~8 GB | clone + design, 48 kHz | **Adopt-candidate — audition first** |
| Fun-CosyVoice3-0.5B | Apache-2.0 | Apache-2.0 | ✅ | ~4 GB | clone + **instruct-on-clone** | Narrow candidate |
| Maya1 3B | Apache-2.0 | Apache-2.0 | ✅ | 16 GB | design-only (age/accent!) | Watch — possible free seed-factory |
| Higgs Audio v2 | Apache-2.0 | Boson Community: 100k-AAU cap | ⚠ conditional | 8–24 GB | yes | Watch |
| NeuTTS Air | Apache-2.0 | Apache-2.0 | ✅ | CPU | 3 s **on CPU** | Watch — only CPU-cloning option |
| VibeVoice (MSFT) | MIT | research-only; **AI disclaimer baked into output** | ❌ | ~7 GB | conditioned | Skip for product |
| IndexTTS-2 | Apache-2.0 | needs bilibili written authorization | ❌ | ~12 GB | best-in-class | Skip — licence |
| Fish S2 Pro / OpenAudio S1 | Apache-2.0 | research NC / CC-BY-NC-SA | ❌ | 4–12 GB | yes | Skip — licence |
| F5-TTS | MIT | **CC-BY-NC** (NC survives finetuning) | ❌ | ~8 GB | yes | Skip — licence |
| Spark-TTS | Apache-2.0 | **CC-BY-NC-SA** | ❌ | ~4 GB | yes | Skip (secondary sources claiming Apache are wrong) |
| MegaTTS3 | Apache-2.0 | Apache but **encoder withheld** | cloning gated | ~6 GB | gated | Skip |
| Voxtral TTS 4B | — | CC-BY-NC (dataset-inherited) | ❌ | ~8 GB | 3 s | Skip — licence |
| Dia / Dia2 | Apache-2.0 | Apache-2.0 | ✅ | ~8–10 GB | audio-prompt | Skip for books — voice drifts run-to-run |
| Kitten 15M / Supertonic | Apache / MIT | Apache / OpenRAIL-M | ✅ | CPU | no | Skip — below Kokoro |

### Chatterbox — TESTED, not just recommended (battery run 2026-07-20)

The paper case was strong: MIT on code *and* weights (the only quality-tier
model with zero commercial strings), clones from ~10 s references, ~4 GB so it
runs beside Qwen3, and a **per-line emotion dial** on cloned voices — precisely
what Qwen3 clone mode cannot do (`instruct` is ignored on clones) and what
currently forces hero lines onto paid engines.

So we ran it: `scripts/candidate-tts-battery.py` clones our real company actors
and pitch-gates the output exactly like the Qwen3 register gate;
`scripts/candidate-tts-control.py` is the control arm on unambiguous voices.

| Reference | F0 in | ex 0.5 → | drift | ex 1.0 → | drift | Gate |
|---|---|---|---|---|---|---|
| Control female (Kokoro `af_heart`) | 202 Hz | 209 Hz | **+7** | 242 Hz | **+40** | PASS / PASS |
| Control male (Kokoro `am_onyx`) | 84 Hz | 88 Hz | **+3** | 118 Hz | **+34** | PASS / PASS |
| `nola-elder` (elderly woman) | 159 Hz | 155 Hz | −4 | 230 Hz | +71 | FAIL / PASS |
| `liu-xiao` (elderly man) | 136 Hz | 168 Hz | **+31** | 178 Hz | **+42** | **FAIL / FAIL** |

**What the numbers actually say:**
1. **Cloning fidelity at `exaggeration=0.5` is excellent** — +3 and +7 Hz on
   clear voices. That is a genuinely good cloner.
2. **The emotion dial is also a pitch dial.** `exaggeration=1.0` adds ~+34 to
   +42 Hz in *every single case*, controls included. The feature that justified
   adopting it costs you register control — so it must be used in small doses,
   under a gate, never opened up on a boundary voice.
3. **It fails on elderly/boundary voices**, which are our most valuable
   characters. A consistent upward drift pushes a 136 Hz male across the 150 Hz
   line into ambiguous/female range.

**EAR RULING (Robert, 2026-07-20) — and it corrects the machine.** On the
`liu-xiao` clone the gate called a register failure. His verdict: *"doesn't
sound elderly anymore, but it sounds like the same person for sure."*

That splits the finding in two, and only one half was what the gate claimed:
- **Speaker identity survives cloning.** Chatterbox is a faithful cloner; the
  machine never doubted that and the ear confirms it.
- **AGE does not survive.** The +31 Hz rise isn't the voice becoming a different
  person or a different gender — it is the voice becoming *younger*. Rising
  pitch reads as youth.

So the pitch gate is measuring something real and reporting it under the wrong
name. It is a **register-and-age** gate: on a designed voice, drift out of band
usually means the wrong gender; on a *cloned* voice, where identity is anchored
by the reference, the same drift means lost age. The failure message should say
so, because "register failure" sent us looking for the wrong defect.

On the emotion dial, the ruling went the other way: `nola-elder` at
exaggeration **1.0 was preferred over 0.5**, despite a +71 Hz rise. So the dial
is usable and worth having — the pitch cost is acceptable on a character whose
age isn't the point.

**Verdict: ADOPT, gated.** Not a drop-in — it needs the register-and-age gate.
Use it freely for character identity and emotion; **keep elderly characters on
the premium tier**, because age is precisely what it loses and elderly voices
are our most valuable roles.

**Three integration variables were tested before this verdict** (a wrong verdict
on a candidate is more expensive than no verdict): reference length (our 24–28 s
seeds badly hurt it — trimming to 10 s cut liu-xiao's drift from 64 Hz to 16 Hz),
reference *window* selection, and the exaggeration setting. **A finding for our
own pipeline fell out of it:** the first 10 s of a seed clip is often
unrepresentative — liu-xiao's opening reads 160 Hz against a 143 Hz clip median.
Pick the clone window whose median F0 is closest to the whole clip's, don't just
take the head.

Other caveats: English-only on Turbo; the ElevenLabs-beating numbers are
vendor-run; a PerTh watermark is on by default (removable under MIT — make that
a deliberate decision, not a drift). Install notes: needs `setuptools<81`
(the `perth` watermarker still imports the removed `pkg_resources`, and without
it Chatterbox fails at load with a bare `TypeError: 'NoneType' object is not
callable`), and its own venv — it pins torch 2.6.

---

## Word timing

### Qwen3-ForcedAligner-0.6B — word onsets (free, GPU or CPU)
- **What**: forced alignment of rendered speech to its text; gives the word
  timestamps that let sound effects land on the triggering word and that a
  future read-along/karaoke export would use.
- **Licence**: Apache-2.0.
- **Footprint**: ~1.5 GB VRAM on GPU; runs on CPU since 2026-07-20 (the
  hardcoded `cuda:0` was the single string that made the whole SFX layer
  GPU-only). float32 on CPU, bfloat16 on GPU.
- **Behaviour**: alignment is an ENHANCEMENT — a failure warns and degrades cue
  placement to line-start offsets instead of killing the render. Cached per
  line like everything else.

---

## Sound effects

### LAION-CLAP + FSD50K CC0 corpus — retrieval (free, local)
- **What**: text-to-audio similarity search. The cue "door slams" embeds as
  text; 2,409 corpus clips are pre-embedded; cosine similarity proposes, a
  human disposes (per-cue approve/swap/reject in the Studio).
- **Licence**: CLAP is Apache-2.0. The corpus is the CC0 subset of FSD50K
  (2,399 clips) + 10 house clips we generated. ⚠ FSD50K *as a dataset* is
  CC-BY — the citation lives in NOTICE regardless of per-clip CC0.
- **Measured quality reality**: retrieval works, RANKING decides everything.
  Real incidents: wild-recording footsteps that read as "barefoot on cement",
  a city-night bed that read as "a helicopter". Mitigations that are now law:
  a vocal-caption guard (the cast are the only voices in the mix), noun-overlap
  re-rank, a +0.08 bonus for curated house clips, and per-cue human approval.
- **Corpus is not in the repo** (~7 GB built locally; no fetch script yet — the
  top wanted contribution).

### SFX generation — the missing local lane (surveyed 2026-07-20)

Retrieval stays primary. Generation is for cues a 2,400-clip corpus can't serve
("sword unsheathed slowly", "body dragged across gravel"). The open field here
is overwhelmingly **non-commercial** — nearly every well-known text-to-SFX model
is CC-BY-NC and disqualified outright.

| Model | Code | Weights | Commercial | Size | Max dur | Text-only | Verdict |
|---|---|---|---|---|---|---|---|
| **Stable Audio 3 Small SFX** (May 2026) | `stable-audio-tools` MIT | Stability Community | ✅ under $1M revenue, attribution required, **you own outputs** | 0.6B | **120 s** | ✅ | **Local pick** |
| Stable Audio 3 Medium | same | same | ✅ same terms | 2B | ~380 s | ✅ | Long-bed sibling |
| Stable Audio Open 1.0 / Small | MIT | Stability Community | ✅ | 1.2B / 341M | 47 s / 11 s | ✅ | Superseded |
| TangoFlux | unverified | **"non-commercial research use only"** | ❌ | — | 30 s | ✅ | Disqualified |
| AudioLDM 2 | unverified | CC-BY-NC-SA | ❌ | 1.1–1.5B | ~10 s | ✅ | Disqualified + stale |
| Meta AudioGen | MIT | **CC-BY-NC** | ❌ | 1.5B | ~5 s | ✅ | Disqualified |
| MMAudio | MIT | **CC-BY-NC** | ❌ | 6 GB | 8 s | ✅ | Disqualified |
| HunyuanVideo-Foley | — | Tencent Community: **excludes EU/UK/KR**, MAU cap | ❌ | XL | — | ❌ needs video | Disqualified twice |
| ThinkSound | HF tag says Apache; **README says commercial NOT permitted** | contradictory | ❌ | — | — | video-first | Disqualified |
| AudioX | — | CC-BY-NC, watermarked | ❌ | — | — | ✅ | Disqualified |
| **ElevenLabs SFX v2 via fal** | n/a | service — you retain output rights | ✅ paid | n/a | 30 s + **native seamless `loop`** | ✅ | **API pick** |

**Local pick: `stable-audio-3-small-sfx`** — purpose-built for effects, trained
on a licensed corpus, and the only commercially-clean local model that reaches
bed length (120 s) in one shot. Conditions to honour: never bundle the weights
(the user accepts the HF gate), show the "Powered by Stability AI" attribution
when the lane is active, and document the $1M revenue threshold.
**API pick: ElevenLabs SFX v2 through fal** at $0.002/s — cheaper than any
ElevenLabs subscription tier, no separate account, and it's already our house
foley sound. `fal-ai/stable-audio-3/medium` covers long beds at ~$0.038/clip.

**Architecture decision — corpus-first, confirmed.** Generation should write
INTO the corpus (generate 3–5 seeds → audition by ear → CLAP-index the keeper →
retrieval serves it forever), not run per-render. That keeps renders
deterministic and auditable, makes the cost one-time, and matches how film and
game audio actually work: curated libraries at edit time. Generated clips must
carry their true licence tag (`stability-community-output`,
`elevenlabs-paid-output`) — they are owned outputs, **not** CC0, and must never
be mixed into the CC0 pool silently.

**Beds:** prompt them event-free ("steady, no distinct events, room tone") and
scatter corpus one-shots on top — bed plus spot-effects, which plays straight
into our retrieval strength. Generate-short + equal-power crossfade loop is
standard practice and inaudible on stochastic textures.

### Retrieval upgrades considered (surveyed 2026-07-20)

**Verdict after measuring: KEEP the incumbent. GLAP lost badly on our corpus.**

The paper tables argued for switching — GLAP (Xiaomi, Apache-2.0) publishes
AudioCaps T2A R@1 41.7 vs 34.2 for LAION's best, and FSD50K zero-shot 40.9 vs
21.5. On that basis this document previously recommended the upgrade. Then we
built the battery (`scripts/retrieval-bench.py`, scored against FSD50K's own
per-clip labels over our shipped 2,399-clip index, 60 classes with ≥3 positives):

| Model | R@1 | R@3 | R@10 | MRR |
|---|---|---|---|---|
| **`laion/clap-htsat-unfused`** (incumbent) | **73.3%** | **88.3%** | **96.7%** | **0.825** |
| `mispeech/GLAP`, 10 s padded windows | 21.7% | 43.3% | 58.3% | 0.361 |
| `mispeech/GLAP`, native-length audio | 28.3% | 45.0% | 70.0% | 0.418 |

Two integration variables were tested before drawing the conclusion (padding
cost GLAP ~7 points — FSD50K clips are often ~1 s, so a fixed 10 s window is
mostly silence) and the ordering never came close to reversing.

**Why the paper and our bench disagree, and why ours governs:** the published
"FSD50K zero-shot" number is multi-label *classification* — given a clip, assign
labels from 200 classes. Ours is *retrieval* — given a text cue, rank 2,399
clips. That second task is the one DRAMATIS actually performs. Random R@1 on our
setup is under 1%, so the incumbent's 73.3% is a genuinely strong result, not a
low bar.

**Also found: GLAP's text encoding is broken on GPU out of the box.**
`encode_text()` builds its token tensors with a hardcoded `device="cpu"` and
feeds them to a text encoder the caller has moved to CUDA, moving only the
*output* across — too late. Workaround if anyone revisits it: keep
`model.text_encoder` on CPU.

Standing battery: `python scripts/retrieval-bench.py clap|glap`, results to
`out/retrieval-bench-*.json`. Re-run it before adopting ANY retrieval model —
this is exactly the swap that would have shipped a silent regression.

Rejected on licence: WavCaps (academic-only), M2D-CLAP (custom NTT terms),
ImageBind (CC-BY-NC), MuQ-MuLan (CC-BY-NC). ONE-PEACE is Apache-2.0 and beats
GLAP on Clotho but is a 4B unmaintained custom stack. There is **no Microsoft
CLAP 2025** — that was a phantom.

**A real bug this survey found, now fixed:** the processor is configured
`truncation="rand_trunc"` with `max_length_s=10`, while we fed it 20 s clips —
so every clip over 10 s was embedded from a **random crop**. 1,469 of our 5,011
corpus clips are over 10 s, meaning ~30% of the index was nondeterministic, and
it is a plausible cause of the logged "city night bed retrieved as a helicopter"
incident. `clap-index.py` now cuts fixed 10 s windows and mean-pools them;
verified bit-identical across runs (max diff 0.0).

**Corpus sources, by whether we may actually ship them:**

| Source | Licence | In repo | In product | Long-form |
|---|---|---|---|---|
| FSD50K CC0 subset | CC0 per clip | ✅ | ✅ | ≤30 s — **19,873 CC0 clips exist; we index 2.4k** |
| FSD50K CC-BY subset | CC-BY per clip | ✅ + credits | ✅ + credits | +23,506 clips |
| **EigenScape** | **CC-BY 4.0** | ✅ | ✅ | **✅ 64 × 10-min scenes, 48 kHz** |
| NPS / US-gov nature libraries | public domain | ✅ | ✅ | ✅ |
| Freesound CC0 bulk | clips CC0; **API ToS restricts bulk harvest** | clips ✅, harvest grey | same | ✅ |
| Sonniss GDC bundles | royalty-free sync, **no redistribution, no AI training** | ❌ | use-only | ✅ |
| BBC Sound Effects | RemArc = non-commercial | ❌ | ❌ | ✅ (moot) |
| OpenSFX | CC-BY-SA 3.0 | ✅ | ⚠ share-alike viral | ❌ |
| ESC-50 / UrbanSound8K | CC-BY-NC | ❌ | ❌ | ❌ |

**Corpus expansion — done, 2,399 → 4,096 clips (+71%), zero download.**
`clap-index.py` now classifies licences explicitly and takes `INCLUDE_CC_BY=1`
to admit the CC-BY clips already sitting on disk unindexed, emitting a
`CREDITS.md` beside the index so the attribution obligation can never drift from
the corpus. CC-BY-NC and Sampling+ are refused by name — a non-commercial clip
in a corpus that scores a book someone might sell is a licence violation waiting
to happen, and "we only used it for retrieval" is not a defence. Measured on the
eval split: 2,399 CC0 + 1,697 CC-BY admitted, 1,828 refused, 4,307 listed in
metadata but not on disk. Reaching the full ~19,900 CC0 clips needs the FSD50K
dev split (~24 GB) — the next free win, and the reason a corpus fetch script is
the most useful contribution available.

**Ranking upgrades worth doing** (from DCASE 2024/2025 winning systems):
1. An offline enrichment pass — PANNs CNN14 (MIT) AudioSet tags per clip to make
   the vocal guard classifier-based and add negative guards (a `Helicopter`-tagged
   clip can never serve a "city night" cue), plus machine captions from
   Qwen2-Audio-7B (Apache-2.0, fits the card) replacing noisy FSD50K metadata.
   One cached pass over the corpus; it kills both logged incidents.
2. LLM query expansion — rewrite each cue into 2–3 "the sound of…" paraphrases
   and average the text embeddings. Pure prompt plumbing with an LLM already in
   the pipeline; it is the zero-shot form of the caption-augmentation trick every
   DCASE winner uses.

---

## Music

### ACE-Step 1.5 — underscore (free, local GPU)
- **What**: StepFun/ACE's open music foundation model; the free lane for score
  beds and stings. 10 s–600 s in a single generation, seconds-fast on a 24 GB
  card, local REST API (`uv run acestep-api`, :8001).
- **Licence**: **MIT, code AND weights** — both LICENSE files read 2026-07-20.
  The VAE is ACE-Step's own MIT-tagged Oobleck — checked separately, because
  inheriting a Stability-licensed VAE is exactly what disqualified DiffRhythm.
- **Instrumental law**: caption appends "instrumental only…" AND lyrics are
  pinned to `[Instrumental]` — sung words under narration break the
  cast-are-the-only-voices rule. CoT caption rewriting is off so the cached
  caption is the rendered caption; seeds derive from the content key so cues
  reproduce.
- **Tiers**: 2B turbo fits 4–8 GB; XL (4B) wants 12–24 GB. The server
  auto-picks per GPU. First launch downloads several GB of weights — the
  engine's deadlines account for it.
- **Quality consensus**: "between Suno 4.5 and 5", occasionally "samey" — which
  is close to a feature for low-key underscore that must sit beneath narration.
- **EAR RULING (Robert, 2026-07-20): "worth keeping."** The generated beds
  passed the ear, so ACE-Step is now the **default** music lane and ElevenLabs
  Music is opt-in (`DRAMATIS_MUSIC=elevenlabs`). Score no longer costs money by
  default — the same free-tier-first law the voice routing follows.
- **Measured here (RTX 4090, 2026-07-20)**, two 30 s beds through our own
  `renderTrack()`: first render **845 s** — almost entirely one-time model load
  into VRAM — second render **8.3 s**, cache re-hit **0 ms**. So steady state is
  roughly 8 s per 30 s bed, and a chapter's worth of cues costs seconds. Output
  is 48 kHz stereo, correct duration to the sample, healthy level
  (−17.5 and −20.7 dB mean). Machine gates passed; clips are in
  `out/eartest-music/` for the ear, which is the last check and never the first.
- **Ops note**: the first request after install can block for minutes while the
  server lazily downloads ~8.4 GB of weights. Keep the sidecar warm across a
  render — tearing it out of VRAM between cues makes every cue pay the load.

### ElevenLabs Music (API, paid) — premium underscore
- Commercial use from Starter+; audiobooks are not in the self-serve exclusion
  list (verified 2026-07-20). ~$0.15/min via API. Same instrumental prompting
  law as ACE-Step, for the same reason.

### Music alternatives considered (verified 2026-07-20)
| Model | Code | Weights | Commercial | Verdict |
|---|---|---|---|---|
| **ACE-Step 1.5** | MIT | MIT | ✅ | **Adopted — free lane** |
| ACE-Step v1 (3.5B) | Apache-2.0 | Apache-2.0 | ✅ | Superseded by 1.5 |
| Stable Audio Open 1.0/Small | Stability Community | same | ⚠ <$1M revenue + attribution | Pass for music (47 s cap; own card says better at SFX) |
| MusicGen / AudioCraft | MIT | **CC-BY-NC** | ❌ | Disqualified — non-commercial weights |
| YuE | Apache-2.0 | Apache-2.0 | ✅ | Pass — ~360 s per 30 s of audio on a 24 GB card |
| DiffRhythm | Apache-2.0 | **VAE inherits Stability licence** | ⚠ tainted | Pass — the VAE trap |
| InspireMusic | Apache-2.0 | no licence tag (unverified) | ? | Pass — slow, English-only |
| Suno (via relays) | n/a | n/a | **unverifiable** | Deleted from the codebase — the licence could not be verified |
| **Lyria 3 / Pro** (Google, via Replicate/fal) | n/a | preview terms carve Lyria out for commercial use; no indemnity; SynthID baked in | ⚠ likely, pass-through undocumented | **Rejected for underscore** (2026-07-20): blind ELO **#4 instrumental / #7 vocals** (behind Suno V5.5/V5 and Mureka V8 on both boards); user consensus = top fidelity, "corporate/soulless" composition; **no duration parameter, no seed** (Lyria 2 had both seed + negative_prompt — dropped); auto-adds vocals (breaks the cast-only law); $0.04/30 s. Possible hand-picked stinger source, never an automated lane |
| MiniMax Music 1.5/2.5 | n/a | **no affirmative commercial grant in MiniMax's own terms** + mandatory AI-labeling/watermark duties | ❌ unclear = no | Rejected — the Suno rule: unverifiable means no. (Its 2.5+/2.6 sit at #4–5 on the blind VOCAL board — capability isn't the problem, the paper trail is) |
| Mureka V8 | ? | **unexamined** | ? | **Next candidate if the music slot reopens**: #2 on the blind instrumental ELO board, above Lyria and Suno V5 — nobody here has read its licence yet, so it is exactly one licence-read away from a verdict |

---

## Scene analysis

### Local LLM via Ollama (default) / OpenRouter (fallback)
- The analyzer that proposes scenes, cues, emotions and casting-sheet fields.
  Everything it writes is a PROPOSAL — deterministic compilation happens
  without it, and every LLM call is cached and cost-ledgered
  (`out/<book>/llm-ledger.jsonl`).

---

## The standing laws that came out of all this
1. **Verify code and weights licences separately** — they differ (MusicGen: MIT
   code, non-commercial weights) and composite pipelines inherit their worst
   part (DiffRhythm's VAE).
2. **"Unverifiable" equals "no"** — the Suno relay died for it.
3. **Machine gates first, human ear last** — register gate, duration gate,
   validation before render; the ear is the final check, never the first.
4. **Nothing under narration may sing or speak except the cast** — instrumental
   laws on both music engines, vocal-caption guard on SFX retrieval.
5. **Premium seeds, local volume** — pay once for a great voice, clone it free;
   never park designed voices in a vendor account we don't control.
