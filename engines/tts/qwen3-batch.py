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

import soundfile as sf
import torch
from qwen_tts import Qwen3TTSModel

VD = "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign"
BASE = "Qwen/Qwen3-TTS-12Hz-1.7B-Base"
CUSTOM = "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice"

CLONE_INSTRUCT_OK = None  # probed once: does generate_voice_clone take instruct?


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

    need = {e: r for e, r in refs.items() if not r[0].exists()}
    if need:
        vd = load(VD)
        for e, (rp, rt) in need.items():
            wavs, sr = vd.generate_voice_design(
                text=rt, language="English", instruct=entities[e]["design"])
            sf.write(str(rp), wavs[0], sr)
            print(f"[qwen3] designed voice for {e} -> {rp.name}", flush=True)
        unload(vd)

    # phase 2: clone-render design entities (chunked: progress + partial results
    # survive a kill; a whole-entity batch is all-or-nothing)
    done = 0
    total = len(m["lines"])
    CHUNK = 8
    if design_ids:
        base = load(BASE)
        for e in design_ids:
            rp, rt = refs[e]
            prompt = base.create_voice_clone_prompt(ref_audio=str(rp), ref_text=rt)
            lines = [ln for ln in by_entity[e] if not pathlib.Path(ln["out"]).exists()]
            print(f"[qwen3] {e}: {len(lines)} lines to synth", flush=True)
            for c0 in range(0, len(lines), CHUNK):
                chunk = lines[c0:c0 + CHUNK]
                texts = [ln["text"] for ln in chunk]
                instructs = [ln.get("instruct") or "" for ln in chunk]
                langs = ["English"] * len(chunk)
                if CLONE_INSTRUCT_OK is not False:
                    try:
                        wavs, sr = base.generate_voice_clone(
                            text=texts, language=langs, voice_clone_prompt=prompt, instruct=instructs)
                        if CLONE_INSTRUCT_OK is None:
                            CLONE_INSTRUCT_OK = True
                            print("[qwen3] clone path accepts per-line instruct", flush=True)
                    except TypeError:
                        CLONE_INSTRUCT_OK = False
                        print("[qwen3] clone path ignores instruct; emotion via text cues only", flush=True)
                        wavs, sr = base.generate_voice_clone(
                            text=texts, language=langs, voice_clone_prompt=prompt)
                else:
                    wavs, sr = base.generate_voice_clone(
                        text=texts, language=langs, voice_clone_prompt=prompt)
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
