# Buat voice over dari teks pakai suara Windows OneCore (offline), mis. "Andika" untuk Bahasa Indonesia.
# Pakai: powershell -File pipeline\tts_windows.ps1 -Teks "Halo" -Keluar public\tanaman\vo\00.wav [-Suara Andika] [-Kecepatan 1.0]
param(
  [Parameter(Mandatory = $true)][string]$Teks,
  [Parameter(Mandatory = $true)][string]$Keluar,
  [string]$Suara = "Andika",
  [double]$Kecepatan = 1.0
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[void][Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]
[void][Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]

function Tunggu($op, [Type]$tipe) {
  $as = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' }
  $t = $as[0].MakeGenericMethod($tipe).Invoke($null, @($op))
  $t.Wait(-1) | Out-Null
  $t.Result
}

$synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
$voice = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices | Where-Object { $_.DisplayName -like "*$Suara*" } | Select-Object -First 1
if (-not $voice) { throw "Suara '$Suara' tidak ditemukan" }
$synth.Voice = $voice
$synth.Options.SpeakingRate = $Kecepatan
$stream = Tunggu ($synth.SynthesizeTextToStreamAsync($Teks)) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
$reader = New-Object Windows.Storage.Streams.DataReader($stream.GetInputStreamAt(0))
$n = [uint32]$stream.Size
Tunggu ($reader.LoadAsync($n)) ([uint32]) | Out-Null
$bytes = New-Object byte[] $n
$reader.ReadBytes($bytes)
$dir = Split-Path -Parent $Keluar
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }
$tujuan = if ([System.IO.Path]::IsPathRooted($Keluar)) { $Keluar } else { Join-Path (Get-Location) $Keluar }
[System.IO.File]::WriteAllBytes($tujuan, $bytes)
"$($voice.DisplayName) -> $Keluar ($n byte)"
