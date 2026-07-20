# Voice sanity gate: measure fundamental frequency (F0) of a rendered voice
# and classify the register. A designed voice whose description says woman/man
# MUST land in the matching range before it ships — no human should ever be
# the first to discover a gender mismatch.
#   python pitch-check.py <wav> -> JSON {f0_median, voiced_ratio, register}
import json
import sys

import librosa
import numpy as np


def main(path):
    y, sr = librosa.load(path, sr=22050, mono=True)
    f0, voiced_flag, _ = librosa.pyin(
        y, fmin=60, fmax=420, sr=sr, frame_length=2048)
    voiced = f0[~np.isnan(f0)]
    if len(voiced) < 10:
        print(json.dumps({"error": "too little voiced audio"}))
        return
    med = float(np.median(voiced))
    # Typical adult ranges: male ~85-155 Hz, female ~165-255 Hz.
    if med < 150:
        register = "male-range"
    elif med > 170:
        register = "female-range"
    else:
        register = "ambiguous"
    print(json.dumps({
        "f0_median": round(med, 1),
        "f0_p10": round(float(np.percentile(voiced, 10)), 1),
        "f0_p90": round(float(np.percentile(voiced, 90)), 1),
        "voiced_ratio": round(float(len(voiced)) / len(f0), 3),
        "register": register,
    }))


if __name__ == "__main__":
    main(sys.argv[1])
