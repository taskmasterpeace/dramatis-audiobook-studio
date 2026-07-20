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
# This checkpoint's processor is configured truncation="rand_trunc" with
# max_length_s=10. Feeding it a 20 s clip therefore embedded a RANDOM 10 s crop:
# the index was nondeterministic, two builds of the same corpus disagreed, and a
# long clip was represented by whatever slice it happened to draw — the likely
# cause of a city-night bed that retrieved as "a helicopter". We now cut clips
# into fixed CHUNK_SEC windows ourselves and mean-pool the embeddings, so the
# whole clip is represented and the same audio always yields the same vector.
CHUNK_SEC = 10


def load_mono_48k(path):
    wav, sr = sf.read(path, dtype="float32", always_2d=True)
    wav = wav.mean(axis=1)
    if sr != SR:
        import librosa
        wav = librosa.resample(wav, orig_sr=sr, target_sr=SR)
    return wav[: SR * MAX_SEC]


def chunks_of(wav):
    """Deterministic CHUNK_SEC windows covering the clip (last one padded)."""
    n = SR * CHUNK_SEC
    if len(wav) <= n:
        return [np.pad(wav, (0, n - len(wav)))] if len(wav) < n else [wav]
    out = [wav[i:i + n] for i in range(0, len(wav), n)]
    if len(out[-1]) < n:
        out[-1] = np.pad(out[-1], (0, n - len(out[-1])))
    return out


def classify_license(lic):
    """CC0 ships freely; CC-BY ships WITH CREDIT; everything else is refused.

    CC-BY-NC and Sampling+ are excluded on purpose — a non-commercial clip in a
    corpus that scores a book someone might sell is a licence violation waiting
    to happen, and 'we only used it for retrieval' is not a defence.
    """
    lic = (lic or "").lower()
    if "zero" in lic or "publicdomain" in lic:
        return "cc0"
    if "by-nc" in lic or "nc/" in lic:
        return None
    if "sampling" in lic:
        return None
    if "/by/" in lic or "by-sa" in lic:
        return "cc-by"
    return None


def main(corpus_dir, metadata_json, out_dir):
    corpus = pathlib.Path(corpus_dir)
    info = json.loads(pathlib.Path(metadata_json).read_text(encoding="utf-8"))
    # INCLUDE_CC_BY=1 roughly doubles the usable corpus at the cost of shipping
    # an attribution file. Off by default so a plain build stays credit-free.
    allow_by = os.environ.get("INCLUDE_CC_BY") == "1"
    rows = []
    counts = {"cc0": 0, "cc-by": 0, "refused": 0, "missing": 0}
    for fname, meta in info.items():
        kind = classify_license(meta.get("license"))
        if kind is None or (kind == "cc-by" and not allow_by):
            counts["refused"] += 1
            continue
        wav = corpus / f"{fname}.wav"
        if not wav.exists():
            counts["missing"] += 1
            continue
        caption = f'{meta.get("title", "")} — {meta.get("description", "")} ({", ".join(meta.get("tags", []))})'
        rows.append({"file": str(wav), "caption": caption, "license": meta.get("license", ""),
                     "licence_kind": kind, "uploader": meta.get("uploader", ""), "fsd_id": fname})
        counts[kind] += 1
    print(f"[index] {len(rows)} clips to embed "
          f"(CC0 {counts['cc0']}, CC-BY {counts['cc-by']}, refused {counts['refused']}, "
          f"not-on-disk {counts['missing']})", flush=True)
    if not rows:
        sys.exit("no clips found — check corpus dir and license column")

    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = ClapModel.from_pretrained(MODEL_ID).to(device).eval()
    proc = ClapProcessor.from_pretrained(MODEL_ID)

    # One row -> possibly several chunks; embed all chunks flat, then mean-pool
    # back per row so every clip yields exactly one deterministic vector.
    B = 16
    embeds = []
    for i in range(0, len(rows), B):
        batch = rows[i:i + B]
        wavs, spans = [], []
        for r in batch:
            try:
                cs = chunks_of(load_mono_48k(r["file"]))
            except Exception as e:
                print(f"[index] skip unreadable {r['file']}: {e}", flush=True)
                cs = [np.zeros(SR * CHUNK_SEC, dtype=np.float32)]
            spans.append(len(cs))
            wavs.extend(cs)
        inputs = proc(audios=wavs, sampling_rate=SR, return_tensors="pt", padding=True)
        with torch.no_grad():
            e = model.get_audio_features(**{k: v.to(device) for k, v in inputs.items()}).cpu().numpy()
        at = 0
        for n in spans:
            embeds.append(e[at:at + n].mean(axis=0, keepdims=True))
            at += n
        print(f"[index] embedded {min(i + B, len(rows))}/{len(rows)}", flush=True)
    emb = np.vstack(embeds).astype(np.float32)
    emb /= np.linalg.norm(emb, axis=1, keepdims=True) + 1e-8

    out = pathlib.Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    np.save(out / "embeddings.npy", emb)
    (out / "manifest.json").write_text(json.dumps(rows), encoding="utf-8")

    # CC-BY is not free — it is free WITH CREDIT. Generate the credits file
    # alongside the index so the obligation can never drift from the corpus.
    by = [r for r in rows if r.get("licence_kind") == "cc-by"]
    if by:
        lines = ["# Sound-effect credits", "",
                 "Clips in this corpus licensed CC-BY require attribution. Each line is",
                 "the Freesound id, its uploader, and the licence it is used under.",
                 "Source dataset: FSD50K (Fonseca et al.), built from Freesound.", ""]
        for r in sorted(by, key=lambda x: x["fsd_id"]):
            lines.append(f"- freesound #{r['fsd_id']} by {r['uploader'] or 'unknown'} — {r['license']}")
        (out / "CREDITS.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
        print(f"[index] wrote CREDITS.md for {len(by)} CC-BY clips", flush=True)
    print(f"[index] wrote {len(rows)} vectors -> {out}", flush=True)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3])
