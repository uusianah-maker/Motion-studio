# Voice over dari teks pakai suara Windows OneCore (offline), mis. "Andika" untuk Bahasa Indonesia.
# Mode:
#   1) satu teks (lama):   powershell -File pipeline\tts_windows.ps1 -Teks "Halo" -Keluar a.wav [-Suara Andika] [-Kecepatan 1.0]
#   2) daftar suara:       powershell -File pipeline\tts_windows.ps1 -Daftar -Laporan suara.json
#   3) banyak kalimat:     powershell -File pipeline\tts_windows.ps1 -Masuk masuk.json -Laporan hasil.json
#      masuk.json (UTF-8): {"suara": "Andika", "kecepatan": 1.0, "item": [{"teks": "...", "keluar": "D:\\...\\01.wav"}]}
#      hasil.json: {"suara": "...", "item": [{"keluar", "byte", "kata": [{"mulai_ms", "akhir_ms", "awal", "akhir"}]}]}
#      kata = batas kata dari Windows (IncludeWordBoundaryMetadata); awal/akhir = posisi huruf di teks yang diucapkan.
param(
  [string]$Teks,
  [string]$Keluar,
  [string]$Suara = "Andika",
  [double]$Kecepatan = 1.0,
  [switch]$Daftar,
  [string]$Masuk,
  [string]$Laporan
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[void][Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]
[void][Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Tunggu($op, [Type]$tipe) {
  $as = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' }
  $t = $as[0].MakeGenericMethod($tipe).Invoke($null, @($op))
  $t.Wait(-1) | Out-Null
  $t.Result
}

function Tulis-Json($obj, $path) {
  [System.IO.File]::WriteAllText($path, (ConvertTo-Json $obj -Depth 8 -Compress), $utf8)
}

function Path-Penuh($p) {
  if ([System.IO.Path]::IsPathRooted($p)) { $p } else { Join-Path (Get-Location) $p }
}

if ($Daftar) {
  $v = @([Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices | ForEach-Object {
      @{ id = $_.Id; nama = $_.DisplayName; bahasa = $_.Language; gender = [string]$_.Gender } })
  if ($Laporan) { Tulis-Json @{ suara = $v } (Path-Penuh $Laporan) } else { ConvertTo-Json @{ suara = $v } -Depth 4 -Compress }
  exit 0
}

function Pilih-Suara($nama) {
  $voice = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices | Where-Object { $_.DisplayName -like "*$nama*" } | Select-Object -First 1
  if (-not $voice) { throw "Suara '$nama' tidak ditemukan" }
  $voice
}

function Ucapkan($synth, [string]$teks, [string]$keluar) {
  $stream = Tunggu ($synth.SynthesizeTextToStreamAsync($teks)) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
  $kata = @()
  foreach ($track in $stream.TimedMetadataTracks) {
    foreach ($cue in $track.Cues) {
      if ($cue.StartPositionInInput -ne $null) {
        $kata += @{ mulai_ms = [int]$cue.StartTime.TotalMilliseconds;
                    akhir_ms = [int]($cue.StartTime.TotalMilliseconds + $cue.Duration.TotalMilliseconds);
                    awal = [int]$cue.StartPositionInInput; akhir = [int]$cue.EndPositionInInput }
      }
    }
  }
  $reader = New-Object Windows.Storage.Streams.DataReader($stream.GetInputStreamAt(0))
  $n = [uint32]$stream.Size
  Tunggu ($reader.LoadAsync($n)) ([uint32]) | Out-Null
  $bytes = New-Object byte[] $n
  $reader.ReadBytes($bytes)
  $tujuan = Path-Penuh $keluar
  $dir = Split-Path -Parent $tujuan
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }
  [System.IO.File]::WriteAllBytes($tujuan, $bytes)
  @{ keluar = $keluar; byte = [int]$n; kata = @($kata) }
}

$synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
$synth.Options.IncludeWordBoundaryMetadata = $true

if ($Masuk) {
  $job = [System.IO.File]::ReadAllText((Path-Penuh $Masuk), $utf8) | ConvertFrom-Json
  $voice = Pilih-Suara ([string]$job.suara)
  $synth.Voice = $voice
  if ($job.kecepatan) { $synth.Options.SpeakingRate = [double]$job.kecepatan }
  $hasil = @()
  foreach ($it in $job.item) { $hasil += Ucapkan $synth ([string]$it.teks) ([string]$it.keluar) }
  Tulis-Json @{ suara = $voice.DisplayName; item = @($hasil) } (Path-Penuh $Laporan)
  "$($voice.DisplayName): $($hasil.Count) file"
  exit 0
}

if (-not $Teks -or -not $Keluar) { throw "pakai -Teks + -Keluar, -Masuk + -Laporan, atau -Daftar" }
$voice = Pilih-Suara $Suara
$synth.Voice = $voice
$synth.Options.SpeakingRate = $Kecepatan
$h = Ucapkan $synth $Teks $Keluar
"$($voice.DisplayName) -> $Keluar ($($h.byte) byte)"
