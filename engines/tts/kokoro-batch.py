# DRAMATIS Kokoro TTS engine - batch renderer (kokoro-onnx).
# Reads a JSON manifest [{text, voice, speed, out}] and synthesizes each entry
# to a 24 kHz WAV. Deterministic for identical inputs.
import json
import sys
import pathlib

import soundfile as sf
from kokoro_onnx import Kokoro

HERE = pathlib.Path(__file__).resolve().parent
MODELS = HERE.parent.parent / "models" / "kokoro"


def main(manifest_path: str) -> None:
    items = json.loads(pathlib.Path(manifest_path).read_text(encoding="utf-8"))
    kokoro = Kokoro(str(MODELS / "kokoro-v1.0.onnx"), str(MODELS / "voices-v1.0.bin"))
    for n, it in enumerate(items, 1):
        lang = "en-gb" if it["voice"].startswith("b") else "en-us"
        samples, sample_rate = kokoro.create(
            it["text"], voice=it["voice"], speed=float(it.get("speed", 1.0)), lang=lang
        )
        sf.write(it["out"], samples, sample_rate)
        if n % 25 == 0:
            print(f"synth {n}/{len(items)}", flush=True)
    print(f"synth complete: {len(items)} items", flush=True)


if __name__ == "__main__":
    main(sys.argv[1])
