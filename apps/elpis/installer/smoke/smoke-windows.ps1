<#
Release smoke test for the Elpis Windows installer. Runs on a GitHub-hosted
windows-latest runner (interactive desktop) from .github/workflows/release.yml.

  install  -> assert files + uninstall key
  launch   -> wait for the login page (UI Automation), screenshot
  [tuner]  -> log in against the melodica-tuner test server, wait for the
              station list, pick the first station, wait for now-playing,
              screenshot, cross-check the tuner request log
  cleanup  -> kill, uninstall silently, assert the folder is gone

Writes smoke-windows.json, smoke-windows-*.png, smoke-windows-uia.txt and the
Elpis log into -OutDir. The JSON is written even when a step fails.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Installer,
    [Parameter(Mandatory)][string]$OutDir,
    [string]$TunerUser = '',
    [string]$TunerPassword = '',
    [string]$TunerLogUrl = '',
    [string]$TunerName = 'none'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing, System.Windows.Forms, Microsoft.VisualBasic
Add-Type -Namespace Smoke -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
'@

$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]

$OutDir = (New-Item -ItemType Directory -Force $OutDir).FullName
$InstallDir = Join-Path $env:RUNNER_TEMP 'elpis-smoke-install'
$UninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{8ED4C6C9-0E11-49FC-8C29-5FA453E72912}_is1'
$AppData = Join-Path $env:APPDATA 'Elpis'

$report = [ordered]@{
    ok       = $false
    platform = 'windows'
    summary  = ''
    when     = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    steps    = @()
    tuner    = $TunerName
    installer = [System.IO.Path]::GetFileName($Installer)
    controls = [ordered]@{}
    stations = @()
    now_playing = $null
    audio    = [ordered]@{}
    findings = @()
    error    = $null
}
$proc = $null

function Step([string]$s) { $script:report.steps += $s; Write-Host "::notice::step: $s" }
function Finding([string]$s) { $script:report.findings += $s; Write-Host "finding: $s" }
function Save-Report {
    $script:report | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 (Join-Path $OutDir 'smoke-windows.json')
}

function Wait-Until([scriptblock]$Cond, [int]$Seconds, [string]$What) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        $r = & $Cond
        if ($r) { return $r }
        Start-Sleep -Milliseconds 1000
    }
    return $null
}

function Find-Id($root, [string]$id) {
    $root.FindFirst($TS::Descendants, (New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, $id)))
}

function Get-RawDescendants($root, [int]$maxDepth = 30) {
    $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
    $out = New-Object System.Collections.Generic.List[object]
    $stack = New-Object System.Collections.Generic.Stack[object]
    $stack.Push(@($root, 0))
    while ($stack.Count -gt 0) {
        $item = $stack.Pop(); $el = $item[0]; $d = $item[1]
        $out.Add(@($el, $d))
        if ($d -ge $maxDepth) { continue }
        try { $c = $walker.GetFirstChild($el) } catch { $c = $null }
        $kids = @()
        while ($c -ne $null) { $kids += $c; try { $c = $walker.GetNextSibling($c) } catch { $c = $null } }
        [array]::Reverse($kids)
        foreach ($k in $kids) { $stack.Push(@($k, $d + 1)) }
    }
    return $out
}

function Describe($el) {
    try {
        $c = $el.Current
        return ('{0} id="{1}" name="{2}" class="{3}" off={4}' -f $c.ControlType.ProgrammaticName, $c.AutomationId, $c.Name, $c.ClassName, $c.IsOffscreen)
    } catch { return '<gone>' }
}

function Dump-Tree($root, [string]$path) {
    $lines = foreach ($pair in (Get-RawDescendants $root)) { ('  ' * $pair[1]) + (Describe $pair[0]) }
    $lines | Set-Content -Encoding utf8 $path
}

function Find-RawById($root, [string]$id) {
    @(Get-RawDescendants $root | ForEach-Object { $_[0] } | Where-Object { try { $_.Current.AutomationId -eq $id } catch { $false } })
}

function Save-Screenshot([string]$path) {
    $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
    $g.Dispose()
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host "screenshot: $path ($($b.Width)x$($b.Height))"
}

function Set-Foreground($p) {
    $p.Refresh()
    $h = $p.MainWindowHandle
    if ($h -ne [IntPtr]::Zero) {
        [Smoke.Native]::SetWindowPos($h, [IntPtr]::Zero, 0, 0, 0, 0, 0x0001 -bor 0x0040) | Out-Null
        [Smoke.Native]::SetForegroundWindow($h) | Out-Null
    }
    try { [Microsoft.VisualBasic.Interaction]::AppActivate($p.Id) } catch { }
    Start-Sleep -Milliseconds 500
}

function Click-Element($el) {
    $r = $el.Current.BoundingRectangle
    $x = [int]($r.X + $r.Width / 2); $y = [int]($r.Y + $r.Height / 2)
    [Smoke.Native]::SetCursorPos($x, $y) | Out-Null
    Start-Sleep -Milliseconds 150
    [Smoke.Native]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    [Smoke.Native]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 300
}

function Set-Value($el, [string]$text) {
    $vp = $null
    try { $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern) } catch { }
    if ($vp) { $vp.SetValue($text); return 'ValuePattern' }
    Click-Element $el
    [System.Windows.Forms.SendKeys]::SendWait('^a')
    [System.Windows.Forms.SendKeys]::SendWait($text)
    return 'SendKeys'
}

function Get-WindowName($win) { try { $win.Current.Name } catch { '' } }

function Get-CurrentSongJson {
    try {
        $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 'http://127.0.0.1:35747/currentsong'
        return $r.Content
    } catch { return $null }
}

try {
    # ---- install -----------------------------------------------------------
    if (-not (Test-Path $Installer)) { throw "installer not found: $Installer" }
    $log = Join-Path $OutDir 'smoke-windows-install.log'
    $p = Start-Process -FilePath $Installer -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CURRENTUSER', "/DIR=`"$InstallDir`"", "/LOG=`"$log`"") -Wait -PassThru
    if ($p.ExitCode -ne 0) { throw "installer exit code $($p.ExitCode)" }
    foreach ($f in 'Elpis.exe', 'melodica.dll', 'bass.dll', 'PandoraSharp.dll', 'unins000.exe') {
        if (-not (Test-Path (Join-Path $InstallDir $f))) { throw "missing after install: $f" }
    }
    if (-not (Test-Path $UninstallKey)) { throw "uninstall registry key missing: $UninstallKey" }
    $report.uninstall_key = (Get-ItemProperty $UninstallKey).DisplayVersion
    Step 'installed'

    # ---- config: write the Elpis log, no auto-login, MP3 -------------------
    New-Item -ItemType Directory -Force $AppData | Out-Null
    @('Debug_WriteLog|True', 'Login_AutoLogin|False', 'Pandora_AudioFormat|MP3', 'Elpis_CheckUpdates|False') |
        Set-Content -Encoding Unicode (Join-Path $AppData 'elpis.config')

    # ---- launch ------------------------------------------------------------
    $exe = Join-Path $InstallDir 'Elpis.exe'
    $proc = Start-Process -FilePath $exe -WorkingDirectory $InstallDir -PassThru
    $pid_ = $proc.Id
    $win = Wait-Until {
        if ($proc.HasExited) { throw "Elpis exited early with code $($proc.ExitCode)" }
        $cond = New-Object System.Windows.Automation.AndCondition(
            (New-Object System.Windows.Automation.PropertyCondition($AE::ProcessIdProperty, $pid_)),
            (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)))
        $w = $AE::RootElement.FindFirst($TS::Children, $cond)
        if ($w -and -not $w.Current.IsOffscreen) { $w } else { $null }
    } 60 'main window'
    if (-not $win) { throw 'no main window within 60 s' }
    $report.window = [ordered]@{ name = (Get-WindowName $win); class = $win.Current.ClassName; bounds = $win.Current.BoundingRectangle.ToString() }
    Step 'opened'
    Set-Foreground $proc

    # ---- login page (or error page) ---------------------------------------
    $page = Wait-Until {
        if ($proc.HasExited) { throw "Elpis exited with code $($proc.ExitCode)" }
        $e = Find-Id $win 'txtEmail'; if ($e) { return 'login' }
        $d = Find-Id $win 'txtDescription'; if ($d -and -not $d.Current.IsOffscreen) { return 'error' }
        $null
    } 90 'login page'
    Set-Foreground $proc
    Dump-Tree $win (Join-Path $OutDir 'smoke-windows-uia.txt')
    if ($page -eq 'error') {
        $desc = (Find-Id $win 'txtDescription').Current.Name
        $btn = Find-Id $win 'btnShowException'
        if ($btn) { try { $btn.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); Start-Sleep 1 } catch { } }
        $detail = ''
        $te = Find-Id $win 'txtError'
        if ($te) { try { $detail = $te.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value } catch { } }
        Save-Screenshot (Join-Path $OutDir 'smoke-windows-error.png')
        throw "Elpis showed its error page: $desc`n$detail"
    }
    if ($page -ne 'login') { Save-Screenshot (Join-Path $OutDir 'smoke-windows-timeout.png'); throw 'login page not shown within 90 s' }

    $email = Find-Id $win 'txtEmail'; $pass = Find-Id $win 'txtPassword'; $login = Find-Id $win 'btnLogin'
    foreach ($pair in @(@('txtEmail', $email), @('txtPassword', $pass), @('btnLogin', $login))) {
        if (-not $pair[1]) { throw "login control not found: $($pair[0])" }
        $report.controls[$pair[0]] = Describe $pair[1]
    }
    $mask = Find-Id $win 'txtPasswordMask'; if ($mask) { $report.controls['txtPasswordMask'] = Describe $mask }
    Save-Screenshot (Join-Path $OutDir 'smoke-windows-login.png')
    Step 'login screen'
    $report.summary = 'installer installs; app opens to the login screen'

    # ---- tuner login -------------------------------------------------------
    if ($TunerUser) {
        $report.controls['txtEmail.set'] = Set-Value $email $TunerUser
        if ($mask -and -not $mask.Current.IsOffscreen) { Click-Element $mask }
        $pass = Find-Id $win 'txtPassword'
        $report.controls['txtPassword.set'] = Set-Value $pass $TunerPassword
        Start-Sleep -Milliseconds 300
        $login = Find-Id $win 'btnLogin'
        $login.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
        Write-Host 'login invoked'

        $items = Wait-Until {
            if ($proc.HasExited) { throw "Elpis exited with code $($proc.ExitCode)" }
            $d = Find-Id $win 'txtDescription'; if ($d -and -not $d.Current.IsOffscreen) { return 'error' }
            $names = Find-RawById $win 'txtStationName' | Where-Object { $_.Current.Name -and -not $_.Current.IsOffscreen }
            if ($names.Count -gt 0) { return $names }
            $null
        } 120 'station list'
        Set-Foreground $proc
        Dump-Tree $win (Join-Path $OutDir 'smoke-windows-uia-after-login.txt')
        if ($items -eq 'error') {
            $desc = (Find-Id $win 'txtDescription').Current.Name
            Save-Screenshot (Join-Path $OutDir 'smoke-windows-error.png')
            throw "Elpis showed its error page after login: $desc"
        }
        if (-not $items) {
            $err = Find-Id $win 'lblError'
            $msg = if ($err) { $err.Current.Name } else { '' }
            Save-Screenshot (Join-Path $OutDir 'smoke-windows-login-failed.png')
            throw "no station list within 120 s after login (login page error text: '$msg')"
        }
        Step 'logged in'
        $report.stations = @($items | ForEach-Object { $_.Current.Name })
        Save-Screenshot (Join-Path $OutDir 'smoke-windows-stations.png')
        Step 'stations'
        $report.summary = 'installer installs; app opens to the login screen; logs in against the tuner; shows stations'

        # ---- play the first station ---------------------------------------
        $first = $items[0]
        Write-Host "clicking station: $($first.Current.Name)"
        Click-Element $first
        $play = Wait-Until {
            if ($proc.HasExited) { throw "Elpis exited with code $($proc.ExitCode)" }
            $t = Get-WindowName $win
            if ($t -like 'Elpis |*') { return @{ title = $t; via = 'window title' } }
            $d = Find-Id $win 'txtDescription'; if ($d -and -not $d.Current.IsOffscreen) { return @{ error = $d.Current.Name } }
            $null
        } 90 'now playing'
        $song = Get-CurrentSongJson
        Set-Foreground $proc
        Dump-Tree $win (Join-Path $OutDir 'smoke-windows-uia-playing.txt')
        Save-Screenshot (Join-Path $OutDir 'smoke-windows-playing.png')
        $report.now_playing = [ordered]@{ window_title = (Get-WindowName $win); currentsong = $song }
        if ($play -and $play.title) {
            Step 'playing'
            $report.summary += '; plays the first station'
        } elseif ($play -and $play.error) {
            Finding "error page after selecting a station: $($play.error)"
        } else {
            Finding 'now-playing not observed within 90 s after selecting a station (window title never became "Elpis | artist / title")'
        }
    }
    $report.ok = ($report.steps -contains 'login screen') -and ((-not $TunerUser) -or ($report.steps -contains 'stations'))
}
catch {
    $report.error = $_.Exception.Message
    Write-Host "::error::$($_.Exception.Message)"
    try { Save-Screenshot (Join-Path $OutDir 'smoke-windows-failure.png') } catch { }
}
finally {
    # ---- Elpis log + audio findings ---------------------------------------
    if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force; $proc.WaitForExit(15000) | Out-Null }
    $elog = Join-Path $AppData 'elpis.log'
    if (Test-Path $elog) {
        Copy-Item $elog (Join-Path $OutDir 'smoke-windows-elpis.log')
        $bass = @(Select-String -Path $elog -Pattern 'BASS' | ForEach-Object { $_.Line.Trim() } | Select-Object -First 20)
        $report.audio.bass_log = $bass
        $report.audio.rpc_urls = @(Select-String -Path $elog -Pattern ':url\]: ' | ForEach-Object { ($_.Line -split ':url\]: ', 2)[1] } | Select-Object -First 20)
    }
    try { $report.audio.devices = @(Get-CimInstance Win32_SoundDevice | ForEach-Object { "$($_.Name) [$($_.Status)]" }) } catch { }

    # ---- tuner log cross-check --------------------------------------------
    if ($TunerLogUrl) {
        try {
            $tl = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 15 $TunerLogUrl).Content
            $tl | Set-Content -Encoding utf8 (Join-Path $OutDir 'smoke-windows-tuner.log')
            $seen = [ordered]@{}
            foreach ($m in 'auth.partnerLogin', 'auth.userLogin', 'user.getStationList', 'station.getPlaylist', '/audio/') { $seen[$m] = ($tl -match [regex]::Escape($m)) }
            $report.tuner_log = $seen
        } catch { Finding "tuner log fetch failed: $($_.Exception.Message)" }
    }

    # ---- uninstall ---------------------------------------------------------
    try {
        $u = Join-Path $InstallDir 'unins000.exe'
        if (Test-Path $u) {
            $p = Start-Process -FilePath $u -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART') -Wait -PassThru
            $gone = Wait-Until { -not (Test-Path $InstallDir) } 60 'install dir removed'
            if ($p.ExitCode -ne 0) { Finding "uninstaller exit code $($p.ExitCode)" }
            elseif (-not $gone) { Finding "install dir still present after uninstall: $(Get-ChildItem $InstallDir -Recurse | Select-Object -ExpandProperty FullName)" }
            elseif (Test-Path $UninstallKey) { Finding 'uninstall registry key still present after uninstall' }
            else { Step 'uninstalled' }
        }
    } catch { Finding "uninstall failed: $($_.Exception.Message)" }

    Save-Report
    Get-Content (Join-Path $OutDir 'smoke-windows.json')
}
if ($report.error) { exit 1 }
if (-not $report.ok) { exit 1 }
