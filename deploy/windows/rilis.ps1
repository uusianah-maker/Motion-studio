# Motion Studio - rilis untuk server live (motionproject.online), terpisah dari folder kerja tim.
#
# Kenapa: server live dulu melayani apps/web/dist di folder kerja, jadi setiap `npm run build` saat tes
# langsung mengganti tampilan situs (15 Nov 2026: menu R17 tampil ke owner padahal belum lulus audit).
# Sekarang server jalan dari salinan bersih satu commit di <Rilis>\rilis\<nama>, ditunjuk <Rilis>\AKTIF.txt
# (dibaca start-motion.ps1 setiap server mulai). Workspace, state dir, .env.local, dan port TIDAK berubah.
#
# Pemakaian (dari folder repo):
#   deploy\windows\rilis.ps1 -Commit <sha|main>           siapkan + build + smoke + aktifkan + restart (+- 1 menit)
#   deploy\windows\rilis.ps1 -Commit <sha> -TanpaGanti     siapkan + build + smoke saja (situs tidak berubah)
#   deploy\windows\rilis.ps1 -Aktifkan <nama>              aktifkan rilis yang sudah disiapkan
#   deploy\windows\rilis.ps1 -Kembali                      kembali ke rilis sebelumnya
#   deploy\windows\rilis.ps1 -Status                       lihat rilis aktif, sebelumnya, dan daftar rilis
# Restart hanya kalau tidak ada render/job mesin yang berjalan (lihat Cek-Sibuk); -Paksa melewati cek itu.
# Kalau server baru tidak sehat dalam 2 menit, otomatis kembali ke rilis sebelumnya.
#
# MESIN (-Mesin, semua perintah di atas sama): kode mesin dari satu commit remotion `master` di
# <Rilis>\mesin\<nama> (+ mesin\AKTIF.txt / SEBELUMNYA.txt). DATA mesin (konten/, public/, arsip/, .venv) TETAP di
# MOTION_ENGINE_ROOT (.env.local, folder kerja remotion) dan tidak disalin. start-motion.ps1 mengisi MOTION_ENGINE_CODE
# dari mesin\AKTIF.txt; app menjalankan mesin dengan cwd = DATA dan MOTION_ENGINE_DATA = DATA.
#   deploy\windows\rilis.ps1 -Mesin -Commit master -TanpaGanti     siapkan + smoke (engine cek, daftar_batch, generate uji)
#   deploy\windows\rilis.ps1 -Mesin -Aktifkan <nama> | -Kembali | -Status
param(
    [switch]$Mesin,
    [string]$RepoMesin = 'D:\VIBECODING\remotion',
    [string]$CabangMesin = 'master',
    [string]$DataMesin = '',
    [string]$LogPenjaga = (Join-Path $env:LOCALAPPDATA 'MotionStudio\logs'),
    [string]$SmokeSaja = '',
    [string]$Commit = '',
    [switch]$TanpaGanti,
    [string]$Aktifkan = '',
    [switch]$Kembali,
    [switch]$Status,
    [switch]$Paksa,
    [switch]$BukanMain,
    [string]$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
    [string]$Rilis = $(if ($env:MOTION_RELEASE_DIR) { $env:MOTION_RELEASE_DIR } else { 'D:\VIBECODING\Motion Studio Release' }),
    [string]$EnvFile = '',
    [string]$Workspace = '',
    [int]$Port = 4317,
    [int]$PortUji = 4398,
    [ValidateSet('Task', 'Proses')][string]$CaraRestart = 'Task',
    [string]$Task = 'MotionStudio-Server',
    [ValidateSet('Idle', 'BelowNormal', 'Normal')][string]$Prioritas = 'Idle',
    [int]$Simpan = 3,
    [switch]$SimpanNodeModules
)
$ErrorActionPreference = 'Stop'
if (-not $EnvFile) { $EnvFile = Join-Path $Repo '.env.local' }
if ($PortUji -eq 4317 -or $PortUji -eq $Port) { throw "PortUji $PortUji tidak boleh sama dengan port live" }
$dirLog = Join-Path $Rilis 'log'
if ($Mesin) {
    $dirRilis = Join-Path $Rilis 'mesin'
    $penunjuk = Join-Path $dirRilis 'AKTIF.txt'
    $penunjukLama = Join-Path $dirRilis 'SEBELUMNYA.txt'
    $logUtama = Join-Path $dirLog ('rilis-mesin-' + (Get-Date -Format 'yyyyMMdd') + '.log')
} else {
    $dirRilis = Join-Path $Rilis 'rilis'
    $penunjuk = Join-Path $Rilis 'AKTIF.txt'
    $penunjukLama = Join-Path $Rilis 'SEBELUMNYA.txt'
    $logUtama = Join-Path $dirLog ('rilis-' + (Get-Date -Format 'yyyyMMdd') + '.log')
}
New-Item -ItemType Directory -Force -Path $dirRilis, $dirLog | Out-Null
$POLA_NAMA = '^\d{8}-\d{6}_[A-Za-z0-9]+$'

function Catat([string]$t) {
    $baris = "[$(Get-Date -Format s)] $t"
    Write-Host $baris   # bukan Write-Output: itu ikut jadi nilai kembali fungsi (mis. nama rilis dari Siapkan)
    try { $fs = [IO.File]::Open($logUtama, 'Append', 'Write', 'ReadWrite'); $b = [Text.Encoding]::UTF8.GetBytes("$baris`r`n"); $fs.Write($b, 0, $b.Length); $fs.Close() } catch { }
}
function Baca([string]$f) { if (Test-Path $f) { ([IO.File]::ReadAllText($f)).Trim() } else { '' } }
function Tulis([string]$f, [string]$isi) { [IO.File]::WriteAllText($f, $isi, (New-Object Text.UTF8Encoding $false)) }
function DirRilis([string]$nama) { Join-Path $dirRilis $nama }
function Lengkap([string]$dir) {
    if ($Mesin) { return (Test-Path (Join-Path $dir 'pipeline\engine.py')) -and (Test-Path (Join-Path $dir 'pipeline\batch\jalur.py')) }
    (Test-Path (Join-Path $dir 'apps\server\dist\main.js')) -and (Test-Path (Join-Path $dir 'apps\web\dist\index.html')) -and (Test-Path (Join-Path $dir 'packages\core\dist\index.js'))
}
function Daftar-Rilis { Get-ChildItem $dirRilis -Directory | Where-Object { $_.Name -match $POLA_NAMA } | Sort-Object Name -Descending }
# Folder app yang sedang aktif (dipakai mode -Mesin: server harus tetap jalan dari rilis app yang sama).
function Dir-AppAktif {
    $n = Baca (Join-Path $Rilis 'AKTIF.txt')
    if ($n -and (Test-Path (Join-Path $Rilis "rilis\$n\apps\server\dist\main.js"))) { return (Join-Path $Rilis "rilis\$n") }
    return $Repo
}
function Label-Mesin([string]$nama) { if ($nama) { "mesin $nama" } else { 'mesin folder kerja' } }
# Baris "server mulai (pid N; ...)" terakhir untuk pid ini di log penjaga (hari ini / kemarin).
function Baris-Penjaga([int]$procId) {
    $baris = $null
    foreach ($h in (Get-Date).AddDays(-1), (Get-Date)) {
        $f = Join-Path $LogPenjaga ('penjaga-server-' + $h.ToString('yyyyMMdd') + '.log')
        if (Test-Path $f) { foreach ($b in [IO.File]::ReadAllLines($f)) { if ($b -match "server mulai \(pid $procId;") { $baris = $b } } }
    }
    return $baris
}

# ---------------------------------------------------------------- status
function Tampil-Status {
    $a = Baca $penunjuk; $s = Baca $penunjukLama
    Write-Output "Folder rilis : $dirRilis$(if ($Mesin) { ' (MESIN)' })"
    Write-Output "Aktif        : $(if ($a) { $a } else { '(belum ada - jalan dari folder kerja)' })"
    Write-Output "Sebelumnya   : $(if ($s) { $s } else { '-' })"
    Daftar-Rilis | ForEach-Object {
        $info = Join-Path $_.FullName 'RILIS.json'
        $ket = if (Test-Path $info) { $j = Get-Content $info -Raw | ConvertFrom-Json; "$($j.commit_pendek) $($j.judul)" } else { '(tanpa RILIS.json)' }
        $tanda = if ($_.Name -eq $a) { '*' } elseif ($_.Name -eq $s) { '<' } else { ' ' }
        Write-Output (" $tanda $($_.Name)  $ket")
    }
    $srv = Pid-Server
    if ($srv) {
        Write-Output "Server port $Port : pid $($srv.Pid) $($srv.Cmd)"
        $b = Baris-Penjaga $srv.Pid
        if ($b) { Write-Output "Log penjaga   : $b" }
    } else { Write-Output "Server port $Port : tidak jalan" }
}

# ---------------------------------------------------------------- server live
function Pid-Server {
    $l = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $l) { return $null }
    $w = Get-CimInstance Win32_Process -Filter "ProcessId=$($l.OwningProcess)" -ErrorAction SilentlyContinue
    if (-not $w) { return $null }
    return @{ Pid = [int]$l.OwningProcess; Cmd = [string]$w.CommandLine; Motion = ([string]$w.CommandLine -match 'apps\\server\\dist\\main\.js') }
}
function Sehat([int]$p) {
    try { $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 "http://127.0.0.1:$p/api/health"; return ($r.StatusCode -eq 200 -and $r.Content -match '"ok"\s*:\s*true') } catch { return $false }
}
# Tunggu server live sehat DAN jalan dari folder app yang diharapkan. -Mesin: juga proses BARU (bukan $pidLama) yang
# menurut log penjaga dinyalakan dengan label mesin yang diharapkan (env proses lain tidak bisa dibaca dari luar).
function Tunggu-Sehat([string]$dir, [int]$detik, [int]$pidLama = 0, [string]$labelMesin = '') {
    $batas = (Get-Date).AddSeconds($detik)
    $harap = (Join-Path $dir 'apps\server\dist\main.js').ToLowerInvariant()
    while ((Get-Date) -lt $batas) {
        $s = Pid-Server
        if ($s -and $s.Cmd.ToLowerInvariant().Contains($harap) -and (Sehat $Port)) {
            if (-not $labelMesin) { return $s }
            if ($s.Pid -ne $pidLama) {
                $b = Baris-Penjaga $s.Pid
                if ($b -and $b.Contains("; $labelMesin;")) { return $s }
            }
        }
        Start-Sleep -Seconds 2
    }
    return $null
}
function Tunggu-PortKosong([int]$detik) {
    $batas = (Get-Date).AddSeconds($detik)
    while ((Get-Date) -lt $batas) { if (-not (Pid-Server)) { return $true }; Start-Sleep -Milliseconds 500 }
    return $false
}
# Mulai ulang server live. Task: Stop/Start task penjaga (aturan tim). Proses: hentikan node di port ini saja,
# penjaga yang sedang jalan menyalakannya lagi dari AKTIF.txt (dipakai untuk uji dengan penjaga uji).
function Mulai-Ulang {
    if ($CaraRestart -eq 'Task') {
        $t = Get-ScheduledTask -TaskName $Task -ErrorAction Stop
        Catat "stop task $Task (status $($t.State))"
        Stop-ScheduledTask -TaskName $Task
        if (-not (Tunggu-PortKosong 20)) {
            $s = Pid-Server
            if ($s -and $s.Motion) { Catat "node lama (pid $($s.Pid)) masih memegang port $Port, dihentikan"; Stop-Process -Id $s.Pid -Force; [void](Tunggu-PortKosong 15) }
            elseif ($s) { throw "Port $Port dipegang program lain (pid $($s.Pid)); tidak disentuh" }
        }
        Start-ScheduledTask -TaskName $Task
        Catat "start task $Task"
    } else {
        $s = Pid-Server
        if ($s -and -not $s.Motion) { throw "Port $Port dipegang program lain (pid $($s.Pid)); tidak disentuh" }
        if ($s) { Catat "hentikan server (pid $($s.Pid)); penjaga menyalakan lagi"; Stop-Process -Id $s.Pid -Force }
    }
}

# ---------------------------------------------------------------- cek sibuk
function Folder-Workspace {
    if ($Workspace) { return $Workspace }
    if (Test-Path $EnvFile) {
        foreach ($b in Get-Content $EnvFile) { if ($b -match '^\s*MOTION_WORKSPACE\s*=\s*(.+?)\s*$') { return $Matches[1].Trim('"') } }
    }
    throw "MOTION_WORKSPACE tidak ditemukan di $EnvFile (isi -Workspace)"
}
# Sibuk = ada lease (render/mesin) ATAU status job mesin berjalan/menunggu yang masih baru.
function Cek-Sibuk {
    $ws = Folder-Workspace
    $alasan = @()
    $lf = Join-Path $ws '.motionstudio\leases.json'
    if (Test-Path $lf) {
        $l = (Get-Content $lf -Raw | ConvertFrom-Json).leases
        foreach ($x in @($l)) { if ($x) { $alasan += "lease $($x.status) $($x.job) '$($x.label)' ($($x.lease_id))" } }
    }
    $kini = Get-Date
    Get-ChildItem (Join-Path $ws 'PROJECTS') -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        Get-ChildItem (Join-Path $_.FullName '06_ENGINE') -Directory -ErrorAction SilentlyContinue | ForEach-Object {
            $f = Join-Path $_.FullName 'status.json'
            if (Test-Path $f) {
                $it = Get-Item $f
                $umur = ($kini - $it.LastWriteTime).TotalMinutes
                try { $st = (Get-Content $f -Raw | ConvertFrom-Json) } catch { return }
                if (($st.state -eq 'berjalan' -and $umur -lt 30) -or ($st.state -eq 'menunggu' -and $umur -lt 120)) {
                    $alasan += "job mesin $($st.job_id) ($($st.mode), $($st.state), $([int]$st.persen)%) proyek $($st.project_id)"
                }
            }
        }
    }
    return $alasan
}

# ---------------------------------------------------------------- aktifkan
function Aktifkan-Rilis([string]$nama, [switch]$Mundur) {
    $dir = DirRilis $nama
    if (-not (Lengkap $dir)) { throw "Rilis $nama tidak ada atau tidak lengkap ($dir)" }
    $lama = Baca $penunjuk
    if ($lama -eq $nama -and -not $Mundur) { Catat "rilis $nama sudah aktif"; }
    $sibuk = @(Cek-Sibuk)
    if ($sibuk.Count) {
        if (-not $Paksa) { Catat "BATAL: server sedang bekerja:"; $sibuk | ForEach-Object { Catat "  - $_" }; Catat 'coba lagi nanti (atau -Paksa)'; exit 3 }
        Catat "PERINGATAN -Paksa: restart walau ada $($sibuk.Count) pekerjaan berjalan"
    }
    $lamaSebelumnya = Baca $penunjukLama
    $pidLama = 0; $sv = Pid-Server; if ($sv) { $pidLama = $sv.Pid }
    Tulis $penunjukLama $lama
    Tulis $penunjuk $nama
    Catat "$(if ($Mesin) { 'mesin\' })AKTIF.txt: '$lama' -> '$nama'"
    $t0 = Get-Date
    Mulai-Ulang
    # App: server harus jalan dari folder rilis baru. Mesin: dari rilis app yang sama, proses baru, label mesin baru.
    $s = if ($Mesin) { Tunggu-Sehat (Dir-AppAktif) 120 $pidLama (Label-Mesin $nama) } else { Tunggu-Sehat $dir 120 }
    if ($s) { Catat "SELESAI: server sehat dari rilis $(if ($Mesin) { 'mesin ' })$nama (pid $($s.Pid)) dalam $([int]((Get-Date) - $t0).TotalSeconds) dtk"; return $true }

    Catat "GAGAL: server tidak sehat dari rilis $nama dalam 2 menit -> kembali ke '$lama'"
    if ($lama) { Tulis $penunjuk $lama } else { Remove-Item $penunjuk -Force }
    Tulis $penunjukLama $lamaSebelumnya   # rilis gagal tidak boleh jadi tujuan -Kembali
    $pidGagal = 0; $sv = Pid-Server; if ($sv) { $pidGagal = $sv.Pid }
    Mulai-Ulang
    $dirLama = if ($lama) { DirRilis $lama } else { $Repo }
    $s = if ($Mesin) { Tunggu-Sehat (Dir-AppAktif) 120 $pidGagal (Label-Mesin $lama) } else { Tunggu-Sehat $dirLama 120 }
    if ($s) { Catat "rollback berhasil: server sehat dari '$(if ($lama) { $lama } else { 'folder kerja' })' (pid $($s.Pid))" }
    else { Catat 'ROLLBACK JUGA GAGAL: cek log penjaga di %LOCALAPPDATA%\MotionStudio\logs dan lapor ke venus' }
    exit 4
}

# ---------------------------------------------------------------- siapkan
function Jalankan([string]$exe, [string[]]$argumen, [string]$dir, [string]$nama) {
    $out = Join-Path $dirLog "$nama.out.log"; $err = Join-Path $dirLog "$nama.err.log"
    $p = Start-Process -FilePath $exe -ArgumentList $argumen -WorkingDirectory $dir -NoNewWindow -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
    try { $p.PriorityClass = $Prioritas } catch { }   # anak proses (tsc, vite) ikut prioritas ini
    $null = $p.Handle
    $p.WaitForExit()
    if ($p.ExitCode -ne 0) { throw "$nama gagal (kode $($p.ExitCode)); lihat $err" }
}

# Smoke: jalankan rilis baru di PortUji dengan workspace + state dir sementara (BUKAN workspace live:
# server kedua di workspace live akan ikut recovery/GC dan menutup job yang sedang jalan).
function Smoke([string]$dir, [string]$nama) {
    $node = (Get-Command node -ErrorAction Stop).Source
    $tmp = Join-Path ([IO.Path]::GetTempPath()) "motion-smoke-$nama"
    if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
    New-Item -ItemType Directory -Force -Path (Join-Path $tmp 'state'), (Join-Path $tmp 'tmp') | Out-Null
    $ws = Join-Path $tmp 'ws'
    Luar $node (Join-Path $dir 'packages\core\dist\cli\motion-storage.js') init $ws | Out-Null
    if ($script:kodeLuar -ne 0) { throw 'smoke: init workspace uji gagal' }
    if (Get-NetTCPConnection -LocalPort $PortUji -State Listen -ErrorAction SilentlyContinue) { throw "smoke: port uji $PortUji sedang dipakai" }

    # Env proses ini saja: buang semua MOTION_* (jangan sampai rahasia/workspace live terbawa), isi nilai uji.
    $simpan = @{}
    Get-ChildItem env: | Where-Object Name -like 'MOTION_*' | ForEach-Object { $simpan[$_.Name] = $_.Value; Remove-Item "env:$($_.Name)" }
    $env:MOTION_WORKSPACE = $ws; $env:MOTION_PORT = "$PortUji"; $env:MOTION_GC = 'off'
    $env:MOTION_STATE_DIR = Join-Path $tmp 'state'; $env:MOTION_UPLOAD_TMP = Join-Path $tmp 'tmp'; $env:MOTION_RENDER_TMP = Join-Path $tmp 'tmp'
    $env:MOTION_ENV_FILE = Join-Path $tmp 'tidak-ada.env'
    $out = Join-Path $dirLog "$nama.smoke.out.log"; $err = Join-Path $dirLog "$nama.smoke.err.log"
    try {
        $p = Start-Process -FilePath $node -ArgumentList "`"$(Join-Path $dir 'apps\server\dist\main.js')`"" -WorkingDirectory $dir -NoNewWindow -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
    } finally {
        Get-ChildItem env: | Where-Object Name -like 'MOTION_*' | ForEach-Object { Remove-Item "env:$($_.Name)" }
        foreach ($k in $simpan.Keys) { Set-Item "env:$k" $simpan[$k] }
    }
    $hasil = @()
    try {
        $batas = (Get-Date).AddSeconds(45); $token = $null
        while ((Get-Date) -lt $batas -and -not $token) {
            if ($p.HasExited) { throw "smoke: server uji berhenti (kode $($p.ExitCode)); lihat $err" }
            if (Test-Path $out) { $m = [regex]::Match((Get-Content $out -Raw -ErrorAction SilentlyContinue) + '', '#token=([0-9a-f]{64})'); if ($m.Success) { $token = $m.Groups[1].Value } }
            if (-not $token) { Start-Sleep -Milliseconds 500 }
        }
        if (-not $token) { throw 'smoke: server uji tidak siap dalam 45 dtk' }
        $u = "http://127.0.0.1:$PortUji"
        if (-not (Sehat $PortUji)) { throw 'smoke: /api/health gagal' }
        $hasil += 'health ok'
        $html = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 "$u/").Content
        $asli = [IO.File]::ReadAllText((Join-Path $dir 'apps\web\dist\index.html'))
        if ($html -ne $asli) { throw 'smoke: halaman / bukan index.html rilis ini' }
        $aset = [regex]::Matches($html, '(?:src|href)="(/assets/[^"]+)"') | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique
        if (-not $aset) { throw 'smoke: index.html tanpa /assets/' }
        foreach ($a in $aset) { $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 "$u$a"; if ($r.StatusCode -ne 200 -or $r.RawContentLength -lt 1) { throw "smoke: aset $a gagal" } }
        $hasil += "web ok ($(@($aset).Count) aset)"
        $h = @{ Authorization = "Bearer $token" }
        foreach ($api in '/api/session', '/api/projects', '/api/engine') {
            $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 -Headers $h "$u$api"
            if ($r.StatusCode -ne 200) { throw "smoke: $api kode $($r.StatusCode)" }
        }
        $hasil += 'api ok (/api/session, /api/projects, /api/engine)'
        try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 "$u/api/projects" | Out-Null; throw 'smoke: /api/projects tanpa token tidak ditolak' } catch { if ($_.Exception.Message -like 'smoke:*') { throw } }
        $hasil += 'tanpa token ditolak'
    } finally {
        if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue; $p.WaitForExit(10000) | Out-Null }
        Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
    return ($hasil -join '; ')
}

# Program luar (git, tar, node): PowerShell 5.1 + ErrorAction Stop menganggap tulisan stderr (mis. peringatan
# git "commit-graph") sebagai error fatal. Di sini stderr dibuang dan yang dinilai hanya kode keluar.
# Sengaja tanpa param: dengan param bernama, argumen seperti `-e` (git cat-file -e) diikat PowerShell ke param itu.
function Luar {
    $exe = $args[0]; $sisa = @($args | Select-Object -Skip 1)
    $lama = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try { $o = & $exe @sisa 2>$null; $script:kodeLuar = $LASTEXITCODE; return $o } finally { $ErrorActionPreference = $lama }
}

# Remove-Item -Recurse sering gagal diam-diam pada node_modules (path panjang / file read-only); rmdir lebih andal.
function Hapus-Folder([string]$dir) {
    if (-not (Test-Path $dir)) { return }
    Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path $dir) { cmd.exe /d /c "rmdir /s /q `"$dir`"" 2>$null | Out-Null }
    if (Test-Path $dir) { Catat "PERINGATAN: folder belum terhapus: $dir" }
}

function Siapkan([string]$ref) {
    $git = (Get-Command git -ErrorAction Stop).Source
    $sha = Luar $git -C $Repo rev-parse --verify "$ref^{commit}"
    if ($script:kodeLuar -ne 0 -or -not $sha) { throw "Commit tidak ditemukan: $ref" }
    $sha = "$sha".Trim()
    Luar $git -C $Repo merge-base --is-ancestor $sha main | Out-Null
    if ($script:kodeLuar -ne 0) {
        if (-not $BukanMain) { throw "Commit $sha bukan bagian dari main (rilis hanya dari main yang lulus audit; -BukanMain untuk uji)" }
        Catat "PERINGATAN: $sha bukan bagian dari main (-BukanMain)"
    }
    # Riwayat main juga berisi commit mesin (git subtree engine/): isinya repo remotion, bukan Motion Studio.
    # Cek dulu sebelum npm ci, supaya tidak memasang/menjalankan skrip build dari repo lain.
    foreach ($wajib in 'package.json', 'package-lock.json', 'apps/server/src/main.ts', 'apps/web/index.html', 'packages/core/src/index.ts') {
        Luar $git -C $Repo cat-file -e "${sha}:$wajib" | Out-Null
        if ($script:kodeLuar -ne 0) { throw "Commit $($sha.Substring(0, 7)) bukan commit Motion Studio yang bisa dirilis (tidak ada $wajib)" }
    }
    $judul = "$(Luar $git -C $Repo log -1 --format=%s $sha)".Trim()
    $nama = (Get-Date -Format 'yyyyMMdd-HHmmss') + '_' + $sha.Substring(0, 7)
    $staging = Join-Path $dirRilis ".baru-$nama"
    Catat "siapkan rilis $nama dari $sha ($judul)"
    $t0 = Get-Date
    try {
        New-Item -ItemType Directory -Force -Path $staging | Out-Null
        # Salinan bersih isi commit (tanpa WIP, tanpa file yang tidak di-commit, tanpa .env.local).
        $tar = Join-Path $dirLog "$nama.tar"
        Luar $git -C $Repo archive --format=tar -o $tar $sha | Out-Null
        if ($script:kodeLuar -ne 0) { throw 'git archive gagal' }
        Luar tar.exe -xf $tar -C $staging | Out-Null
        if ($script:kodeLuar -ne 0) { throw 'ekstrak tar gagal' }
        Remove-Item $tar -Force
        Catat "  salinan commit siap ($([int]((Get-Date) - $t0).TotalSeconds) dtk); npm ci (prioritas $Prioritas)"
        $npm = (Get-Command npm.cmd -ErrorAction Stop).Source
        Jalankan $npm @('ci', '--prefer-offline', '--no-audit', '--no-fund') $staging "$nama.npm-ci"
        Catat "  npm ci selesai ($([int]((Get-Date) - $t0).TotalSeconds) dtk); build"
        Jalankan $npm @('run', 'build') $staging "$nama.build"
        if (-not (Lengkap $staging)) { throw 'build tidak menghasilkan server/web/core dist' }
        Catat "  build selesai ($([int]((Get-Date) - $t0).TotalSeconds) dtk); smoke di port $PortUji"
        $smoke = Smoke $staging $nama
        Catat "  smoke lulus: $smoke"
        if (-not $SimpanNodeModules) { Hapus-Folder (Join-Path $staging 'node_modules') }  # server tidak butuh node_modules saat jalan
        $info = [ordered]@{ nama = $nama; commit = $sha; commit_pendek = $sha.Substring(0, 7); judul = $judul; dibuat = (Get-Date -Format s); smoke = $smoke; node = "$(Luar node -v)".Trim() }
        Tulis (Join-Path $staging 'RILIS.json') ($info | ConvertTo-Json)
        Rename-Item $staging $nama
        Catat "rilis $nama siap ($([int]((Get-Date) - $t0).TotalSeconds) dtk)"
        return $nama
    } catch {
        Catat "GAGAL menyiapkan rilis: $($_.Exception.Message) (situs tidak berubah)"
        Hapus-Folder $staging
        exit 2
    }
}

# ---------------------------------------------------------------- mesin
function Folder-DataMesin {
    if ($DataMesin) { return $DataMesin }
    if (Test-Path $EnvFile) {
        foreach ($b in Get-Content $EnvFile) { if ($b -match '^\s*MOTION_ENGINE_ROOT\s*=\s*(.+?)\s*$') { return $Matches[1].Trim('"') } }
    }
    throw "MOTION_ENGINE_ROOT tidak ditemukan di $EnvFile (isi -DataMesin)"
}

# Jalankan engine.py dari folder kode $kode seperti app menjalankannya: cwd = DATA, env hanya daftar putih
# engineEnv() + MOTION_ENGINE_DATA + MOTION_STUDIO_CORE (rilis app aktif). Return @{Kode; Out; Err}.
function Mesin-Jalan([string]$kode, [string]$data, [string]$label, [string[]]$argumen) {
    $py = Join-Path $data '.venv\Scripts\python.exe'
    if (-not (Test-Path $py)) { throw "Python mesin tidak ada: $py" }
    $out = Join-Path $dirLog "$label.out.log"; $err = Join-Path $dirLog "$label.err.log"
    $putih = '^(PATH|PATHEXT|SYSTEMROOT|SYSTEMDRIVE|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|OS|LANG|LC_ALL|CUDA_VISIBLE_DEVICES|PYTHON[A-Z_]*|VIRTUAL_ENV|HF_HOME|XDG_CACHE_HOME)$'
    # Env proses ini diganti sementara (Start-Process mewarisinya), lalu dikembalikan persis. Lewat .NET, bukan env:\,
    # supaya nama yang hilang di tengah jalan tidak menghentikan skrip.
    $simpan = [Environment]::GetEnvironmentVariables('Process')
    $core = Join-Path (Dir-AppAktif) 'packages\core\dist'
    $arg = @("`"$(Join-Path $kode 'pipeline\engine.py')`"") + ($argumen | ForEach-Object { "`"$_`"" })
    try {
        foreach ($k in @($simpan.Keys)) { if ($k -notmatch $putih) { [Environment]::SetEnvironmentVariable($k, $null, 'Process') } }
        [Environment]::SetEnvironmentVariable('PYTHONIOENCODING', 'utf-8', 'Process')
        [Environment]::SetEnvironmentVariable('PYTHONUTF8', '1', 'Process')
        [Environment]::SetEnvironmentVariable('MOTION_ENGINE_DATA', $data, 'Process')
        [Environment]::SetEnvironmentVariable('MOTION_STUDIO_CORE', $core, 'Process')
        $p = Start-Process -FilePath $py -ArgumentList $arg -WorkingDirectory $data -NoNewWindow -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
    } finally {
        foreach ($k in @([Environment]::GetEnvironmentVariables('Process').Keys)) { if (-not $simpan.Contains($k)) { [Environment]::SetEnvironmentVariable($k, $null, 'Process') } }
        foreach ($k in @($simpan.Keys)) { [Environment]::SetEnvironmentVariable($k, [string]$simpan[$k], 'Process') }
    }
    try { $p.PriorityClass = $Prioritas } catch { }
    $null = $p.Handle
    if (-not $p.WaitForExit(15 * 60 * 1000)) { Stop-Process -Id $p.Id -Force; throw "smoke mesin: $label lebih dari 15 menit" }
    return @{ Kode = $p.ExitCode; Out = [IO.File]::ReadAllText($out); Err = $err }
}

# Bahan uji generate (sekali, disimpan di <Rilis>\uji): video 9:16 +- 17 dtk = pola warna + suara TTS Windows, dan
# brand_kit.json dari job generate terbaru di workspace (dibaca saja). Bukan footage owner.
function Bahan-Uji {
    $dir = Join-Path $Rilis 'uji'
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $video = Join-Path $dir 'generate-uji.mp4'
    if (-not (Test-Path $video)) {
        $wav = Join-Path $dir 'generate-uji.wav'
        Add-Type -AssemblyName System.Speech
        $sp = New-Object System.Speech.Synthesis.SpeechSynthesizer
        try {
            $sp.SetOutputToWaveFile($wav)
            $sp.Speak('Halo kak, ini celana kulot Aysilla. Bahannya adem, jatuh, dan tidak menerawang. Ada lima warna, ukurannya sampai triple X L. Klik keranjang kuning sekarang ya kak, stok terbatas.')
        } finally { $sp.Dispose() }
        $ff = (Get-Command ffmpeg -ErrorAction Stop).Source
        # Semua argumen dikutip: tanpa kutip, PowerShell membaca `-c:v` sebagai parameter -c bernilai v.
        Luar $ff '-v' 'error' '-y' '-f' 'lavfi' '-i' 'testsrc2=s=1080x1920:r=30' '-i' $wav '-shortest' '-c:v' 'libx264' '-preset' 'veryfast' '-pix_fmt' 'yuv420p' '-c:a' 'aac' $video | Out-Null
        Remove-Item $wav -Force -ErrorAction SilentlyContinue
        if ($script:kodeLuar -ne 0 -or -not (Test-Path $video)) { throw 'smoke mesin: video uji gagal dibuat' }
    }
    $bk = Join-Path $dir 'brand_kit.json'
    if (-not (Test-Path $bk)) {
        $ws = Folder-Workspace
        $job = Get-ChildItem (Join-Path $ws 'PROJECTS\*\06_ENGINE\*\job.json') -ErrorAction SilentlyContinue |
            Where-Object { (Get-Content $_.FullName -Raw) -match '"mode"\s*:\s*"generate"' -and (Test-Path (Join-Path $_.DirectoryName 'brand_kit.json')) } |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if (-not $job) { throw 'smoke mesin: tidak ada job generate di workspace untuk contoh brand_kit.json' }
        Copy-Item (Join-Path $job.DirectoryName 'brand_kit.json') $bk
    }
    return @{ Video = $video; BrandKit = $bk }
}

# Smoke mesin, tanpa menulis data live: engine cek; daftar_batch (baca saja) harus melihat batch di DATA\konten;
# generate pada job sementara (output hanya di job itu) harus menghasilkan ops.json ms-ops/1.
function Smoke-Mesin([string]$kode, [string]$nama) {
    $data = Folder-DataMesin
    $hasil = @()
    $r = Mesin-Jalan $kode $data "$nama.cek" @('cek')
    if ($r.Kode -ne 0) { throw "smoke mesin: engine cek kode $($r.Kode); lihat $($r.Err)" }
    $hasil += 'cek ok'

    $r = Mesin-Jalan $kode $data "$nama.daftar" @('daftar_batch')
    if ($r.Kode -ne 0) { throw "smoke mesin: daftar_batch kode $($r.Kode); lihat $($r.Err)" }
    $d = $r.Out | ConvertFrom-Json
    if ($d.schema -ne 'daftar-batch/1') { throw 'smoke mesin: daftar_batch bukan schema daftar-batch/1' }
    $adaData = @(Get-ChildItem (Join-Path $data 'konten\1-upload'), (Join-Path $data 'konten\2-dipisah') -Directory -ErrorAction SilentlyContinue).Count
    if ($adaData -and -not @($d.batch).Count) { throw "smoke mesin: daftar_batch kosong padahal $data\konten berisi batch (mesin membaca data dari folder kode?)" }
    $hasil += "daftar_batch ok ($(@($d.batch).Count) batch)"

    $bahan = Bahan-Uji
    $job = Join-Path ([IO.Path]::GetTempPath()) "motion-smoke-mesin-$nama"
    Hapus-Folder $job
    New-Item -ItemType Directory -Force -Path $job | Out-Null
    try {
        Copy-Item $bahan.BrandKit (Join-Path $job 'brand_kit.json')
        $j = [ordered]@{ schema = 'engine-job/1'; job_id = 'SMOKE-RILIS-001'; mode = 'generate'
            sumber = @(@{ kunci = '$sumber'; path = $bahan.Video.Replace('\', '/') }); brand_kit = 'brand_kit.json'; preset = 'standar'
            brief = [ordered]@{ produk = 'celana'; varian = ''; harga = ''; placement = 'tiktok'; catatan = 'smoke rilis mesin, bukan untuk tayang' }; ai = $false }
        Tulis (Join-Path $job 'job.json') ($j | ConvertTo-Json -Depth 5)
        $t0 = Get-Date
        $r = Mesin-Jalan $kode $data "$nama.generate" @('generate', $job)
        if ($r.Kode -ne 0) { throw "smoke mesin: generate kode $($r.Kode); lihat $($r.Err)" }
        $ops = Get-Content (Join-Path $job 'out\ops.json') -Raw | ConvertFrom-Json
        if ($ops.schema -ne 'ms-ops/1' -or -not @($ops.ops).Count) { throw 'smoke mesin: ops.json generate kosong / bukan ms-ops/1' }
        $hasil += "generate ok ($(@($ops.ops).Count) operasi, $([int]((Get-Date) - $t0).TotalSeconds) dtk)"
    } finally { Hapus-Folder $job }
    return ($hasil -join '; ')
}

function Siapkan-Mesin([string]$ref) {
    $git = (Get-Command git -ErrorAction Stop).Source
    $sha = Luar $git -C $RepoMesin rev-parse --verify "$ref^{commit}"
    if ($script:kodeLuar -ne 0 -or -not $sha) { throw "Commit mesin tidak ditemukan: $ref" }
    $sha = "$sha".Trim()
    Luar $git -C $RepoMesin merge-base --is-ancestor $sha $CabangMesin | Out-Null
    if ($script:kodeLuar -ne 0) {
        if (-not $BukanMain) { throw "Commit $sha bukan bagian dari $CabangMesin (rilis mesin hanya dari $CabangMesin yang lulus audit; -BukanMain untuk uji)" }
        Catat "PERINGATAN: $sha bukan bagian dari $CabangMesin (-BukanMain)"
    }
    foreach ($wajib in 'pipeline/engine.py', 'pipeline/batch/jalur.py', 'pipeline/edit.py', 'pipeline/transcribe.py') {
        Luar $git -C $RepoMesin cat-file -e "${sha}:$wajib" | Out-Null
        if ($script:kodeLuar -ne 0) { throw "Commit $($sha.Substring(0, 7)) bukan commit mesin (tidak ada $wajib)" }
    }
    Luar $git -C $RepoMesin cat-file -e "${sha}:apps/server/src/main.ts" | Out-Null
    if ($script:kodeLuar -eq 0) { throw "Commit $($sha.Substring(0, 7)) berisi Motion Studio, bukan repo mesin" }
    # Tanpa dukungan MOTION_ENGINE_DATA, kode dari folder rilis akan mencari konten/ & public/ di folder rilis (kosong).
    $dukung = @(Luar $git -C $RepoMesin grep -l MOTION_ENGINE_DATA $sha -- pipeline/engine.py pipeline/batch/jalur.py)
    if ($dukung.Count -lt 2) { throw "Commit $($sha.Substring(0, 7)) belum mendukung MOTION_ENGINE_DATA di pipeline/engine.py dan pipeline/batch/jalur.py (perubahan B1/C1)" }
    $judul = "$(Luar $git -C $RepoMesin log -1 --format=%s $sha)".Trim()
    $nama = (Get-Date -Format 'yyyyMMdd-HHmmss') + '_' + $sha.Substring(0, 7)
    $staging = Join-Path $dirRilis ".baru-$nama"
    Catat "siapkan rilis mesin $nama dari $sha ($judul)"
    $t0 = Get-Date
    try {
        New-Item -ItemType Directory -Force -Path $staging | Out-Null
        $tar = Join-Path $dirLog "$nama.tar"
        Luar $git -C $RepoMesin archive --format=tar -o $tar $sha | Out-Null
        if ($script:kodeLuar -ne 0) { throw 'git archive gagal' }
        Luar tar.exe -xf $tar -C $staging | Out-Null
        if ($script:kodeLuar -ne 0) { throw 'ekstrak tar gagal' }
        Remove-Item $tar -Force
        Catat "  salinan commit siap ($([int]((Get-Date) - $t0).TotalSeconds) dtk); smoke (cek, daftar_batch, generate uji)"
        $smoke = Smoke-Mesin $staging $nama
        Catat "  smoke lulus: $smoke"
        $info = [ordered]@{ nama = $nama; bagian = 'mesin'; commit = $sha; commit_pendek = $sha.Substring(0, 7); judul = $judul; dibuat = (Get-Date -Format s); data = (Folder-DataMesin); smoke = $smoke }
        Tulis (Join-Path $staging 'RILIS.json') ($info | ConvertTo-Json)
        Rename-Item $staging $nama
        Catat "rilis mesin $nama siap ($([int]((Get-Date) - $t0).TotalSeconds) dtk)"
        return $nama
    } catch {
        Catat "GAGAL menyiapkan rilis mesin: $($_.Exception.Message) (situs tidak berubah)"
        Hapus-Folder $staging
        exit 2
    }
}

# Simpan $Simpan rilis terbaru; rilis aktif dan sebelumnya tidak pernah dihapus. Sisa staging gagal ikut dibersihkan.
function Rapikan {
    $jaga = @((Baca $penunjuk), (Baca $penunjukLama)) | Where-Object { $_ }
    Get-ChildItem $dirRilis -Directory | Where-Object { $_.Name -like '.baru-*' -and $_.LastWriteTime -lt (Get-Date).AddHours(-6) } | ForEach-Object { Hapus-Folder $_.FullName }
    $semua = Daftar-Rilis
    $semua | Select-Object -Skip $Simpan | Where-Object { $jaga -notcontains $_.Name } | ForEach-Object { Catat "hapus rilis lama $($_.Name)"; Hapus-Folder $_.FullName }
    Get-ChildItem $dirLog -File | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-30) } | Remove-Item -Force -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------- utama
if ($Status) { Tampil-Status; return }
# -Mesin -SmokeSaja <folder kode>: hanya smoke mesin pada folder itu (mis. folder kerja), tanpa rilis/restart.
if ($SmokeSaja) {
    if (-not $Mesin) { throw '-SmokeSaja hanya untuk -Mesin' }
    Catat "smoke mesin saja: $SmokeSaja"
    Catat "smoke lulus: $(Smoke-Mesin (Resolve-Path $SmokeSaja).Path ('smoke-' + (Get-Date -Format 'yyyyMMdd-HHmmss')))"
    return
}
$mode = @($Commit, $Aktifkan, $(if ($Kembali) { 'k' } else { '' })) | Where-Object { $_ }
if (@($mode).Count -ne 1) { throw 'Pilih satu: -Commit <sha>, -Aktifkan <nama>, -Kembali, atau -Status' }

# Satu rilis dalam satu waktu.
$kunci = Join-Path $Rilis '.rilis.lock'
if ((Test-Path $kunci) -and (Get-Item $kunci).LastWriteTime -lt (Get-Date).AddHours(-2)) { Remove-Item $kunci -Force }
try { $fk = [IO.File]::Open($kunci, 'CreateNew', 'Write', 'None') } catch { throw "Rilis lain sedang berjalan ($kunci)" }
try {
    if ($Commit) {
        $nama = if ($Mesin) { Siapkan-Mesin $Commit } else { Siapkan $Commit }
        if ($TanpaGanti) { Catat "situs tidak diganti (-TanpaGanti). Aktifkan nanti: deploy\windows\rilis.ps1$(if ($Mesin) { ' -Mesin' }) -Aktifkan $nama" }
        else { [void](Aktifkan-Rilis $nama) }
    } elseif ($Aktifkan) {
        [void](Aktifkan-Rilis $Aktifkan)
    } else {
        $s = Baca $penunjukLama
        if (-not $s) { throw 'Tidak ada rilis sebelumnya (SEBELUMNYA.txt kosong)' }
        Catat "kembali ke rilis sebelumnya: $s"
        [void](Aktifkan-Rilis $s -Mundur)
    }
    Rapikan
} finally {
    $fk.Close(); Remove-Item $kunci -Force -ErrorAction SilentlyContinue
}
