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
param(
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
$dirRilis = Join-Path $Rilis 'rilis'
$dirLog = Join-Path $Rilis 'log'
New-Item -ItemType Directory -Force -Path $dirRilis, $dirLog | Out-Null
$penunjuk = Join-Path $Rilis 'AKTIF.txt'
$penunjukLama = Join-Path $Rilis 'SEBELUMNYA.txt'
$logUtama = Join-Path $dirLog ('rilis-' + (Get-Date -Format 'yyyyMMdd') + '.log')

function Catat([string]$t) {
    $baris = "[$(Get-Date -Format s)] $t"
    Write-Host $baris   # bukan Write-Output: itu ikut jadi nilai kembali fungsi (mis. nama rilis dari Siapkan)
    try { $fs = [IO.File]::Open($logUtama, 'Append', 'Write', 'ReadWrite'); $b = [Text.Encoding]::UTF8.GetBytes("$baris`r`n"); $fs.Write($b, 0, $b.Length); $fs.Close() } catch { }
}
function Baca([string]$f) { if (Test-Path $f) { ([IO.File]::ReadAllText($f)).Trim() } else { '' } }
function Tulis([string]$f, [string]$isi) { [IO.File]::WriteAllText($f, $isi, (New-Object Text.UTF8Encoding $false)) }
function DirRilis([string]$nama) { Join-Path $dirRilis $nama }
function Lengkap([string]$dir) {
    (Test-Path (Join-Path $dir 'apps\server\dist\main.js')) -and (Test-Path (Join-Path $dir 'apps\web\dist\index.html')) -and (Test-Path (Join-Path $dir 'packages\core\dist\index.js'))
}

# ---------------------------------------------------------------- status
function Tampil-Status {
    $a = Baca $penunjuk; $s = Baca $penunjukLama
    Write-Output "Folder rilis : $Rilis"
    Write-Output "Aktif        : $(if ($a) { $a } else { '(belum ada - server jalan dari folder kerja)' })"
    Write-Output "Sebelumnya   : $(if ($s) { $s } else { '-' })"
    Get-ChildItem $dirRilis -Directory | Sort-Object Name -Descending | ForEach-Object {
        $info = Join-Path $_.FullName 'RILIS.json'
        $ket = if (Test-Path $info) { $j = Get-Content $info -Raw | ConvertFrom-Json; "$($j.commit_pendek) $($j.judul)" } else { '(tanpa RILIS.json)' }
        $tanda = if ($_.Name -eq $a) { '*' } elseif ($_.Name -eq $s) { '<' } else { ' ' }
        Write-Output (" $tanda $($_.Name)  $ket")
    }
    $srv = Pid-Server
    if ($srv) { Write-Output "Server port $Port : pid $($srv.Pid) $($srv.Cmd)" } else { Write-Output "Server port $Port : tidak jalan" }
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
# Tunggu server live sehat DAN jalan dari folder yang diharapkan.
function Tunggu-Sehat([string]$dir, [int]$detik) {
    $batas = (Get-Date).AddSeconds($detik)
    $harap = (Join-Path $dir 'apps\server\dist\main.js').ToLowerInvariant()
    while ((Get-Date) -lt $batas) {
        $s = Pid-Server
        if ($s -and $s.Cmd.ToLowerInvariant().Contains($harap) -and (Sehat $Port)) { return $s }
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
    Tulis $penunjukLama $lama
    Tulis $penunjuk $nama
    Catat "AKTIF.txt: '$lama' -> '$nama'"
    $t0 = Get-Date
    Mulai-Ulang
    $s = Tunggu-Sehat $dir 120
    if ($s) { Catat "SELESAI: server sehat dari rilis $nama (pid $($s.Pid)) dalam $([int]((Get-Date) - $t0).TotalSeconds) dtk"; return $true }

    Catat "GAGAL: server tidak sehat dari rilis $nama dalam 2 menit -> kembali ke '$lama'"
    if ($lama) { Tulis $penunjuk $lama } else { Remove-Item $penunjuk -Force }
    Tulis $penunjukLama $lamaSebelumnya   # rilis gagal tidak boleh jadi tujuan -Kembali
    Mulai-Ulang
    $dirLama = if ($lama) { DirRilis $lama } else { $Repo }
    $s = Tunggu-Sehat $dirLama 120
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

# Simpan $Simpan rilis terbaru; rilis aktif dan sebelumnya tidak pernah dihapus. Sisa staging gagal ikut dibersihkan.
function Rapikan {
    $jaga = @((Baca $penunjuk), (Baca $penunjukLama)) | Where-Object { $_ }
    Get-ChildItem $dirRilis -Directory | Where-Object { $_.Name -like '.baru-*' -and $_.LastWriteTime -lt (Get-Date).AddHours(-6) } | ForEach-Object { Hapus-Folder $_.FullName }
    $semua = Get-ChildItem $dirRilis -Directory | Where-Object { $_.Name -notlike '.*' } | Sort-Object Name -Descending
    $semua | Select-Object -Skip $Simpan | Where-Object { $jaga -notcontains $_.Name } | ForEach-Object { Catat "hapus rilis lama $($_.Name)"; Hapus-Folder $_.FullName }
    Get-ChildItem $dirLog -File | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-30) } | Remove-Item -Force -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------- utama
if ($Status) { Tampil-Status; return }
$mode = @($Commit, $Aktifkan, $(if ($Kembali) { 'k' } else { '' })) | Where-Object { $_ }
if (@($mode).Count -ne 1) { throw 'Pilih satu: -Commit <sha>, -Aktifkan <nama>, -Kembali, atau -Status' }

# Satu rilis dalam satu waktu.
$kunci = Join-Path $Rilis '.rilis.lock'
if ((Test-Path $kunci) -and (Get-Item $kunci).LastWriteTime -lt (Get-Date).AddHours(-2)) { Remove-Item $kunci -Force }
try { $fk = [IO.File]::Open($kunci, 'CreateNew', 'Write', 'None') } catch { throw "Rilis lain sedang berjalan ($kunci)" }
try {
    if ($Commit) {
        $nama = Siapkan $Commit
        if ($TanpaGanti) { Catat "situs tidak diganti (-TanpaGanti). Aktifkan nanti: deploy\windows\rilis.ps1 -Aktifkan $nama" }
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
