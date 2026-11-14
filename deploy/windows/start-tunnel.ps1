# Motion Studio — terowongan SSH terenkripsi dari PC owner ke VPS (PC-14). VPS hanya pintu:
#   https://domain → VPS 127.0.0.1:14317 → (SSH) → PC 127.0.0.1:4317
# Memakai OpenSSH bawaan Windows 10/11. Tersambung ulang otomatis kalau putus.
# Pemakaian:  powershell -ExecutionPolicy Bypass -File deploy\windows\start-tunnel.ps1 -Vps 203.0.113.10
param(
    [Parameter(Mandatory = $true)][string]$Vps,
    [string]$Key = (Join-Path $env:USERPROFILE '.ssh\motion_tunnel'),
    [int]$SshPort = 22,
    [int]$RemotePort = 14317,
    [int]$LocalPort = 4317
)
$ErrorActionPreference = 'Stop'
if ($Vps -notmatch '^[A-Za-z0-9.:-]+$') { throw "Alamat VPS tidak valid: $Vps" }
if (-not (Test-Path $Key)) { throw "Key SSH tidak ada: $Key (buat dengan ssh-keygen, lihat deploy/README.md)" }
$logDir = Join-Path $env:LOCALAPPDATA 'MotionStudio\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

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
$ssh = (Get-Command ssh -ErrorAction Stop).Source
# StrictHostKeyChecking=yes: sidik jari VPS harus sudah dikenal (sekali, manual) — mencegah VPS palsu.
$argSsh = @('-N', '-T', '-p', $SshPort, '-i', "`"$Key`"", '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3', '-o', 'StrictHostKeyChecking=yes', '-o', 'BatchMode=yes',
    '-R', "127.0.0.1:${RemotePort}:127.0.0.1:${LocalPort}", "motiontunnel@$Vps")
while ($true) {
    Bersihkan-Log $logDir
    $log = Join-Path $logDir ('penjaga-tunnel-' + (Get-Date -Format 'yyyyMMdd') + '.log')
    $jalan = Join-Path $logDir ("tunnel-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
    $code = $null
    try {
        $p = Start-Process -FilePath $ssh -ArgumentList $argSsh -NoNewWindow -PassThru `
            -RedirectStandardOutput "$jalan.out.log" -RedirectStandardError "$jalan.err.log"
        Tulis-Catatan $log "menyambung ke $Vps (pid $($p.Id))"
        $null = $p.Handle  # PowerShell 5.1: tanpa ini ExitCode kosong
        $p.WaitForExit()
        $code = $p.ExitCode
    } catch {
        Tulis-Catatan $log "ssh gagal dijalankan: $($_.Exception.Message)"
    }
    Tulis-Catatan $log "terputus (kode $code), sambung ulang dalam 10 detik"
    Start-Sleep -Seconds 10
}
