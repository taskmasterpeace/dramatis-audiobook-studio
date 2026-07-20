# Clone a voice sample into Qwen3 and speak new text.
# Turns a premium one-shot voice into a free, unlimited local voice — the
# "premium seed, local volume" pattern.
#   python clone-from-audio.py <ref_wav> <ref_text_file> <new_text_file> <out_wav>
# ref_wav must be clean mono wav (convert with ffmpeg first).
#
# CONSENT — READ THIS BEFORE POINTING IT AT A PERSON.
# This tool reproduces the voice in whatever reference you give it. It cannot
# tell whose voice that is, so the responsibility is entirely yours.
#   * Intended use is synthetic voices you generated yourself (the seeds in
#     actors/ are model output, not recordings of people) and recordings of
#     people who have given you explicit, informed permission for this purpose.
#   * Cloning a real person's voice without consent may be illegal where you
#     are. Tennessee's ELVIS Act and a growing number of state right-of-
#     publicity laws cover synthesized voice specifically, and several reach
#     the distribution of the resulting audio, not just its creation.
#   * If you clone a real person, record who consented and to what, alongside
#     the seed clip, and honour any withdrawal of that consent.
# DRAMATIS ships no celebrity voices and no recordings of real people.
import os
import pathlib
import sys

os.environ.setdefault("HF_HOME", str(pathlib.Path(__file__).resolve().parents[2] / "models" / "hf"))

import soundfile as sf
import torch
from qwen_tts import Qwen3TTSModel

BASE = "Qwen/Qwen3-TTS-12Hz-1.7B-Base"


def main(ref_wav, ref_text_file, new_text_file, out_wav):
    ref_text = pathlib.Path(ref_text_file).read_text(encoding="utf-8").strip()
    new_text = pathlib.Path(new_text_file).read_text(encoding="utf-8").strip()
    print(f"[clone] loading {BASE}", flush=True)
    base = Qwen3TTSModel.from_pretrained(BASE, device_map="cuda:0", dtype=torch.bfloat16)
    print("[clone] building clone prompt from reference audio", flush=True)
    prompt = base.create_voice_clone_prompt(ref_audio=ref_wav, ref_text=ref_text)
    print("[clone] synthesizing new line in the cloned voice", flush=True)
    wavs, sr = base.generate_voice_clone(
        text=[new_text], language=["English"], voice_clone_prompt=prompt)
    sf.write(out_wav, wavs[0], sr)
    print(f"[clone] wrote {out_wav}", flush=True)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4])
