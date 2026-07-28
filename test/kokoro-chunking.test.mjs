// Regression test for the Kokoro 509-phoneme crash — round TWO.
//
// THE INCIDENT (first fix, 2026-07-20): the chunker budgeted CHARACTERS against
// a model whose hard limit is PHONEMES. Prose runs ~1.0 phonemes/char but a run
// of digits hits 8.2, so `" ".join(["8109432"]*14)` — 111 chars, far under the
// 280-char budget — produced 937 phonemes and raised IndexError. Fixed by
// budgeting phonemes.
//
// THE INCIDENT (this fix, 2026-07-27): that fix split words on `' '` — the
// ASCII space only. The SAME payload separated by newlines or tabs still
// produced one 937-phoneme chunk and still crashed. It was tested against the
// one input shape it had been handed. Quick Narrate and the hub pass user text
// straight through without collapsing whitespace, so a pasted multi-line list
// of numbers or dates reached the model over-cap.
//
// The invariant, stated once so no third round is needed: NO input produces a
// chunk over the cap — whatever whitespace separates it, and even if a single
// token has no whitespace at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const py = ['.venv/Scripts/python.exe', '.venv/bin/python']
  .map((p) => path.join(root, ...p.split('/')))
  .find((p) => existsSync(p));
const model = path.join(root, 'models', 'kokoro', 'kokoro-v1.0.onnx');

const PROBE = `
import importlib.util, json, pathlib
spec = importlib.util.spec_from_file_location("kb", r"${path.join(root, 'engines', 'tts', 'kokoro-batch.py').replace(/\\/g, '\\\\')}")
kb = importlib.util.module_from_spec(spec); spec.loader.exec_module(kb)
from kokoro_onnx import Kokoro
M = pathlib.Path(r"${path.join(root, 'models', 'kokoro').replace(/\\/g, '\\\\')}")
k = Kokoro(str(M / "kokoro-v1.0.onnx"), str(M / "voices-v1.0.bin"))

digits = ["8109432"] * 14
cases = {
  "space":      " ".join(digits),
  "newline":    "\\n".join(digits),
  "tab":        "\\t".join(digits),
  "nbsp":       "\\u00a0".join(digits),
  "mixed":      "8109432\\n\\t 8109432\\r\\n8109432 " * 5,
  "giant_token": "8" * 600,
  "long_url":   "https://example.com/" + ("a" * 400),
  "prose":      "The rain came early that evening, and the city held its breath.",
  "empty":      "",
}
out = {}
for name, txt in cases.items():
    chunks = kb.phoneme_chunks(k, txt, "en-us")
    worst = max([len(k.tokenizer.phonemize(c, "en-us")) for c in chunks], default=0)
    # text must survive the split: compare non-whitespace characters
    keep = "".join(txt.split())
    got = "".join("".join(c.split()) for c in chunks)
    out[name] = {"max": worst, "chunks": len(chunks), "lossless": got == keep}
print(json.dumps(out))
`;

test('no input produces a chunk over the 509-phoneme cap', { timeout: 180000 }, () => {
  if (!py || !existsSync(model)) {
    console.log('  (venv or kokoro model missing — chunking probe skipped)');
    return;
  }
  let raw;
  try {
    raw = execFileSync(py, ['-c', PROBE], { encoding: 'utf8', cwd: root, stdio: 'pipe' });
  } catch (e) {
    // A crash here is the bug itself (IndexError), never a reason to skip.
    assert.fail(`chunking probe failed: ${String(e.stderr || e.message).slice(0, 400)}`);
  }
  const res = JSON.parse(raw.trim().split('\n').pop());

  const CAP = 509;
  for (const [name, r] of Object.entries(res)) {
    assert.ok(r.max <= CAP,
      `"${name}" produced a ${r.max}-phoneme chunk (cap ${CAP}) — the model raises IndexError here`);
    assert.ok(r.lossless, `"${name}" lost text while chunking`);
  }

  // the specific regressions, named so a failure says which one came back
  assert.ok(res.newline.max <= CAP, 'newline-separated digits must be split (round-2 regression)');
  assert.ok(res.tab.max <= CAP, 'tab-separated digits must be split (round-2 regression)');
  assert.ok(res.giant_token.max <= CAP, 'a single whitespace-free token must still be split');
});
