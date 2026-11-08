# Motion Studio — jalankan server di PC owner dan nyalakan ulang otomatis kalau berhenti.
# Pengaturan dibaca dari .env.local di folder repo (lihat .env.example / deploy/README.md).
# Pemakaian:  powershell -ExecutionPolicy Bypass -File deploy\windows\start-motion.ps1
param(
    [string]$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
)
$ErrorActionPreference = 'Stop'
$main = Join-Path $Repo 'apps\server\dist\main.js'
if (-not (Test-Path $main)) { throw "Build belum ada. Jalankan 'npm run build' di $Repo dulu." }
$logDir = Join-Path $env:LOCALAPPDATA 'MotionStudio\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$delay = 5
while ($true) {
    $log = Join-Path $logDir ('server-' + (Get-Date -Format 'yyyyMMdd') + '.log')
    $started = Get-Date
    Add-Content -Path $log -Value "[$(Get-Date -Format s)] server mulai"
    & node $main *>> $log
    $code = $LASTEXITCODE
    # Jalan lama lalu berhenti = mulai lagi cepat; berhenti terus-menerus = jeda makin panjang (maks 5 menit).
    if (((Get-Date) - $started).TotalMinutes -gt 5) { $delay = 5 } else { $delay = [Math]::Min($delay * 2, 300) }
    Add-Content -Path $log -Value "[$(Get-Date -Format s)] server berhenti (kode $code), mulai ulang dalam $delay detik"
    Start-Sleep -Seconds $delay
}
