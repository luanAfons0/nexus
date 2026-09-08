<#
    Remove the Tray from Windows. Run it from Windows:

      powershell.exe -NoProfile -ExecutionPolicy Bypass -File `
        \\wsl.localhost\<Distro>\<home>\.nexus\windows\uninstall-tray.ps1

    It removes exactly what install-tray.ps1 wrote and nothing else: the Tray
    Home, the Startup shortcut, and the Start Menu shortcut. It never reaches
    into the Nexus home, the Custom Root, or an Agent Home, and it leaves any
    live Web UI run exactly where it is - the Tray is a control surface, not
    the run.

    It names every path it removes, and every path it did not find.
#>
[CmdletBinding()]
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$trayHome  = Join-Path $env:LOCALAPPDATA 'Nexus\Tray'
$nexusRoot = Join-Path $env:LOCALAPPDATA 'Nexus'
$startup   = Join-Path ([Environment]::GetFolderPath('Startup')) 'Nexus Tray.lnk'
$startMenu = Join-Path ([Environment]::GetFolderPath('Programs')) 'Nexus Web UI.lnk'

# The Tray is the program being removed, so it stops here. A running copy is
# found by the one file it runs, and by nothing else on the machine.
$trayScript = Join-Path $trayHome 'nexus-tray.ps1'
$running = @(Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($trayScript) })
foreach ($process in $running) {
    try {
        Stop-Process -Id $process.ProcessId -Force
        Write-Output "stopped the running Tray (pid $($process.ProcessId))"
    } catch {
        Write-Output "could not stop the Tray (pid $($process.ProcessId)): $_"
    }
}
if ($running.Count -gt 0) {
    Write-Output "Its icon leaves the notification area when Windows next redraws it."
}

foreach ($path in $startup, $startMenu) {
    if (Test-Path -LiteralPath $path) {
        Remove-Item -LiteralPath $path -Force
        Write-Output "removed $path"
    } else {
        Write-Output "not present: $path"
    }
}

if (Test-Path -LiteralPath $trayHome) {
    Remove-Item -LiteralPath $trayHome -Recurse -Force
    Write-Output "removed $trayHome"
} else {
    Write-Output "not present: $trayHome"
}

# The installer made this directory to hold the Tray Home. Remove it only
# when it is empty, so anything else that has since claimed the name stays.
if ((Test-Path -LiteralPath $nexusRoot) -and
    -not (Get-ChildItem -LiteralPath $nexusRoot -Force)) {
    Remove-Item -LiteralPath $nexusRoot -Force
    Write-Output "removed $nexusRoot"
}

Write-Output ""
Write-Output "Nothing in the Nexus home, the Custom Root, or an Agent Home was touched."
Write-Output 'A live Web UI run is untouched: stop it with nexus ui --stop.'
