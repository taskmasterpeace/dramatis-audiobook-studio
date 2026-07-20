# DRAMATIS Kokoro TTS engine - batch renderer (kokoro-onnx).
# Reads a JSON manifest [{text, voice, speed, out}] and synthesizes each entry
# to a 24 kHz WAV. Deterministic for identical inputs.
#
# CHUNKING (2026-07-19): Kokoro hard-caps at 510 phonemes per call — long text
# warned "Phonemes are too long, truncating" and then died. Long text is now
# split on sentence boundaries into safe chunks, synthesized separately, and
# concatenated with a natural breath. One job still = one output wav, so the
# cache key and the engine interface are unchanged.
import json
import re
import sys
import pathlib

import numpy as np
import soundfile as sf
from kokoro_onnx import Kokoro

HERE = pathlib.Path(__file__).resolve().parent
MODELS = HERE.parent.parent / "models" / "kokoro"

MAX_CHARS = 280        # conservative: 510 phonemes is roughly 300-400 chars
GAP_SEC = 0.18         # breath between chunks so the joins sound natural

# Voice-id prefix -> phonemizer language. Probed against this install: bare "fr"
# and "zh" are INVALID; the accepted codes are "fr-fr" and "cmn".
LANG_BY_PREFIX = {
    "a": "en-us", "b": "en-gb", "e": "es", "f": "fr-fr", "h": "hi",
    "i": "it", "j": "ja", "p": "pt-br", "z": "cmn",
}


def split_chunks(text, limit=MAX_CHARS):
    """Sentence-first packing; falls back to clauses, then a hard split."""
    text = text.strip()
    if len(text) <= limit:
        return [text]

    pieces = []
    for s in re.split(r'(?<=[.!?])\s+', text):
        s = s.strip()
        if not s:
            continue
        if len(s) <= limit:
            pieces.append(s)
            continue
        # too long even as a single sentence -> break on clause punctuation
        buf = ''
        for c in re.split(r'(?<=[,;:])\s+', s):
            c = c.strip()
            while len(c) > limit:                    # last resort: hard split on a space
                cut = c.rfind(' ', 0, limit)
                if cut <= 0:
                    cut = limit
                pieces.append(c[:cut].strip())
                c = c[cut:].strip()
            if not c:
                continue
            if len(buf) + len(c) + 1 <= limit:
                buf = f'{buf} {c}'.strip()
            else:
                if buf:
                    pieces.append(buf)
                buf = c
        if buf:
            pieces.append(buf)

    # pack short sentences back together up to the limit
    packed, buf = [], ''
    for p in pieces:
        if len(buf) + len(p) + 1 <= limit:
            buf = f'{buf} {p}'.strip()
        else:
            if buf:
                packed.append(buf)
            buf = p
    if buf:
        packed.append(buf)
    return [p for p in packed if p]


def main(manifest_path: str) -> None:
    items = json.loads(pathlib.Path(manifest_path).read_text(encoding="utf-8"))
    kokoro = Kokoro(str(MODELS / "kokoro-v1.0.onnx"), str(MODELS / "voices-v1.0.bin"))
    for n, it in enumerate(items, 1):
        # Language comes from the voice's id prefix, not "does it start with b".
        # The old rule ("en-gb" if b*, else "en-us") fed every Spanish, French,
        # Hindi, Italian, Portuguese, Japanese and Chinese voice AMERICAN ENGLISH
        # phonemes — 26 of the 54 voices were mis-phonemized. Note fr-fr and cmn:
        # bare "fr" and "zh" are rejected by the phonemizer.
        lang = it.get("lang") or LANG_BY_PREFIX.get(it["voice"][:1], "en-us")
        chunks = split_chunks(it["text"])
        if len(chunks) > 1:
            print(f"[kokoro] long text -> {len(chunks)} chunks", flush=True)
        audio, sample_rate = [], 24000
        for i, chunk in enumerate(chunks):
            samples, sample_rate = kokoro.create(
                chunk, voice=it["voice"], speed=float(it.get("speed", 1.0)), lang=lang
            )
            audio.append(samples)
            if i < len(chunks) - 1:
                audio.append(np.zeros(int(GAP_SEC * sample_rate), dtype=samples.dtype))
        sf.write(it["out"], np.concatenate(audio), sample_rate)
        if n % 25 == 0:
            print(f"synth {n}/{len(items)}", flush=True)
    print(f"synth complete: {len(items)} items", flush=True)


if __name__ == "__main__":
    main(sys.argv[1])
