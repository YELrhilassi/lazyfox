# Lazyfox one-line installer (Windows).
#
#   irm https://github.com/YELrhilassi/lazyfox/releases/latest/download/install.ps1 | iex
#
# It downloads the installer for this machine and runs it. Everything after that
# is the installer's own window — this script only fetches and launches it, so
# there is no PowerShell logic that can half-install something.
#
# Options (environment variables, because the script may be piped):
#   $env:LAZYFOX_CHANNEL = 'nightly'   rolling nightly build (Developer Edition / Nightly)
#   $env:LAZYFOX_REPO    = 'owner/name' use a fork's releases
#   $env:LAZYFOX_DIR     = 'C:\some\dir' download there instead of %TEMP%
#   $env:LAZYFOX_NO_RUN  = '1'         download only, print the path, do not run
#
# About the Windows warning: the installer is not code-signed yet, so SmartScreen
# may show "Windows protected your PC". That flag is triggered by the
# Mark-of-the-Web (the "downloaded from the internet" tag) plus an unknown
# publisher, NOT by anything the installer does. This script removes the
# Mark-of-the-Web with Unblock-File before running, which clears the SmartScreen
# gate. If Defender still flags it, verify the SHA-256 printed below against the
# release notes before allowing it.

$ErrorActionPreference = 'Stop'

function Install-Lazyfox {
    $repo = if ($env:LAZYFOX_REPO) { $env:LAZYFOX_REPO } else { 'YELrhilassi/lazyfox' }
    $channel = if ($env:LAZYFOX_CHANNEL) { $env:LAZYFOX_CHANNEL } else { 'stable' }

    $arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
    if ($arch -ne 'X64' -and $arch -ne 'Arm64') {
        throw "unsupported CPU: $arch (a windows/amd64 installer can still run on Arm64 Windows)"
    }

    if ($channel -eq 'nightly') {
        $asset = 'lazyfox-install-dev-windows.exe'
        $url = "https://github.com/$repo/releases/download/nightly/$asset"
    } else {
        $asset = 'lazyfox-install-windows.exe'
        $url = "https://github.com/$repo/releases/latest/download/$asset"
    }

    $dir = if ($env:LAZYFOX_DIR) { $env:LAZYFOX_DIR } else { $env:TEMP }
    $target = Join-Path $dir $asset

    Write-Host 'Lazyfox installer'
    Write-Host "  channel : $channel"
    Write-Host "  machine : windows/$($arch.ToString().ToLower())"
    Write-Host "  from    : $url"

    Write-Host '  downloading...'
    Invoke-WebRequest -Uri $url -OutFile $target -UseBasicParsing

    if (-not (Test-Path $target) -or (Get-Item $target).Length -eq 0) {
        throw 'downloaded file is empty'
    }

    # Strip the Mark-of-the-Web so SmartScreen does not gate the launch. This is
    # the whole reason the one-liner exists: running the same .exe straight out
    # of a browser download is what shows "Windows protected your PC".
    Unblock-File -Path $target

    $sha = (Get-FileHash -Path $target -Algorithm SHA256).Hash.ToLower()
    Write-Host "  sha256  : $sha"
    Write-Host ''

    if ($env:LAZYFOX_NO_RUN -eq '1') {
        Write-Host "Downloaded: $target"
        return
    }

    Write-Host 'The installer window is opening. If Windows Defender still warns, it is'
    Write-Host 'because the build is unsigned — compare the sha256 above with the release'
    Write-Host 'notes, then choose "More info" > "Run anyway".'
    Write-Host ''

    # The installer elevates itself with UAC only when it needs to write the
    # Firefox installation folder, so we do not pre-elevate here.
    & $target
}

Install-Lazyfox
