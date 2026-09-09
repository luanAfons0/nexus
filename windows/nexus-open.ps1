<#
    Open the Web UI from Windows, with no Tray in the picture: the Start Menu
    shortcut points here through the shim.

    It is one `nexus ui --open` call and nothing else. That call opens a
    browser inside the distribution, and a distribution has no Windows
    desktop to open one on, so the URL of its handshake line is what reaches
    the Windows default browser here. Whether a run was already live or this
    call started one, the handshake line has the same shape and the page ends
    up in front of the user either way.
#>
[CmdletBinding()]
param(
    # The WSL distribution the Nexus home lives in, e.g. Debian.
    [Parameter(Mandatory = $true)] [string] $Distro,
    # The Nexus home as the distribution sees it, e.g. /home/luanh/.nexus.
    [Parameter(Mandatory = $true)] [string] $NexusHome
)

Set-StrictMode -Version 2.0

# The shim started this with no window, so the call below inherits that and
# flashes nothing of its own.
$output = & wsl.exe -d $Distro -- "$NexusHome/scripts/nexus" ui --open 2>&1

foreach ($line in $output) {
    if ("$line".Trim() -match '^nexus ui: (http://127\.0\.0\.1:\d+/t/[0-9a-f]{32}/)$') {
        Start-Process $Matches[1]
        exit 0
    }
}

# No handshake line means no page to open. Say so once, with what the CLI
# said, rather than failing where nobody can see it.
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.MessageBox]::Show(
    ("Nexus could not open the Web UI.`n`n" + (($output | ForEach-Object { "$_" }) -join "`n")),
    'Nexus', [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null
exit 1
