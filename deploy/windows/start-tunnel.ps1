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

while ($true) {
    $log = Join-Path $logDir ('tunnel-' + (Get-Date -Format 'yyyyMMdd') + '.log')
    Add-Content -Path $log -Value "[$(Get-Date -Format s)] menyambung ke $Vps"
    # StrictHostKeyChecking=yes: sidik jari VPS harus sudah dikenal (sekali, manual) — mencegah VPS palsu.
    & ssh -N -T -p $SshPort -i $Key `
        -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 `
        -o StrictHostKeyChecking=yes -o BatchMode=yes `
        -R "127.0.0.1:${RemotePort}:127.0.0.1:${LocalPort}" "motiontunnel@$Vps" *>> $log
    Add-Content -Path $log -Value "[$(Get-Date -Format s)] terputus (kode $LASTEXITCODE), sambung ulang dalam 10 detik"
    Start-Sleep -Seconds 10
}
