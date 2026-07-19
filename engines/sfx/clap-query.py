# Query a CLAP SFX index (transformers ClapModel).
#   python clap-query.py <index_dir> <queries.json> <out.json>
# queries.json: [{ "id": "cue_x", "text": "wooden door slams", "topk": 3 }]
# out.json:     { "cue_x": [{ "file": "...", "caption": "...", "score": 0.31 }] }
import json
import os
import pathlib
import sys

os.environ.setdefault("HF_HOME", str(pathlib.Path(__file__).resolve().parents[2] / "models" / "hf"))

import numpy as np
import torch
from transformers import ClapModel, ClapProcessor

MODEL_ID = "laion/clap-htsat-unfused"


def main(index_dir, queries_path, out_path):
    idx = pathlib.Path(index_dir)
    emb = np.load(idx / "embeddings.npy")
    manifest = json.loads((idx / "manifest.json").read_text(encoding="utf-8"))
    queries = json.loads(pathlib.Path(queries_path).read_text(encoding="utf-8"))

    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = ClapModel.from_pretrained(MODEL_ID).to(device).eval()
    proc = ClapProcessor.from_pretrained(MODEL_ID)

    texts = [q["text"] for q in queries]
    inputs = proc(text=texts, return_tensors="pt", padding=True)
    with torch.no_grad():
        temb = model.get_text_features(**{k: v.to(device) for k, v in inputs.items()})
    temb = temb.cpu().numpy().astype(np.float32)
    temb /= np.linalg.norm(temb, axis=1, keepdims=True) + 1e-8

    sims = temb @ emb.T
    out = {}
    for qi, q in enumerate(queries):
        k = int(q.get("topk", 3))
        top = np.argpartition(-sims[qi], min(k, sims.shape[1] - 1))[:k]
        top = top[np.argsort(-sims[qi][top])]
        out[q["id"]] = [
            {"file": manifest[j]["file"], "caption": manifest[j]["caption"], "score": float(sims[qi][j])}
            for j in top
        ]
    pathlib.Path(out_path).write_text(json.dumps(out, indent=1), encoding="utf-8")
    print(f"[query] {len(queries)} queries done", flush=True)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3])
