<#
    Install the Tray on Windows. Run it once, from Windows, from the Nexus
    home over \\wsl.localhost\:

      powershell.exe -NoProfile -ExecutionPolicy Bypass -File `
        \\wsl.localhost\<Distro>\<home>\.nexus\windows\install-tray.ps1

    It writes exactly two places outside the Nexus home (ADR 0007):

      1. the Tray Home, %LOCALAPPDATA%\Nexus\Tray, which holds a copy of the
         Tray, the opener, and the launch shim that starts either with no
         window;
      2. the user's own shortcut folders, which get a Startup shortcut that
         starts the Tray at logon and a Start Menu shortcut that opens the
         Web UI with `nexus ui --open`.

    It works out the distribution and the Nexus home from the path it is
    running from, so nothing here is hardcoded, no configuration file is
    written, and the Tray keeps working on another machine. The values reach
    the Tray as the arguments of the shortcut that starts it.

    Nothing inside the Nexus home, the Custom Root, or an Agent Home is
    touched. `uninstall-tray.ps1` removes exactly what this wrote.
#>
[CmdletBinding()]
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

function Get-TraySource {
    <#
        The distribution and the Nexus home, read out of the path this script
        is running from. The same reading the Tray itself does, kept here as
        its own copy so that neither script has to find a file beside it.
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

function New-Shortcut {
    param([string] $Path, [string] $Target, [string] $Arguments, [string] $Description)
    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut($Path)
    $link.TargetPath       = $Target
    $link.Arguments        = $Arguments
    $link.WorkingDirectory = Split-Path -Path $Target -Parent
    $link.Description      = $Description
    $link.Save()
}

$source = Get-TraySource -Path $PSCommandPath
if ($null -eq $source) {
    Write-Error ("Run this from the Nexus home over \\wsl.localhost\, so that " +
        "it can tell which distribution holds Nexus. It is at " +
        "\\wsl.localhost\<Distro>\<home>\.nexus\windows\install-tray.ps1.")
    exit 1
}

$here      = Split-Path -Path $PSCommandPath -Parent
$trayHome  = Join-Path $env:LOCALAPPDATA 'Nexus\Tray'
$startup   = Join-Path ([Environment]::GetFolderPath('Startup')) 'Nexus Tray.lnk'
$startMenu = Join-Path ([Environment]::GetFolderPath('Programs')) 'Nexus Web UI.lnk'

New-Item -ItemType Directory -Path $trayHome -Force | Out-Null
foreach ($file in 'nexus-tray.ps1', 'nexus-open.ps1', 'nexus-hidden.vbs') {
    Copy-Item -Path (Join-Path $here $file) -Destination $trayHome -Force
}
$shim = Join-Path $trayHome 'nexus-hidden.vbs'
$values = '-Distro "{0}" -NexusHome "{1}"' -f $source.Distro, $source.NexusHome

# The Tray runs from the Windows filesystem, so it can start and answer
# honestly while the distribution is down (ADR 0007). Only the shortcut
# knows which distribution to ask.
New-Shortcut -Path $startup -Target $shim `
    -Arguments "nexus-tray.ps1 $values" `
    -Description 'Nexus Tray'

# A door onto the Web UI that needs no Tray running at all.
New-Shortcut -Path $startMenu -Target $shim `
    -Arguments "nexus-open.ps1 $values" `
    -Description 'Open the Nexus Web UI'

Write-Output "Nexus Tray installed."
Write-Output "  distribution: $($source.Distro)"
Write-Output "  Nexus home:   $($source.NexusHome)"
Write-Output "  Tray Home:    $trayHome"
Write-Output "  Startup:      $startup"
Write-Output "  Start Menu:   $startMenu"
Write-Output ""
Write-Output "Nothing in the Nexus home, the Custom Root, or an Agent Home was touched."
Write-Output "Remove all of it with uninstall-tray.ps1."
Write-Output ""

# Start it now, so the icon is there before the next logon. It starts no Web
# UI run: it shows the state, it does not create it.
Start-Process -FilePath $shim -ArgumentList "nexus-tray.ps1 $values"

Write-Output "The icon is running now. On Windows 11 a new notification-area icon"
Write-Output "starts hidden: click the chevron (^) beside the clock and drag the"
Write-Output "Nexus icon out to keep it on the taskbar."
