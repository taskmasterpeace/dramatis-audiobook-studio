// Regression test for the 2026-07-27 "a character's voice changes every
// chapter" defect.
//
// THE INCIDENT: ref_path() hashed `design|ref_text`, and ref_text was chosen
// from the lines in the current batch — which is only the CACHE MISSES, and the
// CLI renders chapter by chapter. Every chapter therefore picked a different
// reference line, hashed to a different path, and generated a brand-new
// VoiceDesign clip. VoiceDesign is non-deterministic, so the same character
// came back as a genuinely different voice each chapter; the shipped liu-xiao
// book had EIGHT reference clips for `liu` across its 8 chapters. The register
// gate only checks gender, so male->male drift passed silently — the only way
// to notice was to listen across a chapter boundary.
//
// THE INVARIANT: a designed voice's reference path depends ONLY on its design.
// Same design -> same path, no matter what lines are in the batch.
//
// qwen3-batch.py imports torch at module scope, so this extracts just the
// ref_path function with `ast` and execs it — the real shipped code, none of
// the machine-learning weight.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const py = ['.venv/Scripts/python.exe', '.venv/bin/python']
  .map((p) => path.join(root, ...p.split('/')))
  .find((p) => existsSync(p)) || 'python';

// The probe must never THROW on the buggy shape — on the old 3-arg ref_path a
// thrown TypeError got swallowed as "python unavailable" and the test skipped,
// i.e. it passed while the bug was live. It reports facts; Node does the
// asserting.
const PROBE = `
import ast, hashlib, pathlib, json
src = open(r"${path.join(root, 'engines', 'tts', 'qwen3-batch.py').replace(/\\/g, '\\\\')}", encoding="utf-8").read()
tree = ast.parse(src)
keep = [n for n in tree.body
        if (isinstance(n, ast.FunctionDef) and n.name == "ref_path")
        or (isinstance(n, ast.Assign) and getattr(n.targets[0], "id", "") == "REF_TEXT")]
ns = {"hashlib": hashlib, "pathlib": pathlib}
exec(compile(ast.Module(body=keep, type_ignores=[]), "<probe>", "exec"), ns)
ref_path = ns["ref_path"]
arity = ref_path.__code__.co_argcount

design = "Elderly Chinese man in his 70s; thin, weathered voice; light Mandarin-accented English."
other  = "A bright young woman in her twenties."

stable = None
distinct = None
if arity == 2:
    # the real failure shape: 8 chapters, each a batch of different lines
    stable = len({str(ref_path("out", design)) for _ in range(8)}) == 1
    distinct = str(ref_path("out", design)) != str(ref_path("out", other))
else:
    # legacy shape: identity depended on a per-batch line, so simulate chapters
    lines = ["Chapter %d line of a length that shifts the pick." % i for i in range(8)]
    stable = len({str(ref_path("out", design, t)) for t in lines}) == 1
    distinct = True

print(json.dumps({"arity": arity, "stable": stable,
                  "distinct_by_design": distinct, "has_ref_text": "REF_TEXT" in ns}))
`;

test('a designed voice resolves to ONE reference clip regardless of batch', () => {
  // Availability is checked SEPARATELY from the probe. Folding them into one
  // try/catch is what let a real failure masquerade as "no python" and skip.
  try {
    execFileSync(py, ['-c', 'print(1)'], { encoding: 'utf8', stdio: 'pipe' });
  } catch {
    console.log('  (python unavailable — voice-stability probe skipped)');
    return;
  }
  let out;
  try {
    out = execFileSync(py, ['-c', PROBE], { encoding: 'utf8', cwd: root, stdio: 'pipe' });
  } catch (e) {
    assert.fail(`voice-stability probe failed to run: ${String(e.stderr || e.message).slice(0, 300)}`);
  }
  const r = JSON.parse(out.trim().split('\n').pop());

  assert.equal(r.stable, true,
    'the same design must always resolve to the same reference clip');

  // THE REGRESSION GUARD: ref_path must not accept a per-batch text argument.
  // With (cache_root, design, ref_text) the caller could — and did — feed it a
  // line chosen from whatever happened to be in this chapter.
  assert.equal(r.arity, 2,
    'ref_path must take only (cache_root, design); a text argument reintroduces batch-dependence');

  assert.equal(r.has_ref_text, true,
    'the reference sentence must be a fixed module constant, not derived from book lines');

  assert.equal(r.distinct_by_design, true,
    'different designs must still get different reference clips');
});
