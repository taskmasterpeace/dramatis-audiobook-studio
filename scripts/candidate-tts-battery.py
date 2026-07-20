"""Chatterbox candidate battery.

The claim under test: Chatterbox clones from a ~10 s reference AND gives cloned
voices a per-line emotion dial — the exact thing Qwen3 clone mode cannot do
(instruct is ignored on clones), which is why hero lines currently cost money.

So we test it the way we'd use it: clone OUR existing company actors from the
seed clips already on disk, speak a line they have never spoken, and machine-gate
the result the same way the Qwen3 register gate does — pitch must land in the
band the character was cast in. The ear is the last check, never the first.
"""
import pathlib
import sys
import time

import numpy as np
import soundfile as sf
import torch
import librosa

ROOT = pathlib.Path("D:/git/dramatis")
OUT = ROOT / "out" / "chatterbox-battery"
OUT.mkdir(parents=True, exist_ok=True)

# (actor, expected register, why it's a hard case)
ACTORS = [
    ("nola-elder", "female", "elderly New Orleans woman — age + accent, our #1 ear result"),
    ("liu-xiao", "male", "elderly Mandarin-accented man — the accent redo"),
]
LINE = ("They told me the road would be clear by morning, but I have lived long enough "
        "to know better.")
# the emotion dial Qwen3 clones don't have; 0.5 is the documented neutral
EXAGGERATIONS = [0.5, 1.0]

FEMALE_MIN, MALE_MAX = 170.0, 150.0


def median_f0(path):
    y, sr = librosa.load(path, sr=None, mono=True)
    f0, voiced, _ = librosa.pyin(y, fmin=60, fmax=400, sr=sr)
    vals = f0[~np.isnan(f0)]
    return float(np.median(vals)) if len(vals) else 0.0


def register_of(hz):
    if hz <= 0:
        return "silent"
    return "female" if hz > FEMALE_MIN else "male" if hz < MALE_MAX else "ambiguous"


def main():
    from chatterbox.tts import ChatterboxTTS
    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"[battery] loading Chatterbox on {device}", flush=True)
    t0 = time.time()
    model = ChatterboxTTS.from_pretrained(device=device)
    print(f"[battery] loaded in {time.time() - t0:.1f}s", flush=True)

    fails = 0
    for actor, expect, why in ACTORS:
        ref = ROOT / "actors" / actor / "seed.wav"
        if not ref.exists():
            print(f"[battery] SKIP {actor}: no seed.wav")
            continue
        # Our seeds are ~24-28 s, but every cloning engine we've measured
        # (and Chatterbox's own docs) wants ~10 s — Qwen3 clone quality
        # degrades past ~15 s. Trim so the engine gets the input it asks for,
        # otherwise a failure blames the model for our file handling.
        # ...and take the MOST REPRESENTATIVE window, not the first one. Taking
        # the opening 10 s of liu-xiao's seed handed the model a 160 Hz slice of
        # a 143 Hz voice, and the clone faithfully reproduced the slice — a
        # register failure caused entirely by our own reference selection.
        # Pick the window whose median F0 is closest to the whole clip's.
        import os as _os
        trim_s = float(_os.environ.get("REF_SECONDS", "10"))
        y, sr_ref = librosa.load(str(ref), sr=None, mono=True)
        if trim_s > 0 and len(y) > sr_ref * trim_s:
            full_hz = median_f0(str(ref))
            win = int(sr_ref * trim_s)
            best, best_gap = 0, 1e9
            for start in range(0, len(y) - win + 1, int(sr_ref * 2)):   # 2 s hop
                seg = y[start:start + win]
                f0, _, _ = librosa.pyin(seg, fmin=60, fmax=400, sr=sr_ref)
                vals = f0[~np.isnan(f0)]
                if len(vals) < 10:
                    continue
                gap = abs(float(np.median(vals)) - full_hz)
                if gap < best_gap:
                    best, best_gap = start, gap
            ref_trim = OUT / f"{actor}-ref{int(trim_s)}s.wav"
            sf.write(str(ref_trim), y[best:best + win], sr_ref)
            print(f"[battery]   picked window @{best / sr_ref:.0f}s "
                  f"(clip median {full_hz:.0f} Hz, window gap {best_gap:.0f} Hz)")
            ref = ref_trim
        ref_hz = median_f0(str(ref))
        dur = librosa.get_duration(path=str(ref))
        print(f"\n[battery] {actor} — {why}")
        print(f"[battery]   reference: {dur:.1f}s, median F0 {ref_hz:.0f} Hz ({register_of(ref_hz)})")

        for ex in EXAGGERATIONS:
            t = time.time()
            wav = model.generate(LINE, audio_prompt_path=str(ref), exaggeration=ex, cfg_weight=0.5)
            secs = time.time() - t
            dest = OUT / f"{actor}-ex{ex}.wav"
            sf.write(str(dest), wav.squeeze(0).cpu().numpy(), model.sr)
            got_hz = median_f0(str(dest))
            got_dur = librosa.get_duration(path=str(dest))
            reg = register_of(got_hz)
            ok = reg == expect
            drift = abs(got_hz - ref_hz)
            if not ok:
                fails += 1
            print(f"[battery]   exaggeration {ex}: {secs:5.1f}s wall · {got_dur:4.1f}s audio · "
                  f"F0 {got_hz:5.0f} Hz ({reg}) · drift {drift:5.0f} Hz · "
                  f"REGISTER {'PASS' if ok else 'FAIL'} · {dest.name}")

    print(f"\n[battery] {'ALL REGISTER GATES PASSED' if not fails else str(fails) + ' REGISTER FAILURE(S)'}")
    print(f"[battery] clips in {OUT}")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
