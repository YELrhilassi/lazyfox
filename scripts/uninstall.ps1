param(
  [string]$Profile = "",
  [switch]$RemoveChromeLoader,
  [switch]$KeepExtensionDisabledOnly,
  [string]$FirefoxDir = ""
)

# Lazyfox uninstaller for Windows.
#
# Removes everything scripts/install.ps1 put in place, and nothing else:
#   - profile/chrome/userChrome.css, userChrome.uc.js, frame.js
#   - the Lazyfox-managed user_pref(...) lines from profile/user.js
#   - profile/extensions/lazyfox@lazyfox.dev.xpi
#   - the Lazyfox entry in extensions.json (the add-on is marked removed)
#
# Your Firefox profile, bookmarks, history, passwords and other add-ons are
# NEVER touched. Every file we delete is backed up first as
# "<name>.lazyfox.uninst.bak-<timestamp>" so you can roll back by hand if
# anything goes wrong.
#
# The fx-autoconfig chrome loader (config.js + defaults/pref/config-prefs.js
# in the Firefox install dir) is only removed with -RemoveChromeLoader, because
# other userChrome.uc.js-based add-ons may be using it. It needs admin rights.

$ErrorActionPreference = "Stop"

function Write-Step { param([string]$Msg) Write-Host "==> $Msg" -ForegroundColor Cyan }
function Write-Warn  { param([string]$Msg) Write-Host "WARNING: $Msg" -ForegroundColor Yellow }
function Write-Note  { param([string]$Msg) Write-Host "NOTE: $Msg" -ForegroundColor DarkGray }

function Find-FirefoxExe {
  $candidates = @(
    "$env:ProgramFiles\Firefox Developer Edition\firefox.exe",
    "$env:ProgramFiles\Mozilla Firefox Developer Edition\firefox.exe",
    "$env:ProgramFiles\Mozilla Firefox\firefox.exe",
    "${env:ProgramFiles(x86)}\Mozilla Firefox\firefox.exe"
  )
  foreach ($c in $candidates) { if (Test-Path -LiteralPath $c) { return $c } }
  return ""
}

function Test-IsAdmin {
  try {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $p = New-Object Security.Principal.WindowsPrincipal($id)
    return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  }
  catch { return $false }
}

function Backup-ThenRemove {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return $false }
  $bak = "$Path.lazyfox.uninst.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  try {
    Copy-Item -LiteralPath $Path -Destination $bak -Force
    Write-Note "backed up -> $bak"
  } catch {
    Write-Warn "could not back up $Path (continuing): $_"
  }
  Remove-Item -Force -LiteralPath $Path -ErrorAction SilentlyContinue
  return $true
}

function Stop-FirefoxForProfile {
  param([string]$ProfileDir)
  $escaped = [regex]::Escape($ProfileDir)
  $procs = Get-CimInstance Win32_Process -Filter "Name = 'firefox.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match $escaped }
  foreach ($proc in $procs) {
    Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
  }
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$firefoxData = Join-Path $env:APPDATA "Mozilla\Firefox"
$profilesIni = Join-Path $firefoxData "profiles.ini"
$profilesBase = Join-Path $firefoxData "Profiles"

function Resolve-ProfilePath {
  param([string]$IniPath, [string]$BaseDir)
  $profiles = @()
  if (Test-Path -LiteralPath $IniPath) {
    $ini = Get-Content -LiteralPath $IniPath
    for ($i = 0; $i -lt $ini.Count; $i++) {
      if ($ini[$i] -match '^\[(Profile\d+)\]$') {
        $name = $matches[1]
        $isDefault = $false; $path = ""
        for ($j = $i + 1; $j -lt $ini.Count; $j++) {
          if ($ini[$j] -match '^\[') { break }
          if ($ini[$j] -match '^Default=1$') { $isDefault = $true }
          if ($ini[$j] -match '^Path=(.+)$') { $path = $matches[1] }
        }
        if ($path) {
          $profiles += [PSCustomObject]@{
            Name = $name; IsDefault = $isDefault
            IsDevEdition = ($name -match 'dev-edition') -or ($path -match 'dev-edition')
            FullPath = if ([System.IO.Path]::IsPathRooted($path)) { $path } else { Join-Path (Split-Path -Parent $IniPath) $path }
          }
        }
      }
    }
  }
  $dev = $profiles | Where-Object { $_.IsDevEdition } | Select-Object -First 1
  if ($dev) { return $dev.FullPath }
  $def = $profiles | Where-Object { $_.IsDefault } | Select-Object -First 1
  if ($def) { return $def.FullPath }
  $any = Get-ChildItem -LiteralPath $BaseDir -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match "\.default" } | Select-Object -First 1
  if ($any) { return $any.FullName }
  return ""
}

if ($Profile) { $profileDir = $Profile } else { $profileDir = Resolve-ProfilePath $profilesIni $profilesBase }

if (-not $profileDir -or -not (Test-Path -LiteralPath $profileDir)) {
  Write-Host "Could not find a Firefox profile automatically."
  Write-Host "Run:  powershell -ExecutionPolicy Bypass -File .\scripts\uninstall.ps1 -Profile `"C:\path\to\profile`""
  exit 1
}

Write-Step "Profile: $profileDir"

# Firefox locks files when running. We can still edit chrome/* and user.js even
# with it running, but the .xpi is locked and extensions.json must not be
# rewritten while Firefox is alive (its in-memory copy would overwrite ours).
$lockFile = Join-Path $profileDir "lock"
$ffRunning = Test-Path -LiteralPath $lockFile
if ($ffRunning) {
  Write-Note "Firefox appears to be running with this profile. The .xpi and extensions.json"
  Write-Note "cannot be updated while it runs. Quit Firefox fully and re-run this uninstaller,"
  Write-Note "or pass nothing and the script will remove what it can now."
}

# ---------- profile/chrome/* ----------
$chromeDir = Join-Path $profileDir "chrome"
foreach ($f in @("userChrome.css", "userChrome.uc.js", "frame.js", "corebootstrap.js")) {
  $p = Join-Path $chromeDir $f
  if (Test-Path -LiteralPath $p) {
    Backup-ThenRemove $p | Out-Null
    Write-Step "Removed chrome\$f"
  }
}
# Leave the chrome/ dir itself - other add-ons may live in it.
if (Test-Path -LiteralPath $chromeDir) {
  $leftover = Get-ChildItem -LiteralPath $chromeDir -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -notmatch '\.lazyfox\.uninst\.bak-' }
  if (-not $leftover) {
    Write-Note "chrome/ folder is now empty (only Lazyfox backups remain); leaving it in place."
  }
}

# ---------- user.js : drop only our managed prefs ----------
$managed = @{}
$ourContent = Get-Content -LiteralPath (Join-Path $repoRoot "dist\chrome\user.js")
foreach ($line in $ourContent) {
  if ($line -match '^user_pref\("([^"]+)"') { $managed[$matches[1]] = $true }
}

$userJs = Join-Path $profileDir "user.js"
if (Test-Path -LiteralPath $userJs) {
  $kept = Get-Content -LiteralPath $userJs | Where-Object {
    if ($_ -match '^user_pref\("([^"]+)"') { -not $managed.ContainsKey($matches[1]) } else { $true }
  }
  $bak = "$userJs.lazyfox.uninst.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  Copy-Item -LiteralPath $userJs -Destination $bak -Force
  Write-Note "backed up -> $bak"
  $utf8NoBom = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllLines($userJs, @($kept), $utf8NoBom)
  Write-Step "Removed Lazyfox prefs from user.js (other prefs kept)"
} else {
  Write-Note "no user.js in profile - nothing to clean there"
}

# ---------- extensions/lazyfox@lazyfox.dev.xpi ----------
$xpi = Join-Path $profileDir "extensions\lazyfox@lazyfox.dev.xpi"
if (Test-Path -LiteralPath $xpi) {
  if ($ffRunning) {
    Write-Warn ".xpi is locked (Firefox is running). Quit Firefox and re-run to remove it."
  } else {
    Backup-ThenRemove $xpi | Out-Null
    Write-Step "Removed extension lazyfox@lazyfox.dev.xpi"
  }
}

# ---------- extensions.json : mark our add-on as removed ----------
if (-not $KeepExtensionDisabledOnly) {
  $extJson = Join-Path $profileDir "extensions.json"
  if (Test-Path -LiteralPath $extJson) {
    if ($ffRunning) {
      Write-Warn "extensions.json not touched (Firefox is running). It will be cleaned on next start anyway."
    } else {
      try {
        $bak = "$extJson.lazyfox.uninst.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
        Copy-Item -LiteralPath $extJson -Destination $bak -Force
        Write-Note "backed up -> $bak"
        $json = Get-Content -Raw -LiteralPath $extJson | ConvertFrom-Json
        $remaining = @()
        foreach ($a in $json.addons) {
          if ($a.id -eq "lazyfox@lazyfox.dev") {
            $a.active = $false
            $a.visible = $false
            $a.userDisabled = $true
            # Keep the entry so about:addons can still be opened; Firefox will
            # garbage-collect it once the .xpi is gone.
          }
          $remaining += $a
        }
        $json.addons = $remaining
        $utf8NoBom = New-Object System.Text.UTF8Encoding $false
        [System.IO.File]::WriteAllText($extJson, ($json | ConvertTo-Json -Depth 20), $utf8NoBom)
        Write-Step "Marked Lazyfox disabled in extensions.json"
      } catch {
        Write-Warn "could not edit extensions.json (continuing): $_"
      }
    }
  }
}

# ---------- optional: chrome loader in Firefox install dir ----------
if ($RemoveChromeLoader) {
  if (-not $FirefoxDir) {
    $ff = Find-FirefoxExe
    if ($ff) { $FirefoxDir = Split-Path -Parent $ff }
  }
  if (-not $FirefoxDir -or -not (Test-Path -LiteralPath $FirefoxDir)) {
    Write-Warn "Could not find the Firefox installation folder; skipping chrome-loader removal."
    Write-Warn "Pass -FirefoxDir `"C:\Program Files\Firefox Developer Edition`" to target it."
  } else {
    $cfg = Join-Path $FirefoxDir "config.js"
    $pref = Join-Path $FirefoxDir "defaults\pref\config-prefs.js"
    $needAdmin = ((Test-Path -LiteralPath $cfg) -and -not (Test-IsAdmin))
    if ($needAdmin) {
      Write-Step "Removing the chrome loader needs admin rights."
      $args = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -RemoveChromeLoader -FirefoxDir `"$FirefoxDir`" -Profile `"$profileDir`" -KeepExtensionDisabledOnly"
      $p = Start-Process -FilePath "powershell.exe" -ArgumentList $args -Verb RunAs -Wait -PassThru
      if ($p.ExitCode -eq 0) { Write-Step "Chrome loader removed from $FirefoxDir" }
      else { Write-Warn "admin elevation failed; remove by hand: $cfg , $pref" }
    } else {
      try { if (Test-Path -LiteralPath $cfg)  { Backup-ThenRemove $cfg  | Out-Null; Write-Step "Removed $cfg"  } } catch {}
      try { if (Test-Path -LiteralPath $pref) { Backup-ThenRemove $pref | Out-Null; Write-Step "Removed $pref" } } catch {}
    }
  }
} else {
  Write-Note "Chrome loader (config.js in the Firefox install dir) was left in place."
  Write-Note "Re-run with -RemoveChromeLoader to also remove it (needs admin rights once)."
}

# ---------- leftover lazyfox.* prefs (best effort) ----------
# Some prefs the extension itself wrote (lazyfox.chrome.bindings / .chrome.config /
# lazyfox.hoverReveal). They are harmless without the add-on, but we'll mention them.
try {
  $prefsJs = Join-Path $profileDir "prefs.js"
  if (Test-Path -LiteralPath $prefsJs) {
    $hit = Select-String -Path $prefsJs -Pattern '^user_pref\("lazyfox\.' -ErrorAction SilentlyContinue
    if ($hit) {
      Write-Note "Found $($hit.Count) lazyfox.* pref(s) in prefs.js (set by the extension at runtime)."
      Write-Note "They are harmless; remove them in about:config if you want a pristine profile."
    }
  }
} catch {}

Write-Host ""
Write-Host "Done. Fully quit and restart Firefox to finish restoring the default UI."
Write-Host ""
Write-Host "What was removed (and what was NOT touched):"
Write-Host "  - chrome/userChrome.css, userChrome.uc.js, frame.js   (the hidden UI patches)"
Write-Host "  - Lazyfox entries in user.js (other prefs preserved)"
Write-Host "  - the lazyfox@lazyfox.dev.xpi add-on"
Write-Host "  - the add-on marked inactive in extensions.json"
Write-Host "  Your profile, bookmarks, history, passwords and other add-ons were NOT changed."
Write-Host "  Backups of every file we removed were saved as .lazyfox.uninst.bak-* in the profile."
