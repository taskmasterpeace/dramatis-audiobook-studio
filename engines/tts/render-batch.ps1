# DRAMATIS SAPI fallback TTS engine — batch renderer.
# Reads a JSON manifest [{text, voice, rate, pitch, out}] and synthesizes each
# entry to a WAV. Deterministic for identical inputs (content-addressed by caller).
param([Parameter(Mandatory=$true)][string]$Manifest)

Add-Type -AssemblyName System.Speech
$items = [System.IO.File]::ReadAllText($Manifest, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$done = 0

foreach ($it in $items) {
  $synth.SelectVoice($it.voice)
  $synth.Rate = [int]$it.rate
  $synth.SetOutputToWaveFile($it.out)
  if ($it.pitch -and $it.pitch -ne 'medium') {
    $escaped = [System.Security.SecurityElement]::Escape($it.text)
    $ssml = '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US"><prosody pitch="' + $it.pitch + '">' + $escaped + '</prosody></speak>'
    $synth.SpeakSsml($ssml)
  } else {
    $synth.Speak($it.text)
  }
  $synth.SetOutputToNull()
  $done++
  if ($done % 25 -eq 0) { Write-Output "synth $done/$($items.Count)" }
}
$synth.Dispose()
Write-Output "synth complete: $done items"
