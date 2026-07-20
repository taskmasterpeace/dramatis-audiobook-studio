# Build a CLAP index over a local SFX corpus (transformers ClapModel).
#   python clap-index.py <corpus_dir> <clips_info.json> <out_dir>
# clips_info.json is FSD50K metadata (per-clip title/description/tags/license).
# Only CC0-licensed rows are indexed (permissive-parts policy).
# Writes <out_dir>/embeddings.npy + manifest.json.
import json
import os
import pathlib
import sys

os.environ.setdefault("HF_HOME", str(pathlib.Path(__file__).resolve().parents[2] / "models" / "hf"))

import numpy as np
import soundfile as sf
import torch
from transformers import ClapModel, ClapProcessor

MODEL_ID = "laion/clap-htsat-unfused"
SR = 48000
MAX_SEC = 20


def load_mono_48k(path):
    wav, sr = sf.read(path, dtype="float32", always_2d=True)
    wav = wav.mean(axis=1)
    if sr != SR:
        import librosa
        wav = librosa.resample(wav, orig_sr=sr, target_sr=SR)
    return wav[: SR * MAX_SEC]


def main(corpus_dir, metadata_json, out_dir):
    corpus = pathlib.Path(corpus_dir)
    info = json.loads(pathlib.Path(metadata_json).read_text(encoding="utf-8"))
    rows = []
    for fname, meta in info.items():
        lic = (meta.get("license") or "").lower()
        if "zero" not in lic and "publicdomain" not in lic:
            continue
        wav = corpus / f"{fname}.wav"
        if wav.exists():
            caption = f'{meta.get("title", "")} — {meta.get("description", "")} ({", ".join(meta.get("tags", []))})'
            rows.append({"file": str(wav), "caption": caption, "license": meta.get("license", "")})
    print(f"[index] {len(rows)} CC0 clips to embed", flush=True)
    if not rows:
        sys.exit("no clips found — check corpus dir and license column")

    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = ClapModel.from_pretrained(MODEL_ID).to(device).eval()
    proc = ClapProcessor.from_pretrained(MODEL_ID)

    B = 16
    embeds = []
    for i in range(0, len(rows), B):
        batch = rows[i:i + B]
        wavs = []
        for r in batch:
            try:
                wavs.append(load_mono_48k(r["file"]))
            except Exception as e:
                print(f"[index] skip unreadable {r['file']}: {e}", flush=True)
                wavs.append(np.zeros(SR, dtype=np.float32))
        inputs = proc(audios=wavs, sampling_rate=SR, return_tensors="pt", padding=True)
        with torch.no_grad():
            e = model.get_audio_features(**{k: v.to(device) for k, v in inputs.items()})
        embeds.append(e.cpu().numpy())
        print(f"[index] embedded {min(i + B, len(rows))}/{len(rows)}", flush=True)
    emb = np.vstack(embeds).astype(np.float32)
    emb /= np.linalg.norm(emb, axis=1, keepdims=True) + 1e-8

    out = pathlib.Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    np.save(out / "embeddings.npy", emb)
    (out / "manifest.json").write_text(json.dumps(rows), encoding="utf-8")
    print(f"[index] wrote {len(rows)} vectors -> {out}", flush=True)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3])
