# One-time setup for the Kokoro TTS engine (Apache-2.0 model, ~340 MB).
$ErrorActionPreference = "Stop"
$dir = Join-Path $PSScriptRoot "..\models\kokoro"
New-Item -ItemType Directory -Force $dir | Out-Null
python -m pip install kokoro-onnx soundfile
$base = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
foreach ($f in "kokoro-v1.0.onnx", "voices-v1.0.bin") {
  $dest = Join-Path $dir $f
  if (-not (Test-Path $dest)) {
    Write-Output "downloading $f..."
    curl.exe -sL -o $dest "$base/$f"
  }
}
Write-Output "kokoro ready. Produce with: node bin/dramatis.mjs produce <book.json> --tts kokoro"
