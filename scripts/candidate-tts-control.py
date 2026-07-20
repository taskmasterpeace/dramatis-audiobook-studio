"""Control arm of the Chatterbox battery.

Both actors in the main battery are ELDERLY voices (152 / 143 Hz) sitting right
on the 150/170 Hz register lines — the hardest possible case, and not a fair
basis for a verdict on its own. These controls are unambiguous: a bright female
and a deep male, well clear of both thresholds. If Chatterbox holds register
here but not on the elderly pair, the finding is "boundary voices drift". If it
drifts here too, the finding is "it drifts upward, full stop".
"""
import pathlib
import time

import librosa
import numpy as np
import soundfile as sf
from chatterbox.tts import ChatterboxTTS

OUT = pathlib.Path("D:/git/dramatis/out/chatterbox-battery")
LINE = "They told me the road would be clear by morning, but I have lived long enough to know better."


def f0(p):
    y, sr = librosa.load(p, sr=None, mono=True)
    f, _, _ = librosa.pyin(y, fmin=60, fmax=400, sr=sr)
    v = f[~np.isnan(f)]
    return float(np.median(v)) if len(v) else 0.0


def reg(h):
    return "female" if h > 170 else "male" if h < 150 else "ambiguous"


m = ChatterboxTTS.from_pretrained(device="cuda")
print("[control] unambiguous voices, well clear of the gate lines", flush=True)
fails = 0
for name, expect in [("control-female", "female"), ("control-male", "male")]:
    src = str(OUT / f"{name}-src.wav")
    rh = f0(src)
    print(f"[control] {name}: reference {rh:.0f} Hz ({reg(rh)}), expect {expect}", flush=True)
    for ex in (0.5, 1.0):
        t = time.time()
        w = m.generate(LINE, audio_prompt_path=src, exaggeration=ex, cfg_weight=0.5)
        d = OUT / f"{name}-ex{ex}.wav"
        sf.write(str(d), w.squeeze(0).cpu().numpy(), m.sr)
        gh = f0(str(d))
        ok = reg(gh) == expect
        if not ok:
            fails += 1
        print(f"[control]    ex{ex}: {time.time() - t:5.1f}s | F0 {gh:5.0f} Hz ({reg(gh)}) "
              f"| drift {gh - rh:+5.0f} Hz | {'PASS' if ok else 'FAIL'}", flush=True)
print(f"[control] {'ALL PASS' if not fails else str(fails) + ' FAIL'}")
