# Retrieval battery: score an audio-text embedder against OUR corpus, using
# FSD50K's official ground-truth labels as the answer key.
#
#   python scripts/retrieval-bench.py clap    # incumbent: laion/clap-htsat-unfused
#   python scripts/retrieval-bench.py glap    # candidate: mispeech/GLAP
#
# Why this exists: swapping a retrieval model on vibes is how you ship a
# regression nobody notices until a listener hears a helicopter in a city-night
# bed. FSD50K ships per-clip labels over a 200-class vocabulary, so for a query
# like "the sound of a dog barking" we know exactly which corpus clips are
# correct — that turns "feels better" into R@1 / R@3 / MRR.
#
# Only classes with enough clips IN OUR INDEXED SUBSET are queried, so the score
# describes the corpus we actually ship, not the paper's benchmark split.
import csv
import json
import pathlib
import sys
import os

os.environ.setdefault("HF_HOME", str(pathlib.Path(__file__).resolve().parents[1] / "models" / "hf"))

import numpy as np
import soundfile as sf
import torch

ROOT = pathlib.Path(__file__).resolve().parents[1]
INDEX = ROOT / "corpus" / "index-all"
GT = ROOT / "corpus" / "fsd50k" / "FSD50K.ground_truth"
SR = 48000
CHUNK_SEC = 10
MIN_CLIPS_PER_CLASS = 3      # a class needs enough positives to be meaningful
MAX_CLASSES = 60             # keep a run to a few minutes


def load_labels():
    """fname -> set(labels), from both FSD50K splits."""
    out = {}
    for split in ("dev.csv", "eval.csv"):
        p = GT / split
        if not p.exists():
            continue
        with open(p, newline="", encoding="utf-8") as f:
            for row in csv.DictReader(f):
                out[row["fname"]] = set(row["labels"].split(","))
    return out


def load_mono(path):
    wav, sr = sf.read(path, dtype="float32", always_2d=True)
    wav = wav.mean(axis=1)
    if sr != SR:
        import librosa
        wav = librosa.resample(wav, orig_sr=sr, target_sr=SR)
    return wav[: SR * 20]


def chunks_of(wav, sr_in=SR):
    n = sr_in * CHUNK_SEC
    if len(wav) <= n:
        return [np.pad(wav, (0, n - len(wav)))] if len(wav) < n else [wav]
    out = [wav[i:i + n] for i in range(0, len(wav), n)]
    if len(out[-1]) < n:
        out[-1] = np.pad(out[-1], (0, n - len(out[-1])))
    return out


class Clap:
    """Incumbent. 48 kHz in; deterministic chunk + mean-pool (see clap-index.py)."""
    name = "laion/clap-htsat-unfused"
    sr = 48000

    def __init__(self, device):
        from transformers import ClapModel, ClapProcessor
        self.device = device
        self.m = ClapModel.from_pretrained(self.name).to(device).eval()
        self.p = ClapProcessor.from_pretrained(self.name)

    def text(self, prompts):
        i = self.p(text=prompts, return_tensors="pt", padding=True)
        with torch.no_grad():
            e = self.m.get_text_features(**{k: v.to(self.device) for k, v in i.items()})
        return self._norm(e.cpu().numpy())

    def audio(self, wavs):
        i = self.p(audios=wavs, sampling_rate=self.sr, return_tensors="pt", padding=True)
        with torch.no_grad():
            e = self.m.get_audio_features(**{k: v.to(self.device) for k, v in i.items()})
        return e.cpu().numpy()

    @staticmethod
    def _norm(x):
        return x / (np.linalg.norm(x, axis=1, keepdims=True) + 1e-8)


class Glap:
    """Candidate: Xiaomi GLAP (Apache-2.0). Dasheng encoder wants 16 kHz."""
    name = "mispeech/GLAP"
    sr = 16000

    def __init__(self, device):
        from transformers import AutoModel
        self.device = device
        self.m = AutoModel.from_pretrained(self.name, trust_remote_code=True).to(device).eval()
        # UPSTREAM BUG: encode_text() builds its token tensors with a hardcoded
        # device="cpu", then feeds them to a text_encoder that we just moved to
        # CUDA — it only moves the OUTPUT to device, which is too late, so text
        # encoding raises on any GPU. Keeping just the text encoder on CPU is
        # the clean workaround: it's a few short prompts, and text_proj still
        # runs on GPU because encode_text moves the embedding across itself.
        self.m.text_encoder.to("cpu")

    def text(self, prompts):
        with torch.no_grad():
            e = self.m.encode_text(prompts)
        return Clap._norm(np.asarray(e.cpu()))

    def audio(self, wavs):
        t = torch.from_numpy(np.stack(wavs)).to(self.device)
        with torch.no_grad():
            e = self.m.encode_audio(t)
        return np.asarray(e.cpu())


def main(which):
    manifest = json.loads((INDEX / "manifest.json").read_text(encoding="utf-8"))
    labels = load_labels()

    # fname (stem) per indexed clip; house clips have no FSD label -> excluded
    stems = [pathlib.Path(r["file"]).stem for r in manifest]
    labeled = [(i, s) for i, s in enumerate(stems) if s in labels]
    print(f"[bench] {len(manifest)} indexed clips, {len(labeled)} with ground-truth labels")

    # pick query classes that are well represented in OUR subset
    counts = {}
    for i, s in labeled:
        for lab in labels[s]:
            counts.setdefault(lab, []).append(i)
    classes = sorted([c for c, v in counts.items() if len(v) >= MIN_CLIPS_PER_CLASS],
                     key=lambda c: -len(counts[c]))[:MAX_CLASSES]
    print(f"[bench] querying {len(classes)} classes with >={MIN_CLIPS_PER_CLASS} clips each")

    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = {"clap": Clap, "glap": Glap}[which](device)
    print(f"[bench] model={model.name} device={device} sr={model.sr}")

    # embed every labeled clip once, at the model's own sample rate
    idxs = [i for i, _ in labeled]
    embeds = []
    B = 16
    for b in range(0, len(idxs), B):
        batch = idxs[b:b + B]
        wavs, spans = [], []
        for i in batch:
            try:
                w = load_mono(manifest[i]["file"])
                if model.sr != SR:
                    import librosa
                    w = librosa.resample(w, orig_sr=SR, target_sr=model.sr)
                # NOPAD: feed native-length audio instead of zero-padding to a
                # fixed 10 s window. FSD50K clips are often ~1 s, so padding
                # makes an embedding that is 90% silence — which a fixed-window
                # model expects but a variable-length encoder may not.
                cs = [w[: model.sr * CHUNK_SEC]] if os.environ.get("BENCH_NOPAD") else chunks_of(w, model.sr)
            except Exception:
                cs = [np.zeros(model.sr * CHUNK_SEC, dtype=np.float32)]
            spans.append(len(cs))
            wavs.extend(cs)
        e = model.audio(wavs) if not os.environ.get("BENCH_NOPAD") else np.vstack(
            [model.audio([w]) for w in wavs])   # ragged lengths can't batch
        at = 0
        for n in spans:
            v = e[at:at + n].mean(axis=0)
            embeds.append(v / (np.linalg.norm(v) + 1e-8))
            at += n
        if (b // B) % 10 == 0:
            print(f"[bench] embedded {min(b + B, len(idxs))}/{len(idxs)}", flush=True)
    A = np.vstack(embeds).astype(np.float32)

    # one natural-language query per class, in the shape our cues actually take
    prompts = [f"the sound of {c.replace('_and_', ' and ').replace('_', ' ').lower()}" for c in classes]
    T = model.text(prompts)

    r1 = r3 = r10 = 0
    mrr = 0.0
    rows = []
    for qi, cls in enumerate(classes):
        sims = A @ T[qi]
        order = np.argsort(-sims)
        correct = [k for k, (i, s) in enumerate(labeled) if cls in labels[s]]
        cset = set(correct)
        hit1 = order[0] in cset
        hit3 = any(o in cset for o in order[:3])
        hit10 = any(o in cset for o in order[:10])
        rank = next((k + 1 for k, o in enumerate(order) if o in cset), None)
        r1 += hit1; r3 += hit3; r10 += hit10
        mrr += (1.0 / rank) if rank else 0.0
        rows.append({"class": cls, "positives": len(correct), "hit@1": bool(hit1),
                     "hit@3": bool(hit3), "first_rank": rank,
                     "top1_file": pathlib.Path(manifest[labeled[order[0]][0]]["file"]).name})

    n = len(classes)
    out = {"model": model.name, "classes": n, "clips": len(labeled),
           "R@1": round(100 * r1 / n, 1), "R@3": round(100 * r3 / n, 1),
           "R@10": round(100 * r10 / n, 1), "MRR": round(mrr / n, 3), "per_class": rows}
    dest = ROOT / "out" / f"retrieval-bench-{which}.json"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(out, indent=2), encoding="utf-8")
    print(f"\n[bench] {model.name}")
    print(f"[bench] R@1 {out['R@1']}%   R@3 {out['R@3']}%   R@10 {out['R@10']}%   MRR {out['MRR']}")
    print(f"[bench] wrote {dest}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "clap")
