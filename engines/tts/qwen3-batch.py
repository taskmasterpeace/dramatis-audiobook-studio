# Audio Movie Studio Qwen3-TTS engine — batch renderer.
# Manifest: {
#   "cacheRoot": "out",
#   "entities": { "<id>": { "design": "<persona>" } | { "speaker": "Ryan" } },
#   "lines": [ { "entity": "<id>", "text": "...", "instruct": "...", "out": "...wav" } ]
# }
# Design-mode entities: a reference clip is synthesized once with the
# VoiceDesign model (cached under cacheRoot/voices/qwen3/), frozen into a
# clone prompt, then every line renders through the Base model — a consistent,
# reusable character voice. Speaker-mode entities use a CustomVoice preset.
import hashlib
import json
import os
import pathlib
import sys

os.environ.setdefault("HF_HOME", str(pathlib.Path(__file__).resolve().parents[2] / "models" / "hf"))

import re

import soundfile as sf
import torch
from qwen_tts import Qwen3TTSModel

VD = "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign"
BASE = "Qwen/Qwen3-TTS-12Hz-1.7B-Base"
CUSTOM = "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice"

# (a CLONE_INSTRUCT_OK probe lived here; it could never fail, so it only ever
#  printed a false claim that clones accept instruct. See clone() below.)

# ── voice sanity gate ───────────────────────────────────────────────────────
# Incident 2026-07-19: an "elderly woman" design produced a FEMALE reference
# (294 Hz) but the clone step drifted to MALE (106 Hz) on a long passage, and
# the listener was the first to find out. Law: no designed voice ships unheard
# by a machine — both the design ref AND the clone output are pitch-gated.

FEMALE_RE = re.compile(r"\b(woman|female|girl|lady|grandmother|mother|aunt|she|her|actress|matriarch)\b", re.I)
MALE_RE = re.compile(r"\b(man|male|boy|guy|gentleman|grandfather|father|uncle|he|his|actor|patriarch)\b", re.I)


def expected_register(design):
    f, m_ = bool(FEMALE_RE.search(design)), bool(MALE_RE.search(design))
    if f and not m_:
        return "female-range"
    if m_ and not f:
        return "male-range"
    return None  # ungendered design -> no gate


def measure_register(wav, sr):
    import librosa
    import numpy as np
    y = np.asarray(wav, dtype="float32").flatten()[: sr * 12]
    if sr != 22050:
        y = librosa.resample(y, orig_sr=sr, target_sr=22050)
    f0, _, _ = librosa.pyin(y, fmin=60, fmax=420, sr=22050, frame_length=2048)
    voiced = f0[~np.isnan(f0)]
    if len(voiced) < 10:
        return None, 0.0
    med = float(np.median(voiced))
    reg = "male-range" if med < 150 else ("female-range" if med > 170 else "ambiguous")
    return reg, med


REINFORCE = {
    "female-range": "A clearly FEMALE voice — a woman speaking in her natural high register. ",
    "male-range": "A clearly MALE voice — a man speaking in his natural low register. ",
}
# CORRECTIVE used to be appended to a clone's instruct on a gate failure. It
# never reached the model — the clone path has no instruct — so it is gone
# rather than left around looking like a working safety mechanism.


def load(model_id):
    print(f"[qwen3] loading {model_id}", flush=True)
    return Qwen3TTSModel.from_pretrained(model_id, device_map="cuda:0", dtype=torch.bfloat16)


def unload(model):
    del model
    torch.cuda.empty_cache()


# The sentence a designed voice speaks in its reference clip. FIXED on purpose
# (see ref_path): phonetically varied, emotionally neutral, no proper nouns, and
# ~80 chars — the length that used to be selected for.
REF_TEXT = ("They told me the road would be clear by morning, "
            "but I have lived long enough to know better.")


def ref_path(cache_root, design):
    """One reference clip per DESIGN, for the life of the project.

    THE INCIDENT (measured 2026-07-27): this used to hash design|ref_text, and
    ref_text was picked from the lines in the current batch — which is only the
    CACHE MISSES, and the CLI renders chapter by chapter. So every chapter chose
    a different reference line, hashed to a different path, and generated a
    brand-new VoiceDesign clip. VoiceDesign is non-deterministic, so the same
    character came out as a genuinely different voice each chapter: the shipped
    liu-xiao book had EIGHT reference clips for `liu` across its 8 chapters. The
    register gate only checks gender, so male->male drift passed silently and
    the only way to catch it was to listen across a chapter boundary.

    Hashing the design alone makes a character's voice identity independent of
    render order, batching, and interruption — which is what "the persona is
    frozen per character" always claimed to mean.
    """
    h = hashlib.sha1(design.encode()).hexdigest()[:24]
    d = pathlib.Path(cache_root) / "voices" / "qwen3"
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{h}.wav"


def main(manifest_path):
    m = json.loads(pathlib.Path(manifest_path).read_text(encoding="utf-8"))
    cache_root = m["cacheRoot"]
    entities = m["entities"]
    by_entity = {}
    for ln in m["lines"]:
        by_entity.setdefault(ln["entity"], []).append(ln)

    design_ids = [e for e in by_entity if entities.get(e, {}).get("design")]
    custom_ids = [e for e in by_entity if entities.get(e, {}).get("speaker")]
    # seed entities: a company actor's own seed.wav is the clone reference —
    # no design step, no paid engine, the voice IS the file. This is what lets
    # the hub serve a minted character's lines for free.
    seed_ids = [e for e in by_entity
                if entities.get(e, {}).get("seed") and not entities.get(e, {}).get("design")]

    # phase 1: design reference clips (only for refs not already cached)
    refs = {}
    for e in design_ids:
        ent = entities[e]
        refs[e] = (ref_path(cache_root, ent["design"]), REF_TEXT)
    for e in seed_ids:
        ent = entities[e]
        sp = pathlib.Path(ent["seed"])
        if not sp.exists():
            raise RuntimeError(f"seed voice for '{e}' not found: {sp}")
        # transcript raises clone similarity ~0.75->0.89 (measured); empty is legal
        refs[e] = (sp, ent.get("transcript", ""))

    # a cached ref made before the gate existed may be poisoned — verify on load.
    # SEED entities are exempt on principle AND mechanics: their reference is a
    # company actor's immutable seed.wav — already auditioned by a human ear —
    # and the unlink below would DESTROY the actor. Never gate-delete a seed.
    for e, (rp, rt) in refs.items():
        if e in seed_ids:
            continue
        want = expected_register(entities[e].get("design") or "")
        if want is None or not rp.exists():
            continue
        y, sr0 = sf.read(str(rp), dtype="float32", always_2d=True)
        got, hz = measure_register(y.mean(axis=1), sr0)
        if got is not None and got != want:
            print(f"[qwen3] GATE: cached ref for {e} is {got} ({hz:.0f}Hz), wanted {want} — regenerating", flush=True)
            rp.unlink()

    need = {e: r for e, r in refs.items() if not r[0].exists()}
    if need:
        vd = load(VD)
        for e, (rp, rt) in need.items():
            design = entities[e]["design"]
            want = expected_register(design)
            wrote = False
            for attempt in range(3):
                instruct = design if attempt == 0 else REINFORCE.get(want, "") + design
                wavs, sr = vd.generate_voice_design(
                    text=rt, language="English", instruct=instruct)
                if want is None:
                    sf.write(str(rp), wavs[0], sr)
                    wrote = True
                    break
                got, hz = measure_register(wavs[0], sr)
                if got == want:
                    sf.write(str(rp), wavs[0], sr)
                    print(f"[qwen3] designed voice for {e} -> {rp.name} (gate: {got} {hz:.0f}Hz)", flush=True)
                    wrote = True
                    break
                print(f"[qwen3] GATE: design for {e} came back {got} ({hz:.0f}Hz), wanted {want} — retry {attempt + 1}", flush=True)
            if not wrote:
                unload(vd)
                raise RuntimeError(f"voice design for '{e}' failed the register gate 3x (wanted {want}) — refusing to ship")
            if want is None:
                print(f"[qwen3] designed voice for {e} -> {rp.name} (ungated: no gender in design)", flush=True)
        unload(vd)

    # phase 2: clone-render design + seed entities (chunked: progress + partial
    # results survive a kill; a whole-entity batch is all-or-nothing)
    done = 0
    total = len(m["lines"])
    CHUNK = 8
    clone_ids = design_ids + seed_ids
    if clone_ids:
        base = load(BASE)

        def clone(texts, langs, prompt):
            # NO instruct here, deliberately. generate_voice_clone() has no
            # instruct parameter — anything passed lands in **kwargs and is
            # read back off a dict via getattr(), i.e. silently dropped. It
            # never raises, so the TypeError probe that used to live here ALWAYS
            # took the success branch and logged "clone path accepts per-line
            # instruct" — a false claim about our own capability, printed on
            # every render. Upstream confirms it: the Base model has no
            # instruction control. Per-line emotion on a cloned voice must be
            # baked into the reference clip or routed to another engine.
            return base.generate_voice_clone(text=texts, language=langs, voice_clone_prompt=prompt)

        for e in clone_ids:
            rp, rt = refs[e]
            # seed entities have no design text -> want=None -> ungated here;
            # the actor was auditioned by ear when hired, which outranks pyin
            want = expected_register(entities[e].get("design") or "")
            prompt = base.create_voice_clone_prompt(ref_audio=str(rp), ref_text=rt)
            lines = [ln for ln in by_entity[e] if not pathlib.Path(ln["out"]).exists()]
            print(f"[qwen3] {e}: {len(lines)} lines to synth", flush=True)
            for c0 in range(0, len(lines), CHUNK):
                chunk = lines[c0:c0 + CHUNK]
                texts = [ln["text"] for ln in chunk]
                langs = ["English"] * len(chunk)
                wavs, sr = clone(texts, langs, prompt)
                # GATE the first rendered line of each entity: this is where the
                # 2026-07-19 female->male clone drift slipped through unheard
                if c0 == 0 and want is not None:
                    got, hz = measure_register(wavs[0], sr)
                    if got is not None and got != want:
                        # Honest about the mechanism: this is a RE-ROLL, not a
                        # correction. It used to claim it was "re-cloning with
                        # corrective instruct", but instruct is inert on this
                        # path (see clone() above), so the retry only ever
                        # differed by the sampler's dice. It is still worth
                        # doing — upstream measures clone gender drift at ~20%
                        # of requests, so a fresh roll usually lands right — but
                        # nobody should debug it looking for a corrective effect.
                        print(f"[qwen3] GATE: clone of {e} drifted to {got} ({hz:.0f}Hz), wanted {want} — re-rolling (instruct cannot steer a clone)", flush=True)
                        wavs, sr = clone(texts, langs, prompt)
                        got, hz = measure_register(wavs[0], sr)
                        if got is not None and got != want:
                            unload(base)
                            raise RuntimeError(
                                f"clone of '{e}' failed the register gate twice "
                                f"(got {got} {hz:.0f}Hz, wanted {want}) — refusing to ship")
                        print(f"[qwen3] gate passed after correction: {got} {hz:.0f}Hz", flush=True)
                    elif got is not None:
                        print(f"[qwen3] gate: {e} clone register OK ({got} {hz:.0f}Hz)", flush=True)
                for ln, w in zip(chunk, wavs):
                    sf.write(ln["out"], w, sr)
                    done += 1
                print(f"synth {done}/{total}", flush=True)
        unload(base)

    # phase 3: CustomVoice preset entities (chunked)
    if custom_ids:
        custom = load(CUSTOM)
        for e in custom_ids:
            lines = [ln for ln in by_entity[e] if not pathlib.Path(ln["out"]).exists()]
            for c0 in range(0, len(lines), CHUNK):
                chunk = lines[c0:c0 + CHUNK]
                wavs, sr = custom.generate_custom_voice(
                    text=[ln["text"] for ln in chunk],
                    language=["English"] * len(chunk),
                    speaker=[entities[e]["speaker"]] * len(chunk),
                    instruct=[ln.get("instruct") or "" for ln in chunk],
                )
                for ln, w in zip(chunk, wavs):
                    sf.write(ln["out"], w, sr)
                    done += 1
                print(f"synth {done}/{total}", flush=True)
        unload(custom)

    print(f"synth complete: {done} items", flush=True)


if __name__ == "__main__":
    main(sys.argv[1])
