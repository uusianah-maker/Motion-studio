# Motion Studio — jalankan server di PC owner dan nyalakan ulang otomatis kalau berhenti.
# Pengaturan dibaca dari .env.local di folder repo (lihat .env.example / deploy/README.md).
# Pemakaian:  powershell -ExecutionPolicy Bypass -File deploy\windows\start-motion.ps1
#
# Folder rilis (15 Nov 2026): server live TIDAK jalan dari folder kerja (build/WIP tim langsung tampil ke situs).
# Ia jalan dari rilis yang ditunjuk <Rilis>\AKTIF.txt (dibuat deploy\windows\rilis.ps1 dari satu commit).
# Penunjuk dibaca ulang setiap server mulai, jadi ganti rilis = tulis AKTIF.txt lalu mulai ulang server.
# Belum ada rilis (atau rilisnya rusak) = jalan dari folder kerja seperti dulu, dan dicatat di log.
# .env.local, workspace, state dir, dan port tetap sama: env diambil dari folder kerja (-EnvFile).
param(
    [string]$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
    [string]$Rilis = $(if ($env:MOTION_RELEASE_DIR) { $env:MOTION_RELEASE_DIR } else { 'D:\VIBECODING\Motion Studio Release' }),
    [string]$EnvFile = '',
    [string]$LogDir = (Join-Path $env:LOCALAPPDATA 'MotionStudio\logs')
)
$ErrorActionPreference = 'Stop'
if (-not $EnvFile) { $EnvFile = Join-Path $Repo '.env.local' }
$logDir = $LogDir
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

# Folder aplikasi yang dijalankan: rilis aktif kalau ada dan lengkap, selain itu folder kerja.
function Folder-Aplikasi {
    $penunjuk = Join-Path $Rilis 'AKTIF.txt'
    if (Test-Path $penunjuk) {
        $nama = ([IO.File]::ReadAllText($penunjuk)).Trim()
        if ($nama -match '^[A-Za-z0-9._-]+$') {
            $dir = Join-Path (Join-Path $Rilis 'rilis') $nama
            if ((Test-Path (Join-Path $dir 'apps\server\dist\main.js')) -and (Test-Path (Join-Path $dir 'apps\web\dist\index.html'))) {
                return @{ Dir = $dir; Ket = "rilis $nama" }
            }
            return @{ Dir = $Repo; Ket = "PERHATIAN: rilis '$nama' di AKTIF.txt tidak lengkap, jalan dari folder kerja" }
        }
        return @{ Dir = $Repo; Ket = 'PERHATIAN: AKTIF.txt tidak valid, jalan dari folder kerja' }
    }
    return @{ Dir = $Repo; Ket = 'folder kerja (belum ada rilis)' }
}

$delay = 5
# Catatan penjaga: baris pendek per kejadian. Ditulis dengan berbagi-akses + coba ulang, jadi tidak pernah
# menghentikan loop walaupun file sedang dibuka program lain (dulu `*>>` mengunci log sepanjang proses jalan).
function Tulis-Catatan([string]$Path, [string]$Teks) {
    for ($i = 0; $i -lt 5; $i++) {
        try {
            $fs = [IO.File]::Open($Path, 'Append', 'Write', 'ReadWrite')
            $b = [Text.Encoding]::UTF8.GetBytes("[$(Get-Date -Format s)] $Teks`r`n")
            $fs.Write($b, 0, $b.Length); $fs.Close(); return
        } catch { Start-Sleep -Milliseconds 200 }
    }
}
# Output program ke file sendiri per jalan (stdout + stderr terpisah) lewat Start-Process: PowerShell 5.1 tidak lagi
# mengubah stderr jadi error, dan tidak ada pengalihan yang mengunci file catatan. File lebih dari 7 hari dihapus.
function Bersihkan-Log([string]$Dir) {
    Get-ChildItem $Dir -File -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-7) } | Remove-Item -Force -ErrorAction SilentlyContinue
}

$ErrorActionPreference = 'Continue'
$node = (Get-Command node -ErrorAction Stop).Source
while ($true) {
    Bersihkan-Log $logDir
    $hari = Get-Date -Format 'yyyyMMdd'
    $log = Join-Path $logDir "penjaga-server-$hari.log"
    $jalan = Join-Path $logDir ("server-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
    $started = Get-Date
    $code = $null
    try {
        $app = Folder-Aplikasi
        $main = Join-Path $app.Dir 'apps\server\dist\main.js'
        if (-not (Test-Path $main)) { throw "Build belum ada di $($app.Dir) (npm run build / rilis.ps1)" }
        # main.js mencari .env.local relatif terhadap dirinya; di folder rilis tidak ada, jadi ditunjuk ke sini.
        $env:MOTION_ENV_FILE = $EnvFile
        $p = Start-Process -FilePath $node -ArgumentList "`"$main`"" -WorkingDirectory $app.Dir -NoNewWindow -PassThru `
            -RedirectStandardOutput "$jalan.out.log" -RedirectStandardError "$jalan.err.log"
        Tulis-Catatan $log "server mulai (pid $($p.Id); $($app.Ket); output: $(Split-Path -Leaf $jalan).*.log)"
        # PC-R3: task jalan di prioritas BelowNormal; saat CPU penuh oleh kerja lain di PC ini, server tertahan
        # belasan detik per permintaan. Normal = berbagi CPU adil (proses mesin anak ikut Normal).
        try { $p.PriorityClass = 'Normal' } catch { }
        $null = $p.Handle  # PowerShell 5.1: tanpa ini ExitCode kosong
        $p.WaitForExit()
        $code = $p.ExitCode
    } catch {
        Tulis-Catatan $log "server gagal dijalankan: $($_.Exception.Message)"
    }
    # Jalan lama lalu berhenti = mulai lagi cepat; berhenti terus-menerus = jeda makin panjang (maks 5 menit).
    if (((Get-Date) - $started).TotalMinutes -gt 5) { $delay = 5 } else { $delay = [Math]::Min($delay * 2, 300) }
    Tulis-Catatan $log "server berhenti (kode $code), mulai ulang dalam $delay detik"
    Start-Sleep -Seconds $delay
}
