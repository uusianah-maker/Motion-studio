# Motion Studio - backup mingguan workspace (R15).
#
# Yang dibackup:
#   1. SNAPSHOT data (kecil, +-20 MB): .motionstudio (registry, Brand Kit, riwayat, audit),
#      PROJECTS\<id>\03_PROJECT (timeline + undo), PROJECTS\<id>\06_ENGINE (rencana mesin).
#      Satu folder per minggu di <Tujuan>\snapshots\<tanggal>, disimpan -Simpan buah (default 8).
#   2. MEDIA ASLI (besar): SHARED_MEDIA, SHARED_ASSETS, PROJECTS\<id>\01_INPUT, 02_ASSETS
#      ke <Tujuan>\media. Hanya file BARU yang disalin (file media tidak pernah berubah),
#      dan tidak pernah ada yang dihapus dari backup.
#   3. (opsional, -DenganRender) hasil render PROJECTS\<id>\05_OUTPUT ke <Tujuan>\renders.
# Tidak dibackup: cache (04_CACHE, .motionstudio\visuals, analysis), .trash, "HASIL RENDER"
# (salinan 05_OUTPUT), BACKUP_PROJECTS.
#
# Aman saat server jalan: snapshot diambil DULU, baru media, jadi setiap media yang disebut
# registry di snapshot pasti ikut tersalin. File JSON ditulis atomik oleh server.
#
# Pemakaian:
#   powershell -ExecutionPolicy Bypass -File deploy\backup\backup-workspace.ps1 -Tujuan "E:\MotionBackup"
#   ... -DenganRender      ikut salin hasil render
#   ... -CekHash           cek SHA-256 setiap media di backup (lebih lama; default cek ukuran)
#   ... -TanpaMedia        hanya snapshot data kecil (mis. ke Google Drive); media di backup lain
#   ... -Coba              tampilkan rencana saja, tidak menyalin apa pun
param(
    [Parameter(Mandatory = $true)][string]$Tujuan,
    [string]$Workspace = 'D:\VIBECODING\Motion Studio Workspace',
    [int]$Simpan = 8,
    [switch]$DenganRender,
    [switch]$CekHash,
    [switch]$TanpaMedia,
    [switch]$Coba
)
$ErrorActionPreference = 'Stop'

function Robo([string]$src, [string]$dst, [string[]]$extra) {
    if (-not (Test-Path -LiteralPath $src)) { return }
    $ra = @($src, $dst, '/E', '/R:2', '/W:5', '/NP', '/NFL', '/NDL', '/NJH', '/NJS', '/MT:8') + $extra
    if ($Coba) { $ra += '/L' }
    & robocopy @ra | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy gagal (kode $LASTEXITCODE): $src -> $dst" }
}

$ws = (Resolve-Path -LiteralPath $Workspace).Path
if (-not (Test-Path -LiteralPath (Join-Path $ws '.motionstudio\registry.json'))) { throw "Bukan workspace Motion Studio: $ws" }
$dest = [IO.Path]::GetFullPath($Tujuan)
if ($dest.StartsWith($ws, [StringComparison]::OrdinalIgnoreCase)) { throw 'Tujuan backup tidak boleh di dalam workspace.' }
New-Item -ItemType Directory -Force -Path $dest, (Join-Path $dest 'snapshots'), (Join-Path $dest 'media'), (Join-Path $dest 'logs') | Out-Null

# Satu backup pada satu waktu.
$lockFile = Join-Path $dest 'backup.lock'
try { $lock = [IO.File]::Open($lockFile, 'OpenOrCreate', 'ReadWrite', 'None') } catch { throw 'Backup lain sedang berjalan ke tujuan ini.' }

$stamp = Get-Date -Format 'yyyy-MM-dd_HHmm'
$log = Join-Path $dest "logs\backup-$stamp.log"
function Log([string]$s) { $line = "[$(Get-Date -Format s)] $s"; Write-Host $line; if (-not $Coba) { Add-Content -LiteralPath $log -Value $line -Encoding UTF8 } }
$t0 = Get-Date
try {
    Log "Backup mulai: $ws -> $dest$(if ($Coba) { ' (COBA, tidak menyalin)' })"

    # 1. Snapshot data.
    $snap = Join-Path $dest "snapshots\$stamp"
    Robo (Join-Path $ws '.motionstudio') (Join-Path $snap '.motionstudio') @('/XD', 'visuals', 'analysis', '/XF', 'workspace.lock')
    Robo (Join-Path $ws 'PROJECTS') (Join-Path $snap 'PROJECTS') @('/XD', '01_INPUT', '02_ASSETS', '04_CACHE', '05_OUTPUT', '/XF', '*.mp4', '*.mov', '*.wav', '*.m4a', '*.mp3')
    Log "Snapshot data: snapshots\$stamp"

    if ($TanpaMedia) {
        $old = Get-ChildItem -LiteralPath (Join-Path $dest 'snapshots') -Directory | Sort-Object Name -Descending | Select-Object -Skip $Simpan
        foreach ($o in $old) { if (-not $Coba) { Remove-Item -LiteralPath $o.FullName -Recurse -Force; Log "Snapshot lama dihapus: $($o.Name)" } }
        Log ("Selesai (tanpa media) dalam {0:N0} dtk." -f ((Get-Date) - $t0).TotalSeconds)
        return
    }

    # 2. Media asli: hanya file baru (/XC /XN /XO = lewati yang sudah ada), tanpa menghapus.
    $addOnly = @('/XC', '/XN', '/XO')
    Robo (Join-Path $ws 'SHARED_MEDIA') (Join-Path $dest 'media\SHARED_MEDIA') $addOnly
    Robo (Join-Path $ws 'SHARED_ASSETS') (Join-Path $dest 'media\SHARED_ASSETS') $addOnly
    Robo (Join-Path $ws 'PROJECTS') (Join-Path $dest 'media\PROJECTS') ($addOnly + @('/XD', '03_PROJECT', '04_CACHE', '05_OUTPUT', '06_ENGINE'))
    if ($DenganRender) {
        Robo (Join-Path $ws 'PROJECTS') (Join-Path $dest 'renders\PROJECTS') ($addOnly + @('/XD', '01_INPUT', '02_ASSETS', '03_PROJECT', '04_CACHE', '06_ENGINE'))
    }
    Log 'Media asli disalin (hanya file baru).'
    if ($Coba) { Log 'COBA selesai.'; return }

    # 3. Verifikasi: setiap media aktif di registry snapshot ada di backup, ukurannya sama (dan hash kalau -CekHash).
    $reg = Get-Content -LiteralPath (Join-Path $snap '.motionstudio\registry.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $bad = @(); $n = 0; $bytes = 0
    foreach ($p in $reg.versions.PSObject.Properties) {
        $v = $p.Value
        if ($v.lifecycle -ne 'active') { continue }
        $n++; $bytes += [int64]$v.size
        $f = Join-Path $dest ('media\' + ($v.rel_path -replace '/', '\'))
        if (-not (Test-Path -LiteralPath $f)) { $bad += "HILANG $($v.rel_path)"; continue }
        if ((Get-Item -LiteralPath $f).Length -ne [int64]$v.size) { $bad += "UKURAN BEDA $($v.rel_path)"; continue }
        if ($CekHash) {
            $h = 'sha256:' + (Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash.ToLower()
            if ($h -ne $v.content_hash) { $bad += "HASH BEDA $($v.rel_path)" }
        }
    }
    if ($bad.Count) { $bad | ForEach-Object { Log $_ }; throw "Verifikasi GAGAL: $($bad.Count) dari $n media bermasalah." }
    Log ("Verifikasi OK: {0} media aktif ({1:N1} MB) ada di backup, {2}." -f $n, ($bytes / 1MB), $(if ($CekHash) { 'hash cocok' } else { 'ukuran cocok' }))

    # 4. Simpan hanya $Simpan snapshot terbaru.
    $old = Get-ChildItem -LiteralPath (Join-Path $dest 'snapshots') -Directory | Sort-Object Name -Descending | Select-Object -Skip $Simpan
    foreach ($o in $old) { Remove-Item -LiteralPath $o.FullName -Recurse -Force; Log "Snapshot lama dihapus: $($o.Name)" }

    $size = (Get-ChildItem -LiteralPath $dest -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
    Log ("Selesai dalam {0:N0} dtk. Total isi backup: {1:N1} MB." -f ((Get-Date) - $t0).TotalSeconds, ($size / 1MB))
}
catch {
    Log "GAGAL: $($_.Exception.Message)"
    exit 1
}
finally {
    $lock.Close(); Remove-Item -LiteralPath $lockFile -Force -ErrorAction SilentlyContinue
}
