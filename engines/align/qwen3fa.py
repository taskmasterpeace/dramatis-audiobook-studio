# DRAMATIS forced-alignment sidecar (Qwen3-ForcedAligner-0.6B, Apache-2.0).
# Manifest: [{ "id": "...", "wav": "...wav", "text": "..." }]
# Writes JSON: { "<id>": [{ "word": "...", "start": 0.0, "end": 0.0 }] }
import json
import os
import pathlib
import sys

os.environ.setdefault("HF_HOME", str(pathlib.Path(__file__).resolve().parents[2] / "models" / "hf"))

import torch
from qwen_asr import Qwen3ForcedAligner


def norm_result(r):
    # r: ForcedAlignResult with .items (ForcedAlignItem: text/start_time/end_time)
    items = getattr(r, "items", None)
    if items is None and isinstance(r, dict):
        items = r.get("items")
    out = []
    for w in items or []:
        if isinstance(w, dict):
            out.append({"word": w.get("text") or w.get("word") or "",
                        "start": float(w.get("start_time", w.get("start", 0.0))),
                        "end": float(w.get("end_time", w.get("end", 0.0)))})
        else:
            out.append({"word": getattr(w, "text", getattr(w, "word", "")),
                        "start": float(getattr(w, "start_time", getattr(w, "start", 0.0))),
                        "end": float(getattr(w, "end_time", getattr(w, "end", 0.0)))})
    return out


def main(manifest_path, out_path):
    items = json.loads(pathlib.Path(manifest_path).read_text(encoding="utf-8"))
    # device_map was hard-coded to "cuda:0", which made the whole sound-effect
    # layer GPU-only and crashed CPU-only machines AFTER the expensive TTS pass
    # had already finished. The correct probe was already in this repo — see
    # engines/sfx/clap-index.py — it just was never applied here. bfloat16 is a
    # GPU format; CPU needs float32.
    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"[align] device={device}", flush=True)
    model = Qwen3ForcedAligner.from_pretrained(
        "Qwen/Qwen3-ForcedAligner-0.6B",
        device_map=device if device == "cpu" else "cuda:0",
        dtype=torch.bfloat16 if device == "cuda" else torch.float32)
    result = {}
    for it in items:
        r = model.align(audio=it["wav"], text=it["text"], language="English")
        results = r if isinstance(r, list) else [r]
        words = []
        for rr in results:
            words.extend(norm_result(rr))
        result[it["id"]] = words
        if len(result) % 25 == 0:
            print(f"align {len(result)}/{len(items)}", flush=True)
    pathlib.Path(out_path).write_text(json.dumps(result), encoding="utf-8")
    print(f"align complete: {len(result)} items", flush=True)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
