# Motion Studio — nyalakan server + terowongan otomatis setiap owner login ke Windows (Task Scheduler,
# hanya untuk user ini, tanpa hak admin). Dijalankan OWNER sekali; -Remove untuk mencabut lagi.
#   powershell -ExecutionPolicy Bypass -File deploy\windows\install-autostart.ps1 -Vps 203.0.113.10
#   powershell -ExecutionPolicy Bypass -File deploy\windows\install-autostart.ps1 -Remove
param(
    [string]$Vps,
    [switch]$Remove
)
$ErrorActionPreference = 'Stop'
$names = @('MotionStudio-Server', 'MotionStudio-Tunnel', 'MotionStudio-Watchdog')
if ($Remove) {
    foreach ($n in $names) { Unregister-ScheduledTask -TaskName $n -Confirm:$false -ErrorAction SilentlyContinue }
    Write-Output 'Autostart Motion Studio dicabut.'
    return
}
if (-not $Vps) { throw 'Isi -Vps <IP atau nama VPS>' }
$ps = (Get-Command powershell.exe).Source
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$server = New-ScheduledTaskAction -Execute $ps -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSScriptRoot\start-motion.ps1`""
$tunnel = New-ScheduledTaskAction -Execute $ps -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSScriptRoot\start-tunnel.ps1`" -Vps $Vps"
Register-ScheduledTask -TaskName $names[0] -Action $server -Trigger $trigger -Settings $settings -Description 'Motion Studio server (PC owner)' -Force | Out-Null
Register-ScheduledTask -TaskName $names[1] -Action $tunnel -Trigger $trigger -Settings $settings -Description 'Motion Studio terowongan SSH ke VPS' -Force | Out-Null
# Watchdog: tiap 5 menit menyalakan lagi server/terowongan kalau penjaganya ikut hilang (lihat watchdog.ps1).
$wdTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
$wdSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -MultipleInstances IgnoreNew
$wd = New-ScheduledTaskAction -Execute $ps -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSScriptRoot\watchdog.ps1`""
Register-ScheduledTask -TaskName $names[2] -Action $wd -Trigger @($wdTrigger, $trigger) -Settings $wdSettings -Description 'Motion Studio watchdog (tiap 5 menit)' -Force | Out-Null
Write-Output "Autostart dipasang: $($names -join ', '). Mulai sekarang tanpa logout: Start-ScheduledTask -TaskName MotionStudio-Server; Start-ScheduledTask -TaskName MotionStudio-Tunnel"
