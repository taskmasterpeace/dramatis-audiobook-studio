# Build the DRAMATIS Windows installer.
#   powershell -File installer\build-installer.ps1
# Stages ONLY git-tracked files (git archive), so local secrets, renders, models
# and venvs can never leak into the EXE. Needs Inno Setup 6:
#   winget install -e --id JRSoftware.InnoSetup
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$root = Split-Path -Parent $here

# stage tracked files only
$staging = Join-Path $here 'staging'
if (Test-Path $staging) { Remove-Item -Recurse -Force $staging }
New-Item -ItemType Directory -Force $staging | Out-Null
Push-Location $root
cmd /c "git archive HEAD | tar -x -C installer\staging"
if ($LASTEXITCODE -ne 0) { Pop-Location; throw 'git archive staging failed' }
Pop-Location
$count = (Get-ChildItem $staging -Recurse -File | Measure-Object).Count
Write-Host "staged $count tracked files"

# refuse to build if anything sensitive slipped in (belt and braces)
foreach ($bad in @('.env', 'out', '.venv', 'models', 'runtime')) {
  if (Test-Path (Join-Path $staging $bad)) { throw "staging contains '$bad' - aborting" }
}

# find ISCC
$iscc = @(
  "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
  "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
  "$env:ProgramFiles\Inno Setup 6\ISCC.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $iscc) { throw 'Inno Setup 6 not found. Install: winget install -e --id JRSoftware.InnoSetup' }

& $iscc (Join-Path $here 'dramatis-setup.iss')
if ($LASTEXITCODE -ne 0) { throw 'ISCC failed' }

$exe = Get-ChildItem (Join-Path $here 'Output') -Filter *.exe | Sort-Object LastWriteTime -Descending | Select-Object -First 1
Write-Host ""
Write-Host ("built {0}  ({1:N1} MB)" -f $exe.FullName, ($exe.Length / 1MB))

# a leftover staging tree is a full copy of the repo — node --test would discover
# its tests twice, and stale files would ship in the NEXT build
Remove-Item -Recurse -Force $staging
