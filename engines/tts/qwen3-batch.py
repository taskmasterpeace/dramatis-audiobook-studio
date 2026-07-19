# DRAMATIS Qwen3-TTS engine — batch renderer.
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

CLONE_INSTRUCT_OK = None  # probed once: does generate_voice_clone take instruct?

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
CORRECTIVE = {
    "female-range": " Speak as a woman, in a clearly female, higher-pitched natural voice.",
    "male-range": " Speak as a man, in a clearly male, lower-pitched natural voice.",
}


def load(model_id):
    print(f"[qwen3] loading {model_id}", flush=True)
    return Qwen3TTSModel.from_pretrained(model_id, device_map="cuda:0", dtype=torch.bfloat16)


def unload(model):
    del model
    torch.cuda.empty_cache()


def ref_path(cache_root, design, ref_text):
    h = hashlib.sha1(f"{design}|{ref_text}".encode()).hexdigest()[:24]
    d = pathlib.Path(cache_root) / "voices" / "qwen3"
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{h}.wav"


def pick_ref_text(texts):
    # a mid-length, representative line; deterministic for a fixed line set
    return min(texts, key=lambda t: abs(len(t) - 80))[:240]


def main(manifest_path):
    global CLONE_INSTRUCT_OK
    m = json.loads(pathlib.Path(manifest_path).read_text(encoding="utf-8"))
    cache_root = m["cacheRoot"]
    entities = m["entities"]
    by_entity = {}
    for ln in m["lines"]:
        by_entity.setdefault(ln["entity"], []).append(ln)

    design_ids = [e for e in by_entity if entities.get(e, {}).get("design")]
    custom_ids = [e for e in by_entity if entities.get(e, {}).get("speaker")]

    # phase 1: design reference clips (only for refs not already cached)
    refs = {}
    for e in design_ids:
        ent = entities[e]
        rt = pick_ref_text([ln["text"] for ln in by_entity[e]])
        rp = ref_path(cache_root, ent["design"], rt)
        refs[e] = (rp, rt)

    # a cached ref made before the gate existed may be poisoned — verify on load
    for e, (rp, rt) in refs.items():
        want = expected_register(entities[e]["design"])
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

    # phase 2: clone-render design entities (chunked: progress + partial results
    # survive a kill; a whole-entity batch is all-or-nothing)
    done = 0
    total = len(m["lines"])
    CHUNK = 8
    if design_ids:
        base = load(BASE)

        def clone(texts, langs, prompt, instructs):
            global CLONE_INSTRUCT_OK
            if CLONE_INSTRUCT_OK is not False:
                try:
                    out = base.generate_voice_clone(
                        text=texts, language=langs, voice_clone_prompt=prompt, instruct=instructs)
                    if CLONE_INSTRUCT_OK is None:
                        CLONE_INSTRUCT_OK = True
                        print("[qwen3] clone path accepts per-line instruct", flush=True)
                    return out
                except TypeError:
                    CLONE_INSTRUCT_OK = False
                    print("[qwen3] clone path ignores instruct; emotion via text cues only", flush=True)
            return base.generate_voice_clone(text=texts, language=langs, voice_clone_prompt=prompt)

        for e in design_ids:
            rp, rt = refs[e]
            design = entities[e]["design"]
            want = expected_register(design)
            prompt = base.create_voice_clone_prompt(ref_audio=str(rp), ref_text=rt)
            lines = [ln for ln in by_entity[e] if not pathlib.Path(ln["out"]).exists()]
            print(f"[qwen3] {e}: {len(lines)} lines to synth", flush=True)
            corrective = ""  # set if the first chunk drifts register
            for c0 in range(0, len(lines), CHUNK):
                chunk = lines[c0:c0 + CHUNK]
                texts = [ln["text"] for ln in chunk]
                langs = ["English"] * len(chunk)
                instructs = [(ln.get("instruct") or "") + corrective for ln in chunk]
                wavs, sr = clone(texts, langs, prompt, instructs)
                # GATE the first rendered line of each entity: this is where the
                # 2026-07-19 female->male clone drift slipped through unheard
                if c0 == 0 and want is not None:
                    got, hz = measure_register(wavs[0], sr)
                    if got is not None and got != want:
                        print(f"[qwen3] GATE: clone of {e} drifted to {got} ({hz:.0f}Hz), wanted {want} — re-cloning with corrective instruct", flush=True)
                        corrective = CORRECTIVE.get(want, "")
                        instructs = [(ln.get("instruct") or "") + corrective for ln in chunk]
                        wavs, sr = clone(texts, langs, prompt, instructs)
                        got, hz = measure_register(wavs[0], sr)
                        if got is not None and got != want:
                            unload(base)
                            raise RuntimeError(
                                f"clone of '{e}' failed the register gate after corrective retry "
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
