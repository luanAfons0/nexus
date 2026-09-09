<#
    The Tray: the Windows notification-area client of the Nexus CLI.

    It shows whether a Web UI run is live and holds Open, Copy URL, Start,
    Stop, Open log, and Start at logon. It owns no state (ADR 0007). It
    never reads the Run File and never touches the Global Instructions, the
    Nexus Lock, or a Native Skill Root, and it opens no listener of its own.
    Its whole picture of the world is the two lines `nexus ui --status`
    prints, plus the failure of the call itself, and every action it takes
    is one `nexus ui` call through wsl.exe.

    It exists on Windows because WSLg hosts no notification area, so a client
    inside the distribution would have nowhere to appear.

    Launch it by hand:

      powershell.exe -NoProfile -ExecutionPolicy Bypass -File `
        \\wsl.localhost\<Distro>\<home>\.nexus\windows\nexus-tray.ps1

    Run from that path it works out the distribution and the Nexus home
    from its own path. Run from a copy on the Windows filesystem - which is
    how the installer runs it, so that a stopped distribution is still
    answerable - it cannot, so the shim passes -Distro and -NexusHome.
#>
[CmdletBinding()]
param(
    # The WSL distribution the Nexus home lives in, e.g. Debian.
    [string] $Distro,
    # The Nexus home as the distribution sees it, e.g. /home/luanh/.nexus.
    [string] $NexusHome
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# How long a call through wsl.exe may take before the Tray gives up on it.
# A poll is a question that has to stay cheap; an action may boot the
# distribution.
$script:PollTimeoutMs   = 15000
$script:ActionTimeoutMs = 120000
# The measured cost of one `nexus ui --status` through wsl.exe is 220-245 ms
# warm, which is what makes asking the CLI five seconds apart affordable and
# a second reader of the Run File unnecessary (ADR 0007).
$script:PollIntervalMs  = 5000

# --- where Nexus is -------------------------------------------------------

function Get-TraySource {
    <#
        The distribution and the Nexus home, read out of the path this
        script is running from, or $null when it says nothing about them.
        `\\wsl.localhost\Debian\home\luanh\.nexus\windows\nexus-tray.ps1`
        names both; a copy in the Tray Home names neither.
    #>
    param([string] $Path)

    if ([string]::IsNullOrEmpty($Path)) { return $null }
    if ($Path -notmatch '^\\\\wsl(?:\.localhost|\$)\\([^\\]+)\\(.+)$') { return $null }
    $posix = '/' + ($Matches[2] -replace '\\', '/')
    return [pscustomobject]@{
        Distro    = $Matches[1]
        NexusHome = ($posix -replace '/windows/[^/]+$', '')
    }
}

function Show-Fault {
    param([string] $Message)
    [System.Windows.Forms.MessageBox]::Show(
        $Message, 'Nexus', [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null
}

if (-not $Distro -or -not $NexusHome) {
    $source = Get-TraySource -Path $PSCommandPath
    if ($null -eq $source) {
        Show-Fault ("Nexus cannot tell which distribution to ask.`n`n" +
            "Run the Tray from the Nexus home over \\wsl.localhost\, or pass " +
            "-Distro and -NexusHome.")
        exit 2
    }
    if (-not $Distro)    { $Distro    = $source.Distro }
    if (-not $NexusHome) { $NexusHome = $source.NexusHome }
}

# Every action is one of these; the Tray runs no other program in the
# distribution.
$script:NexusCli = "$NexusHome/scripts/nexus"

# --- talking to the distribution ------------------------------------------

function ConvertTo-CommandArgument {
    <#
        One argument for a command line built as a string, because Windows
        PowerShell 5.1 has no ProcessStartInfo.ArgumentList. The arguments
        here are a distribution name and POSIX paths, so quoting the ones
        that hold a space is the whole job.
    #>
    param([string] $Value)
    if ($Value -match '[\s"]') { return '"' + ($Value -replace '"', '\"') + '"' }
    return $Value
}

function Invoke-Child {
    <#
        Run one program with no window at all - no console flashes on any
        poll and none on any action - and return its exit code and output.
        A program that outstays the timeout is killed and reported as a
        failure, so a wedged call can never freeze the icon for good.
    #>
    param(
        [string]   $FilePath,
        [string[]] $Arguments,
        [int]      $TimeoutMs
    )

    $line = ($Arguments | ForEach-Object { ConvertTo-CommandArgument $_ }) -join ' '
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName               = $FilePath
    $psi.Arguments              = $line
    $psi.UseShellExecute        = $false
    $psi.CreateNoWindow         = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError  = $true
    # wsl.exe writes its own listings in UTF-16 and passes a Linux program's
    # bytes through untouched. Reading everything as UTF-8 and dropping NULs
    # reads both correctly for the ASCII this Tray looks at.
    $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $psi.StandardErrorEncoding  = [System.Text.Encoding]::UTF8

    try {
        $child = [System.Diagnostics.Process]::Start($psi)
    } catch {
        return [pscustomobject]@{ ExitCode = -1; StdOut = ''; StdErr = "$_" }
    }
    # Read both pipes while the child runs: a child that fills one and waits
    # would otherwise never reach the timeout check below.
    $out = $child.StandardOutput.ReadToEndAsync()
    $err = $child.StandardError.ReadToEndAsync()
    if (-not $child.WaitForExit($TimeoutMs)) {
        try { $child.Kill() } catch { }
        try { $child.WaitForExit(5000) | Out-Null } catch { }
        return [pscustomobject]@{ ExitCode = -1; StdOut = ''; StdErr = 'timed out' }
    }
    return [pscustomobject]@{
        ExitCode = $child.ExitCode
        StdOut   = ($out.Result -replace "`0", '')
        StdErr   = ($err.Result -replace "`0", '')
    }
}

function Invoke-Nexus {
    <#
        One `nexus ui` call in the distribution. This is the only way the Tray
        reaches Nexus at all: it reads no file of its own (ADR 0007).
    #>
    param([string[]] $NexusArguments, [int] $TimeoutMs = $script:PollTimeoutMs)
    $argv = @('-d', $Distro, '--', $script:NexusCli, 'ui') + $NexusArguments
    return Invoke-Child -FilePath 'wsl.exe' -Arguments $argv -TimeoutMs $TimeoutMs
}

function Test-DistroRunning {
    <#
        True when Windows already has the distribution running. The Tray asks
        this before it asks Nexus anything, because `wsl.exe -d <distribution>`
        boots a stopped distribution: the Tray shows the state, it does not
        create it, and logging in must cost no distribution boot.
    #>
    $result = Invoke-Child -FilePath 'wsl.exe' `
        -Arguments @('--list', '--running', '--quiet') -TimeoutMs $script:PollTimeoutMs
    if ($result.ExitCode -ne 0) { return $false }
    foreach ($name in ($result.StdOut -split "`r?`n")) {
        if ($name.Trim() -eq $Distro) { return $true }
    }
    return $false
}

# --- the state ------------------------------------------------------------

# running, stopped, or unavailable, and the URL of the live run. The URL is
# held in memory for as long as the run lives and is written to no file on
# the Windows side: it carries the Run Token.
$script:State = 'unavailable'
$script:Url   = $null
$script:Port  = $null
# Set by the Tray's own Stop, so that a stop the user asked for is silent.
$script:StopAsked = $false

function Read-RunState {
    <#
        The state, from the two lines `nexus ui --status` prints and from the
        failure of the call itself:

          nexus ui: <url>        running
          nexus ui: not running  stopped
          the call fails         unavailable

        Watching is always --status and never --open, so looking at the state
        can never start a run the user did not ask for.
    #>
    if (-not (Test-DistroRunning)) {
        return [pscustomobject]@{ State = 'unavailable'; Url = $null; Port = $null }
    }
    $result = Invoke-Nexus -NexusArguments @('--status')
    if ($result.ExitCode -ne 0) {
        return [pscustomobject]@{ State = 'unavailable'; Url = $null; Port = $null }
    }
    $line = ($result.StdOut -split "`r?`n")[0]
    if ($null -ne $line) { $line = $line.Trim() }
    if ($line -match '^nexus ui: (http://127\.0\.0\.1:(\d+)/t/[0-9a-f]{32}/)$') {
        return [pscustomobject]@{ State = 'running'; Url = $Matches[1]; Port = $Matches[2] }
    }
    if ($line -eq 'nexus ui: not running') {
        return [pscustomobject]@{ State = 'stopped'; Url = $null; Port = $null }
    }
    return [pscustomobject]@{ State = 'unavailable'; Url = $null; Port = $null }
}

function Get-HandshakeUrl {
    <#
        The URL out of a handshake line. `--open` and `--no-open` both print
        the same one line, so one reader serves both and neither needs the
        exit code read for meaning it does not carry.
    #>
    param([string] $Text)
    if ([string]::IsNullOrEmpty($Text)) { return $null }
    foreach ($line in ($Text -split "`r?`n")) {
        if ($line.Trim() -match '^nexus ui: (http://127\.0\.0\.1:\d+/t/[0-9a-f]{32}/)$') {
            return $Matches[1]
        }
    }
    return $null
}

# --- the icon -------------------------------------------------------------

function New-StateIcon {
    <#
        One icon, drawn here rather than shipped, so the repository holds no
        binary asset. Three are made at startup and kept for the life of the
        process; nothing draws one per poll.
    #>
    param([System.Drawing.Color] $Color)
    $bitmap = New-Object System.Drawing.Bitmap 16, 16
    $canvas = [System.Drawing.Graphics]::FromImage($bitmap)
    $canvas.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $canvas.Clear([System.Drawing.Color]::Transparent)
    $fill = New-Object System.Drawing.SolidBrush $Color
    $edge = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(140, 0, 0, 0)), 1
    $canvas.FillEllipse($fill, 1, 1, 14, 14)
    $canvas.DrawEllipse($edge, 1, 1, 13, 13)
    $fill.Dispose(); $edge.Dispose(); $canvas.Dispose()
    $icon = [System.Drawing.Icon]::FromHandle($bitmap.GetHicon())
    $bitmap.Dispose()
    return $icon
}

$script:Icons = @{
    running     = New-StateIcon ([System.Drawing.Color]::FromArgb(46, 160, 67))
    stopped     = New-StateIcon ([System.Drawing.Color]::FromArgb(130, 134, 139))
    unavailable = New-StateIcon ([System.Drawing.Color]::FromArgb(219, 154, 4))
}

function Get-Tooltip {
    param([string] $State, [string] $Port)
    switch ($State) {
        'running' { return "Nexus - running (port $Port)" }
        'stopped' { return 'Nexus - stopped' }
        default   { return 'Nexus - WSL not available' }
    }
}

# --- start at logon -------------------------------------------------------

function Get-StartupShortcutPath {
    # The one shortcut the installer wrote into the user's Startup folder.
    return Join-Path ([Environment]::GetFolderPath('Startup')) 'Nexus Tray.lnk'
}

function Get-TrayShimPath {
    # The shim beside this script, which starts it with no window. An
    # installed Tray has one; a Tray run straight from the Nexus home has
    # none, and so cannot write the shortcut.
    return Join-Path $PSScriptRoot 'nexus-hidden.vbs'
}

function Set-StartAtLogon {
    <#
        Write or remove the Startup shortcut, so that the autostart can be
        turned off without editing a shortcut by hand. It is the same
        shortcut, to the same shim, with the same arguments the installer
        wrote: the distribution and the Nexus home live in it and in no
        configuration file.
    #>
    param([bool] $Enabled)
    $path = Get-StartupShortcutPath
    if (-not $Enabled) {
        if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
        return
    }
    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut($path)
    $link.TargetPath       = Get-TrayShimPath
    $link.Arguments        = ('nexus-tray.ps1 -Distro "{0}" -NexusHome "{1}"' -f $Distro, $NexusHome)
    $link.WorkingDirectory = $PSScriptRoot
    $link.Description      = 'Nexus Tray'
    $link.Save()
}

# --- one instance ---------------------------------------------------------

# A second launch must not add a second icon. The mutex is checked before
# anything is shown, so the second process leaves at once and silently.
$created = $false
$script:Instance = New-Object System.Threading.Mutex($true, 'Local\NexusTray', [ref] $created)
if (-not $created) { exit 0 }

# --- the tray -------------------------------------------------------------

[System.Windows.Forms.Application]::EnableVisualStyles()

$menu = New-Object System.Windows.Forms.ContextMenuStrip
# Open first and bold: the most common action is the one that answers "I
# closed the tab and lost the link", and it is what a double-click does.
$openItem  = $menu.Items.Add('Open Nexus UI')
$openItem.Font = New-Object System.Drawing.Font($menu.Font, [System.Drawing.FontStyle]::Bold)
$copyItem  = $menu.Items.Add('Copy URL')
$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null
$startItem = $menu.Items.Add('Start')
$stopItem  = $menu.Items.Add('Stop')
$logItem   = $menu.Items.Add('Open log')
$logonItem = $menu.Items.Add('Start at logon')
$logonItem.Checked = (Test-Path -LiteralPath (Get-StartupShortcutPath))
# Only an installed Tray can write the shortcut, because only it has the
# shim the shortcut must point at.
$logonItem.Enabled = (Test-Path -LiteralPath (Get-TrayShimPath))
$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null
$quitItem  = $menu.Items.Add('Quit')

$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = $script:Icons['unavailable']
$tray.Text = Get-Tooltip 'unavailable' $null
$tray.ContextMenuStrip = $menu
$tray.Visible = $true

$context = New-Object System.Windows.Forms.ApplicationContext

function Update-State {
    <#
        Ask once and show the answer. A balloon fires only where a run ended
        without being asked to: a stop the user asked for is their own choice
        and is never reported back to them as an event.
    #>
    $previous = $script:State
    $reading = Read-RunState
    $script:State = $reading.State
    $script:Url   = $reading.Url
    $script:Port  = $reading.Port

    $tray.Icon = $script:Icons[$script:State]
    $tray.Text = Get-Tooltip $script:State $script:Port

    # Never offer Stop when nothing is running, and never offer a URL there
    # is no run to reach. Start is offered in the stopped and unavailable
    # states alike: starting from unavailable boots the distribution
    # first, which is exactly what the user asked for.
    $stopItem.Visible  = ($script:State -eq 'running')
    $startItem.Visible = ($script:State -ne 'running')
    $copyItem.Enabled  = ($script:State -eq 'running')

    if ($previous -eq 'running' -and $script:State -ne 'running') {
        if (-not $script:StopAsked) {
            $tray.BalloonTipTitle = 'Nexus'
            $tray.BalloonTipText  = 'The Web UI run ended.'
            $tray.BalloonTipIcon  = [System.Windows.Forms.ToolTipIcon]::Info
            $tray.ShowBalloonTip(5000)
        }
        $script:StopAsked = $false
    }
}

function Invoke-Open {
    <#
        `nexus ui --open` is one call that is correct whether or not a run is
        live: it opens the recorded run, or starts one and opens that. The
        URL it prints is what reaches the Windows default browser here,
        because the opener inside the distribution has no Windows desktop
        to reach.
    #>
    $result = Invoke-Nexus -NexusArguments @('--open') -TimeoutMs $script:ActionTimeoutMs
    $url = Get-HandshakeUrl $result.StdOut
    if ($null -eq $url) {
        Show-Fault ("Nexus could not open the Web UI.`n`n" + $result.StdErr.Trim())
    } else {
        try { Start-Process $url } catch { Show-Fault "Nexus could not open $url" }
    }
    Update-State
}

function Invoke-Start {
    <#
        A run, and no page. --no-open, because the user who asks for Start
        asked for a listener, not for a browser window; Open is the item that
        puts the page in front of them.
    #>
    $result = Invoke-Nexus -NexusArguments @('--no-open') -TimeoutMs $script:ActionTimeoutMs
    if ($null -eq (Get-HandshakeUrl $result.StdOut)) {
        Show-Fault ("Nexus could not start the Web UI.`n`n" + $result.StdErr.Trim())
    }
    Update-State
}

function Invoke-Stop {
    <#
        The same request the page's `Stop server` button sends and the same
        `nexus ui --stop` a terminal sends, so the three doors cannot
        disagree about what stopping means. The Tray remembers that it asked,
        so the poll that finds the run gone stays silent: a stop the user
        asked for is never reported back to them as an event.
    #>
    $script:StopAsked = $true
    $result = Invoke-Nexus -NexusArguments @('--stop') -TimeoutMs $script:ActionTimeoutMs
    if ($result.ExitCode -ne 0) {
        $script:StopAsked = $false
        Show-Fault ("Nexus could not stop the Web UI.`n`n" + $result.StdErr.Trim())
    }
    Update-State
}

function Invoke-CopyUrl {
    <#
        The live run's URL, Run Token and all, on the clipboard. That is the
        one place the token goes on the Windows side, and it goes there
        because the user asked: it is written to no file.
    #>
    if ([string]::IsNullOrEmpty($script:Url)) { return }
    try {
        [System.Windows.Forms.Clipboard]::SetText($script:Url)
    } catch {
        Show-Fault "Nexus could not reach the clipboard."
    }
}

function Invoke-OpenLog {
    <#
        A Detached Run has no terminal to complain to, so its diagnostics go
        to ui.log in the Nexus home. The Tray hands the path to Windows and
        reads nothing itself.
    #>
    $path = "\\wsl.localhost\$Distro" + ($NexusHome -replace '/', '\') + '\ui.log'
    try {
        Start-Process $path
    } catch {
        Show-Fault ("Nexus could not open the log.`n`n" + $path)
    }
}

$openItem.Add_Click({ Invoke-Open })
$copyItem.Add_Click({ Invoke-CopyUrl })
$startItem.Add_Click({ Invoke-Start })
$stopItem.Add_Click({ Invoke-Stop })
$logItem.Add_Click({ Invoke-OpenLog })
$logonItem.Add_Click({
    try {
        Set-StartAtLogon (-not $logonItem.Checked)
    } catch {
        Show-Fault ("Nexus could not change the Startup shortcut.`n`n" + $_)
    }
    $logonItem.Checked = (Test-Path -LiteralPath (Get-StartupShortcutPath))
})
# One gesture for the most common action.
$tray.Add_DoubleClick({ Invoke-Open })

$quitItem.Add_Click({
    # Hide and dispose before the context exits, or a dead icon lingers in
    # the notification area until someone hovers it. Quitting the control
    # surface closes no run: it never closes the Web UI behind the user's
    # back.
    $timer.Stop()
    $tray.Visible = $false
    $tray.Dispose()
    $context.ExitThread()
})

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = $script:PollIntervalMs
$timer.Add_Tick({ Update-State })

Update-State
$timer.Start()

try {
    [System.Windows.Forms.Application]::Run($context)
} finally {
    $timer.Dispose()
    $tray.Dispose()
    foreach ($icon in $script:Icons.Values) { $icon.Dispose() }
    $script:Instance.ReleaseMutex()
    $script:Instance.Dispose()
}
