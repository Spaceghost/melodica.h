# Release smoke test for pianobar-windows, run by .github/workflows/release.yml on windows-latest
# with Windows PowerShell 5.1 (Add-Type -OutputType ConsoleApplication and System.Drawing need it).
#
# Proves, on the exact artifacts being released:
#   1. the Inno Setup installer installs silently per-user, registers its uninstaller, and uninstalls cleanly;
#   2. the installed pianobar.exe starts in a console, prints its banner and completes (or fails) the login;
#   3. the portable zip's pianobar.exe does the same;
#   4. with a melodica-tuner test server (-TunerHost): login succeeds, the station list appears, the first
#      station is selected and a "|>" now-playing line is printed; the tuner log confirms the API calls.
# Writes smoke-windows.json, smoke-windows.txt, smoke-windows-login.png, smoke-windows-stations.png (tuner only)
# plus the raw driver outputs into -OutDir. Exits non-zero when a mandatory assertion fails.
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $Installer,
    [Parameter(Mandatory)] [string] $Zip,
    [Parameter(Mandatory)] [string] $OutDir,
    [Parameter(Mandatory)] [string] $DriverSource,
    [string] $InstallDir = "$env:LOCALAPPDATA\Programs\pianobar",
    [string] $User = 'smoke@example.invalid',
    [string] $Password = 'smoke-password',
    [string] $TunerHost = '',
    [string] $TunerPort = '',
    [string] $TunerLogUrl = '',
    [string] $TunerHealthUrl = '',
    [string] $TunerLabel = '',
    [string] $Station = '0',
    [string[]] $ExtraConfig = @()
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Drawing, System.Windows.Forms

$OutDir = (New-Item -ItemType Directory -Force -Path $OutDir).FullName
$steps = New-Object System.Collections.ArrayList
$failures = New-Object System.Collections.ArrayList
$when = (Get-Date).ToUniversalTime().ToString('o')
$withTuner = $TunerHost -ne ''

function Step([string] $name, [bool] $ok, [string] $detail, [bool] $mandatory = $true) {
    $null = $steps.Add([ordered]@{ name = $name; ok = $ok; detail = $detail })
    $mark = if ($ok) { 'PASS' } else { 'FAIL' }
    Write-Host "[$mark] $name - $detail"
    if (-not $ok -and $mandatory) { $null = $failures.Add($name) }
}

function Write-Config([string] $dir) {
    $lines = @(
        "user = $User",
        "password = $Password",
        'timeout = 10',
        'width = 120',
        'height = 50'
    )
    if ($withTuner) {
        $lines += "rpc_host = $TunerHost"
        if ($TunerPort) { $lines += "rpc_tls_port = $TunerPort" }
    } else {
        # No network target: point at a closed local port so the login fails fast and deterministically.
        $lines += 'rpc_host = 127.0.0.1'
        $lines += 'rpc_tls_port = 9'
    }
    $lines += $ExtraConfig
    [IO.File]::WriteAllLines((Join-Path $dir 'pianobar.cfg'), $lines, (New-Object Text.UTF8Encoding $false))
}

function Capture-Screen([string] $path) {
    # Real desktop capture; the console window the driver opened should be in it.
    try {
        $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
        $bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bmp.Size)
        $g.Dispose()
        # Blank detection: sample a grid; a black/uniform capture has (almost) one colour.
        $colors = @{}
        for ($y = 0; $y -lt $bmp.Height; $y += 24) {
            for ($x = 0; $x -lt $bmp.Width; $x += 24) { $colors[$bmp.GetPixel($x, $y).ToArgb()] = 1 }
        }
        $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
        $bmp.Dispose()
        if ($colors.Count -ge 3) { return "desktop capture $($bounds.Width)x$($bounds.Height), $($colors.Count) sampled colours" }
        return "desktop capture was blank ($($colors.Count) colours)"
    } catch {
        return "desktop capture failed: $($_.Exception.Message)"
    }
}

function Render-Transcript([string] $transcript, [string] $path) {
    $lines = @(Get-Content -LiteralPath $transcript -Encoding UTF8)
    $font = New-Object System.Drawing.Font 'Consolas', 11
    $bmp = New-Object System.Drawing.Bitmap 1400, ([Math]::Max(200, 20 * $lines.Count + 40))
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.Clear([System.Drawing.Color]::Black)
    $y = 20
    foreach ($l in $lines) { $g.DrawString($l, $font, [System.Drawing.Brushes]::LightGray, 20, $y); $y += 20 }
    $g.Dispose(); $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
}

# Runs the driver in its own visible console; takes screenshots at the checkpoints it announces.
function Run-Driver([string] $exe, [string] $label, [string] $stationArg, [hashtable] $shots) {
    Get-ChildItem $OutDir -Filter "$label-*" -ErrorAction SilentlyContinue | Remove-Item -Force
    $hold = if ($withTuner) { 15 } else { 0 }
    $loginTimeout = if ($withTuner) { 30 } else { 20 }
    $argList = @("`"$exe`"", "`"$OutDir`"", $label, $stationArg, $hold, $loginTimeout)
    $p = Start-Process -FilePath $driverExe -ArgumentList $argList -WorkingDirectory (Split-Path $exe) -PassThru
    $deadline = (Get-Date).AddSeconds(180)
    $pending = @($shots.Keys)
    while (-not $p.HasExited -and (Get-Date) -lt $deadline) {
        foreach ($cp in @($pending)) {
            if (Test-Path (Join-Path $OutDir "$label-ready-$cp")) {
                Start-Sleep -Milliseconds 500
                $script:shotNotes[$shots[$cp]] = Capture-Screen (Join-Path $OutDir $shots[$cp])
                New-Item -ItemType File -Path (Join-Path $OutDir "$label-go-$cp") -Force | Out-Null
                $pending = @($pending | Where-Object { $_ -ne $cp })
            }
        }
        Start-Sleep -Milliseconds 300
    }
    if (-not $p.HasExited) { $p.Kill(); Step "$label driver" $false 'driver did not finish within 180 s' }
    Get-Process pianobar -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    $resultPath = Join-Path $OutDir "$label-result.json"
    if (-not (Test-Path $resultPath)) { Step "$label driver" $false 'no result file'; return $null }
    $r = Get-Content -LiteralPath $resultPath -Raw -Encoding UTF8 | ConvertFrom-Json
    Write-Host "---- $label screen ----"
    $r.screen | ForEach-Object { Write-Host "  | $_" }
    Write-Host '---- end ----'
    $t = Join-Path $OutDir "$label-transcript.txt"
    foreach ($cp in $shots.Keys) {
        $png = $shots[$cp]
        if ($pending -contains $cp) {
            # Checkpoint never announced (driver bailed early): render the transcript for the record.
            if (Test-Path $t) { Render-Transcript $t (Join-Path $OutDir $png); $script:shotNotes[$png] = 'checkpoint not reached; rendered the transcript' }
        } elseif ($script:shotNotes[$png] -notlike 'desktop capture *x*') {
            if (Test-Path $t) { Render-Transcript $t (Join-Path $OutDir $png); $script:shotNotes[$png] += '; rendered the transcript instead' }
        }
    }
    return $r
}

# Waits for $proc and every descendant (Inno's SetupLdr hands off to Setup.tmp) up to $seconds; true when all gone.
function Wait-Tree([System.Diagnostics.Process] $proc, [int] $seconds) {
    $deadline = (Get-Date).AddSeconds($seconds)
    $ids = @($proc.Id)
    while ((Get-Date) -lt $deadline) {
        $live = @(Get-CimInstance Win32_Process | Where-Object { $ids -contains $_.ProcessId -or $ids -contains $_.ParentProcessId })
        foreach ($l in $live) { if ($ids -notcontains $l.ProcessId) { $ids += $l.ProcessId } }
        if ($live.Count -eq 0) { return $true }
        Start-Sleep -Seconds 2
    }
    return $false
}

$script:shotNotes = @{}

# ---- 0a. tuner reachable the way pianobar will reach it (hosts override, port 443, system trust store) ----
if ($withTuner -and $TunerHealthUrl) {
    try {
        $h = Invoke-WebRequest -UseBasicParsing -Uri $TunerHealthUrl -TimeoutSec 30
        Step 'tuner health (https via system trust store)' ($h.StatusCode -eq 200) "$TunerHealthUrl -> $($h.StatusCode) $($h.Content.Trim())"
    } catch {
        Step 'tuner health (https via system trust store)' $false "$TunerHealthUrl : $($_.Exception.Message)"
    }
}

# ---- 0. compile the console driver (C# 5, .NET Framework) ----
$driverExe = Join-Path $OutDir 'SmokeDriver.exe'
Add-Type -Path $DriverSource -OutputAssembly $driverExe -OutputType ConsoleApplication -ReferencedAssemblies System.dll, System.Core.dll
Step 'driver compiled' (Test-Path $driverExe) $driverExe

# ---- 1. installer ----
$Installer = (Resolve-Path $Installer).Path
$setup = Start-Process -FilePath $Installer -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CURRENTUSER', "/DIR=`"$InstallDir`"", "/LOG=`"$OutDir\install.log`"") -PassThru
# Bounded wait (an unsuppressed dialog hung run 42099849538 for 38 min): on timeout record what is on screen and kill the setup tree.
$setupDone = Wait-Tree $setup 300
if (-not $setupDone) {
    $script:shotNotes['smoke-windows-installer-hung.png'] = Capture-Screen (Join-Path $OutDir 'smoke-windows-installer-hung.png')
    $wins = (Get-Process | Where-Object { $_.MainWindowTitle } | ForEach-Object { "$($_.ProcessName):$($_.MainWindowTitle)" }) -join '; '
    Get-Process | Where-Object { $_.ProcessName -match 'setup|is-|pianobar|_iu' } | Stop-Process -Force -ErrorAction SilentlyContinue
    Step 'installer exit code' $false "$(Split-Path -Leaf $Installer) still running after 300 s; windows: $wins"
} else {
    Step 'installer exit code' ($setup.ExitCode -eq 0) "$(Split-Path -Leaf $Installer) exited $($setup.ExitCode)"
}
$installLog = Join-Path $OutDir 'install.log'
Step 'install.log written' ((Test-Path $installLog) -and (Get-Item $installLog).Length -gt 0) ("$installLog " + $(if (Test-Path $installLog) { "$((Get-Item $installLog).Length) bytes" } else { 'missing' })) $false
$exe = Join-Path $InstallDir 'pianobar.exe'
Step 'pianobar.exe installed' (Test-Path $exe) $exe
Step 'pianobar.cfg.example installed' (Test-Path (Join-Path $InstallDir 'pianobar.cfg.example')) (Join-Path $InstallDir 'pianobar.cfg.example')
Step 'unins000.exe present' (Test-Path (Join-Path $InstallDir 'unins000.exe')) (Join-Path $InstallDir 'unins000.exe')
$uninstKeys = @(Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue |
    Where-Object { ($_ | Get-ItemProperty).DisplayName -like 'pianobar*' })
$keyDetail = if ($uninstKeys) { ($uninstKeys | ForEach-Object { $p = $_ | Get-ItemProperty; "$($_.PSChildName): $($p.DisplayName) $($p.DisplayVersion) -> $($p.UninstallString)" }) -join '; ' } else { 'no HKCU Uninstall entry named pianobar*' }
Step 'uninstaller registered (HKCU)' ($uninstKeys.Count -ge 1) $keyDetail
$userPath = (Get-ItemProperty 'HKCU:\Environment' -ErrorAction SilentlyContinue).Path
Step 'user PATH contains install dir' ((";$userPath;") -like "*;$InstallDir;*") "HKCU\Environment\Path = $userPath" $false

# ---- 2. installed pianobar.exe: banner, login (and stations/now-playing with the tuner) ----
$transcriptParts = New-Object System.Collections.ArrayList
$installedResult = $null
if (Test-Path $exe) {
    Write-Config $InstallDir
    $stationArg = if ($withTuner) { $Station } else { '-' }
    $shots = @{ login = 'smoke-windows-login.png' }
    if ($withTuner) { $shots['stations'] = 'smoke-windows-stations.png' }
    $installedResult = Run-Driver $exe 'installed' $stationArg $shots
    if ($installedResult) {
        Step 'installed: "Welcome to pianobar" banner' ([bool] $installedResult.welcome) ($installedResult.screen | Where-Object { $_ -like '*Welcome to pianobar*' } | Select-Object -First 1)
        $loginLine = $installedResult.screen | Where-Object { $_ -like '*Login...*' } | Select-Object -First 1
        Step 'installed: login line printed' ($installedResult.login -ne 'timeout' -and $installedResult.login -ne 'none') "$loginLine"
        if ($withTuner) {
            Step 'installed: login against tuner succeeded' ($installedResult.login -eq 'ok') "$loginLine"
            $stationLines = @($installedResult.screen | Where-Object { $_ -match '^\s*\d+\)\s' })
            Step 'installed: station list shown' ([bool] $installedResult.stations) (($stationLines | Select-Object -First 5) -join ' / ')
            $np = $installedResult.screen | Where-Object { $_ -like '*|>*' } | Select-Object -First 1
            Step 'installed: "|>" now-playing line after selecting station' ([bool] $installedResult.nowPlaying) "$np"
        }
        $null = $transcriptParts.Add((Get-Content -LiteralPath (Join-Path $OutDir 'installed-transcript.txt') -Raw -Encoding UTF8))
    }
}

# ---- 3. tuner log: the server must have seen the calls ----
$tunerSummary = if ($withTuner) { "melodica-tuner at $TunerHost$(if ($TunerPort) { ':' + $TunerPort })$(if ($TunerLabel) { ' (' + $TunerLabel + ')' })" } else { 'none (login pointed at 127.0.0.1:9, expected to fail)' }
if ($withTuner -and $TunerLogUrl) {
    try {
        $log = (Invoke-WebRequest -UseBasicParsing -Uri $TunerLogUrl -TimeoutSec 30).Content
        [IO.File]::WriteAllText((Join-Path $OutDir 'tuner-log.txt'), $log, (New-Object Text.UTF8Encoding $false))
        # The log is one JSON array of requests; report the matching entries, not the whole blob.
        $entries = @()
        try {
            # Windows PowerShell 5.1 hands a JSON array back as one Object[] item; unwrap it before filtering.
            $parsed = ConvertFrom-Json -InputObject $log
            while ($parsed -is [array] -and $parsed.Count -eq 1 -and $parsed[0] -is [array]) { $parsed = $parsed[0] }
            foreach ($e in $parsed) { $entries += $e }
        } catch { Write-Host "tuner log is not JSON: $($_.Exception.Message)" }
        function Tuner-Calls([scriptblock] $match) {
            $hits = @($entries | Where-Object $match)
            if ($hits.Count -eq 0) { return $null }
            $h = $hits[0]
            return "$($hits.Count) call(s); first: $($h.time) $(if ($h.secure) { 'https' } else { 'http' }) $($h.httpMethod) $($h.path) $($h.method)"
        }
        foreach ($m in 'auth.partnerLogin', 'auth.userLogin', 'user.getStationList', 'station.getPlaylist') {
            $d = Tuner-Calls { $_.method -eq $m }
            if (-not $d -and $log -match [regex]::Escape($m)) { $d = 'matched as text; log not parsed as JSON' }
            Step "tuner log: $m" ([bool] $d) "$d"
        }
        $audio = Tuner-Calls { "$($_.path)" -like '*/audio/*' }
        if (-not $audio -and $log -match '/audio/') { $audio = 'matched as text; log not parsed as JSON' }
        Step 'tuner log: /audio/ fetched by the player' ([bool] $audio) "$audio" $false
    } catch {
        Step 'tuner log fetched' $false "$TunerLogUrl : $($_.Exception.Message)"
    }
}

# ---- 4. portable zip ----
$portableDir = Join-Path $OutDir 'portable'
if (Test-Path $portableDir) { Remove-Item -Recurse -Force $portableDir }
Expand-Archive -LiteralPath (Resolve-Path $Zip).Path -DestinationPath $portableDir
$pexe = Join-Path $portableDir 'pianobar.exe'
Step 'portable zip holds pianobar.exe and pianobar.cfg.example' ((Test-Path $pexe) -and (Test-Path (Join-Path $portableDir 'pianobar.cfg.example'))) ((Get-ChildItem $portableDir | Select-Object -ExpandProperty Name) -join ', ')
if (Test-Path $pexe) {
    Write-Config $portableDir
    $pr = Run-Driver $pexe 'portable' '-' @{}
    if ($pr) {
        Step 'portable: "Welcome to pianobar" banner' ([bool] $pr.welcome) ($pr.screen | Where-Object { $_ -like '*Welcome to pianobar*' } | Select-Object -First 1)
        Step 'portable: login line printed' ($pr.login -ne 'timeout' -and $pr.login -ne 'none') ($pr.screen | Where-Object { $_ -like '*Login...*' } | Select-Object -First 1)
        $null = $transcriptParts.Add((Get-Content -LiteralPath (Join-Path $OutDir 'portable-transcript.txt') -Raw -Encoding UTF8))
    }
}

# ---- 5. uninstall ----
$unins = Join-Path $InstallDir 'unins000.exe'
if (Test-Path $unins) {
    Remove-Item -Force (Join-Path $InstallDir 'pianobar.cfg') -ErrorAction SilentlyContinue
    $u = Start-Process -FilePath $unins -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART') -PassThru
    if (-not (Wait-Tree $u 180)) { Get-Process | Where-Object { $_.ProcessName -match '_iu|unins' } | Stop-Process -Force -ErrorAction SilentlyContinue }
    # The Inno uninstaller hands off to a copy of itself; wait for the directory to disappear.
    $deadline = (Get-Date).AddSeconds(90)
    while ((Test-Path $InstallDir) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 2 }
    Step 'uninstaller exit code' ($u.ExitCode -eq 0) "unins000.exe exited $($u.ExitCode)"
    Step 'install dir removed after uninstall' (-not (Test-Path $InstallDir)) $InstallDir
    $left = @(Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue |
        Where-Object { ($_ | Get-ItemProperty).DisplayName -like 'pianobar*' })
    Step 'uninstall entry removed (HKCU)' ($left.Count -eq 0) "$($left.Count) pianobar entries left"
    $userPath = (Get-ItemProperty 'HKCU:\Environment' -ErrorAction SilentlyContinue).Path
    Step 'install dir removed from user PATH' (-not ((";$userPath;") -like "*;$InstallDir;*")) "HKCU\Environment\Path = $userPath" $false
}

# ---- 6. report ----
$mandatoryOk = $failures.Count -eq 0
$proof = $withTuner -and $installedResult -and $installedResult.login -eq 'ok' -and $installedResult.stations -and $installedResult.nowPlaying -and $mandatoryOk
$summary = if ($proof) {
    "installer installs/uninstalls; installed and portable pianobar.exe start, log in to the melodica-tuner test server, list stations and print a now-playing line; tuner log shows the API calls"
} elseif ($mandatoryOk) {
    "installer installs/uninstalls; installed and portable pianobar.exe start and print their banner and login line; no test server, so login/stations/playback not proven"
} else {
    "FAILED: $($failures -join ', ')"
}
$json = [ordered]@{
    ok = [bool] $proof
    platform = 'windows'
    summary = $summary
    when = $when
    runner = "$env:ImageOS $env:ImageVersion ($env:COMPUTERNAME)"
    version = $env:VERSION
    installer = (Split-Path -Leaf $Installer)
    zip = (Split-Path -Leaf $Zip)
    installDir = $InstallDir
    tuner = $tunerSummary
    screenshots = $script:shotNotes
    steps = $steps
}
$json | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $OutDir 'smoke-windows.json') -Encoding UTF8
$header = @(
    "pianobar-windows smoke test ($when)",
    "runner: $env:ImageOS $env:ImageVersion",
    "tuner: $tunerSummary",
    '',
    ($steps | ForEach-Object { "[{0}] {1} - {2}" -f ($(if ($_.ok) { 'PASS' } else { 'FAIL' }), $_.name, $_.detail) }),
    '', ''
) -join "`r`n"
[IO.File]::WriteAllText((Join-Path $OutDir 'smoke-windows.txt'), $header + ($transcriptParts -join "`r`n`r`n"), (New-Object Text.UTF8Encoding $false))
Write-Host "ok=$proof; failures: $($failures -join ', ')"
if (-not $mandatoryOk) { exit 1 }
