# Motion Studio - pulihkan workspace dari backup (R15).
#
# Menyusun workspace utuh di folder -Target dari: media asli (<Backup>\media), snapshot data
# (<Backup>\snapshots\<nama>), dan render (<Backup>\renders) kalau -DenganRender.
# Lalu memeriksa setiap media di registry ada dan ukurannya cocok (hash kalau -CekHash).
#
# Langkah aman memulihkan workspace kerja:
#   1. Pulihkan ke folder BARU dulu, misalnya D:\MotionPulih (bukan menimpa workspace lama).
#   2. Cek hasilnya:  node packages\core\dist\cli\motion-storage.js dashboard D:\MotionPulih
#   3. Hentikan server (Stop-ScheduledTask MotionStudio-Server, kabari venus), ganti nama
#      folder workspace lama, ganti nama D:\MotionPulih jadi nama workspace, lalu Start lagi.
#
# Pemakaian:
#   powershell -ExecutionPolicy Bypass -File deploy\backup\restore-workspace.ps1 -Backup "E:\MotionBackup" -Target "D:\MotionPulih"
#   ... -Snapshot 2026-11-15_0200   pilih snapshot tertentu (default: terbaru)
#   ... -DenganRender               ikut pulihkan hasil render
#   ... -CekHash                    cek SHA-256 setiap media
param(
    [Parameter(Mandatory = $true)][string]$Backup,
    [Parameter(Mandatory = $true)][string]$Target,
    [string]$Snapshot = 'terbaru',
    [switch]$DenganRender,
    [switch]$CekHash
)
$ErrorActionPreference = 'Stop'

function Robo([string]$src, [string]$dst) {
    if (-not (Test-Path -LiteralPath $src)) { return }
    & robocopy $src $dst /E /R:2 /W:5 /NP /NFL /NDL /NJH /NJS /MT:8 | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy gagal (kode $LASTEXITCODE): $src -> $dst" }
}

$bk = (Resolve-Path -LiteralPath $Backup).Path
$snaps = Join-Path $bk 'snapshots'
if (-not (Test-Path -LiteralPath $snaps)) { throw "Bukan folder backup Motion Studio: $bk" }
if ($Snapshot -eq 'terbaru') {
    $Snapshot = (Get-ChildItem -LiteralPath $snaps -Directory | Sort-Object Name -Descending | Select-Object -First 1).Name
    if (-not $Snapshot) { throw 'Belum ada snapshot di backup ini.' }
}
$snap = Join-Path $snaps $Snapshot
if (-not (Test-Path -LiteralPath (Join-Path $snap '.motionstudio\registry.json'))) { throw "Snapshot tidak lengkap: $snap" }

$dst = [IO.Path]::GetFullPath($Target)
if (Test-Path -LiteralPath $dst) {
    if (Get-ChildItem -LiteralPath $dst -Force | Select-Object -First 1) {
        throw "Folder target tidak kosong: $dst. Pulihkan ke folder baru supaya workspace yang ada tidak tertimpa."
    }
}
New-Item -ItemType Directory -Force -Path $dst | Out-Null
$t0 = Get-Date
Write-Host "Memulihkan snapshot $Snapshot dari $bk ke $dst"

# Media dulu, lalu data (registry dll.) dari snapshot.
Robo (Join-Path $bk 'media') $dst
if ($DenganRender) { Robo (Join-Path $bk 'renders') $dst }
Robo $snap $dst

# Folder standar workspace yang kosong tidak ikut di backup.
foreach ($d in 'SHARED_MEDIA', 'SHARED_ASSETS', 'PROJECTS', 'BACKUP_PROJECTS', '.trash', '.motionstudio\journal') {
    New-Item -ItemType Directory -Force -Path (Join-Path $dst $d) | Out-Null
}
foreach ($p in Get-ChildItem -LiteralPath (Join-Path $dst 'PROJECTS') -Directory) {
    foreach ($d in '01_INPUT', '02_ASSETS', '03_PROJECT', '04_CACHE', '05_OUTPUT') { New-Item -ItemType Directory -Force -Path (Join-Path $p.FullName $d) | Out-Null }
}

# Media yang ada di backup tapi tidak lagi di registry snapshot (mis. snapshot lama) tidak masalah:
# dicatat sebagai file yatim oleh motion-storage, tidak dihapus.
$reg = Get-Content -LiteralPath (Join-Path $dst '.motionstudio\registry.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$bad = @(); $n = 0
foreach ($pp in $reg.versions.PSObject.Properties) {
    $v = $pp.Value
    if ($v.lifecycle -ne 'active') { continue }
    $n++
    $f = Join-Path $dst ($v.rel_path -replace '/', '\')
    if (-not (Test-Path -LiteralPath $f)) { $bad += "HILANG $($v.rel_path)"; continue }
    if ((Get-Item -LiteralPath $f).Length -ne [int64]$v.size) { $bad += "UKURAN BEDA $($v.rel_path)"; continue }
    if ($CekHash -and ('sha256:' + (Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash.ToLower()) -ne $v.content_hash) { $bad += "HASH BEDA $($v.rel_path)" }
}
if ($bad.Count) { $bad | ForEach-Object { Write-Host $_ }; Write-Host "PERINGATAN: $($bad.Count) dari $n media bermasalah."; exit 1 }
Write-Host ("Pulih OK dalam {0:N0} dtk: {1} media aktif cocok{2}. Cek dengan: node packages\core\dist\cli\motion-storage.js dashboard `"{3}`"" -f ((Get-Date) - $t0).TotalSeconds, $n, $(if ($CekHash) { ' (hash)' } else { ' (ukuran)' }), $dst)
