# DRAMATIS first-run bootstrap — downloads everything the app needs to work.
# Runs after install (or on first launch if it hasn't completed yet).
#
# Nothing here is bundled inside the installer on purpose: the Python TTS stack
# pulls in GPL-licensed pieces (espeak-ng via kokoro-onnx's phonemizer), which
# are fine for YOU to install on your own machine but would not be fine for us
# to redistribute inside an Apache-2.0 installer. So the installer ships only
# DRAMATIS itself, and this script fetches the rest from each project's own
# official source:
#   Node.js  (nodejs.org)         - only if your system doesn't have Node 20+
#   ffmpeg   (gyan.dev)           - only if ffmpeg isn't already on your PATH
#   uv       (astral.sh, GitHub)  - tiny tool that manages the Python side
#   Python venv + kokoro-onnx, soundfile, onnxruntime (PyPI)
#   Kokoro voice model (~340 MB, GitHub releases)
# Total download on a bare machine: roughly 700 MB. Re-runs are incremental.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot          # installer\ -> app root
$runtime = Join-Path $root 'runtime'
New-Item -ItemType Directory -Force $runtime | Out-Null
Set-Location $root

function Get-File($url, $dest) {
  Write-Host "  downloading $(Split-Path -Leaf $dest) ..." -ForegroundColor Cyan
  & curl.exe -L -sS -o $dest $url
  if ($LASTEXITCODE -ne 0) { throw "download failed: $url" }
}

Write-Host ""
Write-Host "DRAMATIS setup - fetching engines and models" -ForegroundColor Yellow
Write-Host "============================================"

# ---- Node.js (>= 20) -------------------------------------------------------
$nodeExe = 'node'
$nodeOk = $false
try {
  $v = (& node -v) 2>$null
  if ($v -match '^v(\d+)' -and [int]$Matches[1] -ge 20) { $nodeOk = $true }
} catch {}
$portableNode = Join-Path $runtime 'node\node.exe'
if (Test-Path $portableNode) { $nodeExe = $portableNode; $nodeOk = $true }
if ($nodeOk) {
  Write-Host "[1/5] Node.js: OK"
} else {
  Write-Host "[1/5] Node.js: not found - fetching a portable copy"
  $zip = Join-Path $runtime 'node.zip'
  Get-File 'https://nodejs.org/dist/v22.11.0/node-v22.11.0-win-x64.zip' $zip
  Expand-Archive -Path $zip -DestinationPath $runtime -Force
  Move-Item (Join-Path $runtime 'node-v22.11.0-win-x64') (Join-Path $runtime 'node') -Force
  Remove-Item $zip
  $nodeExe = $portableNode
}

# ---- ffmpeg ----------------------------------------------------------------
$ffmpegOk = $false
try { & ffmpeg -version *>$null; if ($LASTEXITCODE -eq 0) { $ffmpegOk = $true } } catch {}
if (Test-Path (Join-Path $runtime 'ffmpeg\bin\ffmpeg.exe')) { $ffmpegOk = $true }
if ($ffmpegOk) {
  Write-Host "[2/5] ffmpeg: OK"
} else {
  Write-Host "[2/5] ffmpeg: not found - fetching"
  $zip = Join-Path $runtime 'ffmpeg.zip'
  Get-File 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip' $zip
  Expand-Archive -Path $zip -DestinationPath $runtime -Force
  $inner = Get-ChildItem $runtime -Directory | Where-Object { $_.Name -like 'ffmpeg-*' } | Select-Object -First 1
  Move-Item $inner.FullName (Join-Path $runtime 'ffmpeg') -Force
  Remove-Item $zip
}

# ---- uv (manages the Python side, fetches Python 3.12 itself) --------------
$uvExe = 'uv'
$uvOk = $false
try { & uv --version *>$null; if ($LASTEXITCODE -eq 0) { $uvOk = $true } } catch {}
$portableUv = Join-Path $runtime 'uv.exe'
if (Test-Path $portableUv) { $uvExe = $portableUv; $uvOk = $true }
if ($uvOk) {
  Write-Host "[3/5] uv: OK"
} else {
  Write-Host "[3/5] uv: not found - fetching"
  $zip = Join-Path $runtime 'uv.zip'
  Get-File 'https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip' $zip
  Expand-Archive -Path $zip -DestinationPath $runtime -Force
  Remove-Item $zip
  $uvExe = $portableUv
}

# ---- Python venv + the Kokoro TTS stack ------------------------------------
$venvPython = Join-Path $root '.venv\Scripts\python.exe'
if (Test-Path $venvPython) {
  Write-Host "[4/5] Python voice stack: OK"
} else {
  Write-Host "[4/5] Python voice stack: setting up (uv fetches Python 3.12 itself)"
  & $uvExe venv --python 3.12 (Join-Path $root '.venv')
  if ($LASTEXITCODE -ne 0) { throw 'uv venv failed' }
  & $uvExe pip install --python $venvPython kokoro-onnx soundfile onnxruntime
  if ($LASTEXITCODE -ne 0) { throw 'pip install failed' }
}

# ---- Kokoro model weights (~340 MB) ----------------------------------------
Write-Host "[5/5] Voice model:"
& $nodeExe (Join-Path $root 'scripts\setup-models.mjs')
if ($LASTEXITCODE -ne 0) { throw 'model download failed' }

Set-Content (Join-Path $root '.bootstrap-done') (Get-Date -Format o)
Write-Host ""
Write-Host "Setup complete. Health check:" -ForegroundColor Yellow
$env:PATH = "$(Join-Path $runtime 'node');$(Join-Path $runtime 'ffmpeg\bin');$env:PATH"
& $nodeExe (Join-Path $root 'bin\dramatis.mjs') doctor
exit 0
