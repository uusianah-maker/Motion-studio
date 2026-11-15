# Motion Studio — watchdog: dijalankan Task Scheduler tiap 5 menit (task MotionStudio-Watchdog).
# Kalau server (port 4317) atau terowongan SSH mati DAN task penjaganya tidak sedang Running, task itu dinyalakan lagi.
# Penjaga (start-motion.ps1 / start-tunnel.ps1) sudah menyalakan ulang programnya sendiri; watchdog ini jaring pengaman
# kalau penjaganya sendiri ikut hilang (14 Nov 2026: dua kali dimatikan dari luar tanpa jejak).
# Hanya mencatat kalau bertindak: %LOCALAPPDATA%\MotionStudio\logs\penjaga-watchdog-YYYYMMDD.log
param([int]$Port = 4317)
$ErrorActionPreference = 'Continue'
$logDir = Join-Path $env:LOCALAPPDATA 'MotionStudio\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir ('penjaga-watchdog-' + (Get-Date -Format 'yyyyMMdd') + '.log')
function Catat([string]$t) {
    try {
        $fs = [IO.File]::Open($log, 'Append', 'Write', 'ReadWrite')
        $b = [Text.Encoding]::UTF8.GetBytes("[$(Get-Date -Format s)] $t`r`n"); $fs.Write($b, 0, $b.Length); $fs.Close()
    } catch { }
}
function Nyalakan([string]$task, [string]$alasan) {
    $t = Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
    if (-not $t) { Catat "$task tidak terdaftar ($alasan); jalankan install-autostart.ps1"; return }
    if ($t.State -eq 'Running') { Catat "$alasan, tapi $task masih Running (penjaga sedang menyalakan ulang)"; return }
    Start-ScheduledTask -TaskName $task
    Catat "$alasan -> $task dinyalakan lagi (status sebelumnya $($t.State))"
}

$serverHidup = [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
if (-not $serverHidup) { Nyalakan 'MotionStudio-Server' "port $Port kosong" }

$ssh = Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match 'motiontunnel@' }
if (-not $ssh) { Nyalakan 'MotionStudio-Tunnel' 'terowongan SSH tidak jalan' }

# PC-R3: jaga prioritas (penjaga yang sudah jalan memakai kode lama; ssh/node baru bisa lahir BelowNormal).
# Terowongan AboveNormal, server Normal. Hanya mencatat kalau mengubah.
function Prioritas([int]$ProcId, [string]$Mau, [string]$Nama) {
    try {
        $pr = Get-Process -Id $ProcId -ErrorAction Stop
        if ($pr.PriorityClass -ne $Mau) { $lama = $pr.PriorityClass; $pr.PriorityClass = $Mau; Catat "prioritas $Nama (pid $ProcId) $lama -> $Mau" }
    } catch { }
}
foreach ($s in @($ssh)) { if ($s) { Prioritas $s.ProcessId 'AboveNormal' 'terowongan' } }
$srv = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($srv) { Prioritas $srv.OwningProcess 'Normal' 'server' }
