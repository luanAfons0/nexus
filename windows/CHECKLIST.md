# The Tray: manual checklist

The Tray has **no automated coverage**. It is Windows PowerShell and runs on
the host; the suite is bash and runs in the distribution, so it can assert only
that these files ship. Nothing below is checked by `tests/run.sh` (ADR 0007).

Walk this list on the host after any change under `windows/`, and record the
date and the build you walked it on. Everything here is done from Windows,
with one shell open in the distribution for the steps that say so.

Replace `<Distro>` and `<home>` with your own throughout.

## Install

- [ ] `powershell.exe -NoProfile -ExecutionPolicy Bypass -File \\wsl.localhost\<Distro>\<home>\.nexus\windows\install-tray.ps1`
      prints the distribution, the Nexus home, the Tray Home, and both
      shortcut paths, and exits without an error.
- [ ] `%LOCALAPPDATA%\Nexus\Tray` holds `nexus-tray.ps1`, `nexus-open.ps1`,
      and `nexus-hidden.vbs`, and nothing else.
- [ ] The Startup folder holds `Nexus Tray.lnk` and the Start Menu holds
      `Nexus Web UI.lnk`.
- [ ] Nothing was written in the Nexus home, the Custom Root
      (`~/.custom-skills`), or an Agent Home (`~/.claude`, `~/.codex`):
      `git -C ~/.nexus status` is clean and `ls -l ~/.custom-skills` is
      unchanged.
- [ ] The icon appears. On Windows 11 a new notification-area icon starts
      hidden: click the chevron (^) beside the clock, and drag the Nexus icon
      onto the taskbar to keep it there.
- [ ] No console window appeared at any point.

## The state it shows

- [ ] With no run, the icon is grey and the tooltip reads `Nexus - stopped`.
- [ ] `Start` turns it colored within one poll (five seconds), and the
      tooltip reads `Nexus - running (port N)`.
- [ ] The port in the tooltip is the port in `nexus ui --status` in the
      distribution.
- [ ] Starting a run from a shell in the distribution turns the icon colored within
      five seconds, without touching the Tray.
- [ ] Stopping it from that shell turns the icon grey within five seconds.
- [ ] `wsl.exe --terminate <Distro>` turns the icon amber, and the tooltip
      reads `Nexus - WSL not available`. The Tray never claims a run is live
      while it cannot ask.
- [ ] While the distribution is down, the Tray keeps running and keeps
      answering: it does not boot the distribution to poll.

## The menu

- [ ] Right-click shows: Open Nexus UI (bold), Copy URL, Stop or Start,
      Open log, Start at logon, Quit.
- [ ] `Stop` is offered only when a run is live; `Start` only when it is not.
- [ ] `Copy URL` is greyed out when no run is live.
- [ ] With a run live, **Open Nexus UI** reaches the page in the Windows
      default browser, and the page is the live run: `nexus ui --status` in
      the distribution prints the same URL, and the Run File's pid is unchanged.
- [ ] With no run live, **Open Nexus UI** starts one and reaches the page.
- [ ] Double-clicking the icon does the same as Open Nexus UI.
- [ ] **Copy URL** puts the live URL, Run Token and all, on the clipboard.
- [ ] **Start** from the amber state boots the distribution and ends with a
      live run.
- [ ] **Stop** turns the icon grey, and the port stops answering.
- [ ] **Open log** opens `~/.nexus/ui.log` from the Nexus home.
- [ ] No console window appears for any of these.

## The balloon

- [ ] Kill a run from the distribution without asking the Tray
      (`nexus ui --stop` in a shell, or `kill` the run): one balloon appears
      within one poll.
- [ ] Stop a run from the Tray's own `Stop`: **no** balloon appears.

## One instance, and going away

- [ ] Launching the Tray a second time adds no second icon.
- [ ] `Quit` removes the icon at once - it does not linger until it is
      hovered.
- [ ] A run that was live before `Quit` is still live afterwards:
      `nexus ui --status` still prints its URL.

## Logon

- [ ] Log out and back in: the icon is there, no console flashed, and
      `nexus ui --status` says `not running` - the Tray started no run and
      the distribution was not booted for it.
- [ ] `Start at logon` unchecked removes `Nexus Tray.lnk` from the Startup
      folder; checked again writes it back.

## The Start Menu shortcut

- [ ] Quit the Tray, then open `Nexus Web UI` from the Start Menu: the Web UI
      opens in the default browser, with no Tray running and no console
      window.

## Uninstall

- [ ] `powershell.exe -NoProfile -ExecutionPolicy Bypass -File \\wsl.localhost\<Distro>\<home>\.nexus\windows\uninstall-tray.ps1`
      names every path it removed.
- [ ] `%LOCALAPPDATA%\Nexus`, `Nexus Tray.lnk`, and `Nexus Web UI.lnk` are
      all gone.
- [ ] The Nexus home, the Custom Root, and both Agent Homes are untouched.
- [ ] A run that was live before the uninstall is still live afterwards.
