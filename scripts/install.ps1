param(
  [string]$Profile = "",
  [switch]$NoExtension,
  [switch]$NoLaunch,
  [switch]$ChromeLoaderOnly,
  [string]$FirefoxDir = ""
)

# Lazyfox one-click installer for Windows.
#
# Everything a user needs, in one run:
#   - finds your Firefox profile (prefers Developer Edition),
#   - installs dist/chrome/userChrome.css, userChrome.uc.js, frame.js and
#     corebootstrap.js into the profile's chrome/ folder,
#   - merges dist/chrome/user.js prefs (only the ones Lazyfox owns; your other
#     prefs are preserved),
#   - installs the fx-autoconfig chrome loader (config.js + config-prefs.js)
#     into the Firefox install directory (one UAC prompt, once),
#   - builds and installs the WebExtension, then enables it past Firefox's
#     sideload protection (Firefox is stopped automatically if it is running
#     with this profile so the enable always succeeds),
#   - cleans up stale .lazyfox.bak-* backups from previous installs,
#   - relaunches Firefox so the new UI is live immediately (-NoLaunch skips).
#
# Your Firefox data, bookmarks and settings are never touched. Every file we
# replace is backed up first as <name>.lazyfox.bak-<timestamp>. Re-run any
# time to upgrade — it only writes Lazyfox's own files.

$ErrorActionPreference = "Stop"

function Write-Step { param([string]$Msg) Write-Host "==> $Msg" -ForegroundColor Cyan }
function Write-Warn { param([string]$Msg) Write-Host "WARNING: $Msg" -ForegroundColor Yellow }
function Write-Note { param([string]$Msg) Write-Host "NOTE: $Msg" -ForegroundColor DarkGray }

function Find-FirefoxExe {
  $candidates = @(
    "$env:ProgramFiles\Firefox Developer Edition\firefox.exe",
    "$env:ProgramFiles\Mozilla Firefox Developer Edition\firefox.exe",
    "$env:ProgramFiles\Mozilla Firefox\firefox.exe",
    "${env:ProgramFiles(x86)}\Mozilla Firefox\firefox.exe"
  )
  foreach ($c in $candidates) {
    if (Test-Path -LiteralPath $c) { return $c }
  }
  return ""
}

function Set-LazyfoxEnabled {
  param([string]$JsonPath)
  $json = Get-Content -Raw -LiteralPath $JsonPath | ConvertFrom-Json
  $addon = $json.addons | Where-Object { $_.id -eq "lazyfox@lazyfox.dev" }
  if (-not $addon) { return $false }
  $addon.userDisabled = $false
  $addon.active = $true
  $addon.visible = $true
  $utf8NoBom = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText($JsonPath, ($json | ConvertTo-Json -Depth 20), $utf8NoBom)
  return $true
}

# Firefox caches an add-on's manifest metadata (including which content scripts
# to inject) in extensions.json and trusts it on startup. If a newer xpi is
# installed with the same id+version, that cached metadata is never refreshed,
# so content scripts silently stop injecting (the extension still loads: the
# command center works, but ; / ;f / ;i / Esc on web pages do nothing). The
# reliable fix is to drop the cached entry so Firefox re-imports the add-on
# fresh from the new xpi on the next launch. Other add-ons are untouched.
function Remove-LazyfoxEntry {
  param([string]$JsonPath)
  if (-not (Test-Path -LiteralPath $JsonPath)) { return $false }
  try {
    $bak = "$JsonPath.lazyfox.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Copy-Item -LiteralPath $JsonPath -Destination $bak -Force
    Write-Note "backed up extensions.json -> $bak"
    $json = Get-Content -Raw -LiteralPath $JsonPath | ConvertFrom-Json
    $before = @($json.addons).Count
    $json.addons = @($json.addons | Where-Object { $_.id -ne "lazyfox@lazyfox.dev" })
    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($JsonPath, ($json | ConvertTo-Json -Depth 20), $utf8NoBom)
    return ($before -gt @($json.addons).Count)
  } catch {
    Write-Warn "could not update extensions.json ($($_.Exception.Message)); the add-on metadata may stay stale."
    return $false
  }
}

# Stop the firefox.exe instances using this profile, and wait for them to
# actually exit (the .xpi is locked and extensions.json is rewritten by
# Firefox while it runs). Firefox launched normally (double-click, no
# -profile argument) still uses this profile via profiles.ini, so match by
# (1) an explicit -profile path on the command line, (2) the same browser
# executable as the one we install into, and (3) as a last resort any running
# Firefox.
function Stop-FirefoxForProfile {
  param([string]$ProfileDir)
  $escaped = [regex]::Escape($ProfileDir)
  $all = @(Get-CimInstance Win32_Process -Filter "Name = 'firefox.exe'" -ErrorAction SilentlyContinue)
  if ($all.Count -eq 0) { return $false }
  $procs = @($all | Where-Object { $_.CommandLine -and $_.CommandLine -match $escaped })
  if ($procs.Count -eq 0) {
    $ff = Find-FirefoxExe
    if ($ff) {
      $procs = @($all | Where-Object { $_.ExecutablePath -and $_.ExecutablePath -eq $ff })
      if ($procs.Count -gt 0) {
        Write-Note "Firefox is running without an explicit profile argument; stopping the instance of $(Split-Path -Parent $ff)."
      }
    }
  }
  if ($procs.Count -eq 0) {
    # Don't kill a different browser installation — the xpi removal below has
    # its own lock guard and will warn if it cannot replace a locked add-on.
    return $false
  }
  Write-Step "Stopping Firefox using this profile ($($procs.Count) process(es))..."
  foreach ($proc in $procs) {
    Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
  }
  for ($i = 0; $i -lt 40; $i++) {
    $alive = @(Get-CimInstance Win32_Process -Filter "Name = 'firefox.exe'" -ErrorAction SilentlyContinue)
    $still = $false
    foreach ($a in $alive) {
      if ($procs | Where-Object { $_.ProcessId -eq $a.ProcessId }) { $still = $true; break }
    }
    if (-not $still) { break }
    Start-Sleep -Milliseconds 500
  }
  return $true
}

function Test-IsAdmin {
  try {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $p = New-Object Security.Principal.WindowsPrincipal($id)
    return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  }
  catch { return $false }
}

function Install-ChromeLoader {
  param([string]$Dir)
  if (-not $Dir -or -not (Test-Path -LiteralPath $Dir)) {
    Write-Warn "could not find the Firefox installation folder: '$Dir'"
    return $false
  }
  $utf8NoBom = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText(
    (Join-Path $Dir "config.js"),
    (Get-Content -Raw -LiteralPath     (Join-Path $repoRoot "dist\chrome\loader\config.js")),
    $utf8NoBom
  )
  $prefDir = Join-Path $Dir "defaults\pref"
  New-Item -ItemType Directory -Force -Path $prefDir | Out-Null
  [System.IO.File]::WriteAllText(
    (Join-Path $prefDir "config-prefs.js"),
    (Get-Content -Raw -LiteralPath     (Join-Path $repoRoot "dist\chrome\loader\config-prefs.js")),
    $utf8NoBom
  )
  return $true
}

# Remove stale Lazyfox backups (from this installer or older versions) that are
# older than 30 days, so an old install can't pile up cruft. Backups newer than
# that are kept — they are the rollback safety net.
function Remove-StaleLazyfoxBackups {
  param([string]$Dir)
  if (-not (Test-Path -LiteralPath $Dir)) { return }
  $cutoff = (Get-Date).AddDays(-30)
  $stale = Get-ChildItem -LiteralPath $Dir -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '\.lazyfox\.(bak|uninst\.bak)-' -and $_.LastWriteTime -lt $cutoff }
  foreach ($f in $stale) {
    Remove-Item -Force -LiteralPath $f.FullName -ErrorAction SilentlyContinue
    Write-Note "removed stale backup: $($f.Name)"
  }
}

$repoRoot = Split-Path -Parent $PSScriptRoot

if ($ChromeLoaderOnly) {
  if (Install-ChromeLoader $FirefoxDir) {
    Write-Step "Chrome loader installed into $FirefoxDir"
    exit 0
  }
  exit 1
}

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
        $isDefault = $false
        $path = ""
        for ($j = $i + 1; $j -lt $ini.Count; $j++) {
          if ($ini[$j] -match '^\[') { break }
          if ($ini[$j] -match '^Default=1$') { $isDefault = $true }
          if ($ini[$j] -match '^Path=(.+)$') { $path = $matches[1] }
        }
        if ($path) {
          $profiles += [PSCustomObject]@{
            Name = $name
            IsDefault = $isDefault
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

if ($Profile) {
  $profileDir = $Profile
}
else {
  $profileDir = Resolve-ProfilePath $profilesIni $profilesBase
}

if (-not $profileDir -or -not (Test-Path -LiteralPath $profileDir)) {
  Write-Host "Could not find a Firefox profile automatically."
  Write-Host "Open Firefox, go to about:support and copy the 'Profile Folder' path, then run:"
  Write-Host "  powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -Profile `"C:\path\to\profile`""
  exit 1
}

Write-Step "Profile: $profileDir"

# One-click: stop this profile's Firefox so the add-on enable always succeeds,
# then relaunch at the end (unless -NoLaunch).
$stoppedFirefox = Stop-FirefoxForProfile $profileDir

$chromeDir = Join-Path $profileDir "chrome"
New-Item -ItemType Directory -Force -Path $chromeDir | Out-Null
Copy-Item -Force (Join-Path $repoRoot "dist\chrome\userChrome.css") (Join-Path $chromeDir "userChrome.css")
Copy-Item -Force (Join-Path $repoRoot "dist\chrome\userChrome.uc.js") (Join-Path $chromeDir "userChrome.uc.js")
Copy-Item -Force (Join-Path $repoRoot "dist\chrome\frame.js") (Join-Path $chromeDir "frame.js")
Copy-Item -Force (Join-Path $repoRoot "dist\chrome\corebootstrap.js") (Join-Path $chromeDir "corebootstrap.js")
Write-Step "Installed chrome\userChrome.css, userChrome.uc.js, frame.js, corebootstrap.js"

Remove-StaleLazyfoxBackups $chromeDir
Remove-StaleLazyfoxBackups (Join-Path $profileDir "extensions")

$managed = @{}
$ourContent = Get-Content -LiteralPath (Join-Path $repoRoot "dist\chrome\user.js")
foreach ($line in $ourContent) {
  if ($line -match '^user_pref\("([^"]+)"') { $managed[$matches[1]] = $true }
}

# Install-dir loader (fx-autoconfig-style): lets the profile's userChrome.uc.js run.
# Lives in the Firefox installation folder, so it needs admin rights once.
$ff = Find-FirefoxExe
$ffDir = if ($ff) { Split-Path -Parent $ff } else { "" }
if ($ffDir) {
  $needLoader = (-not (Test-Path -LiteralPath (Join-Path $ffDir "config.js"))) -or
                (-not (Test-Path -LiteralPath (Join-Path $ffDir "defaults\pref\config-prefs.js")))
  if ($needLoader) {
    if (-not (Test-IsAdmin)) {
      Write-Step "Installing the chrome loader into $ffDir requires administrator rights (one-time)."
      Write-Step "A UAC prompt may appear - accept it to install config.js + config-prefs.js."
      $args = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -ChromeLoaderOnly -FirefoxDir `"$ffDir`""
      $p = Start-Process -FilePath "powershell.exe" -ArgumentList $args -Verb RunAs -Wait -PassThru
      if ($p.ExitCode -ne 0) {
        Write-Warn "chrome loader was not installed (admin required). Internal-page ; keys and the command center's about: pages will not work. Re-run this installer from an elevated shell to fix."
      }
      else {
        Write-Step "Chrome loader installed."
      }
    }
    else {
      if (Install-ChromeLoader $ffDir) { Write-Step "Chrome loader installed." }
    }
    # verify
    $cfg = Join-Path $ffDir "config.js"
    $pref = Join-Path $ffDir "defaults\pref\config-prefs.js"
    if ((Test-Path -LiteralPath $cfg) -and (Test-Path -LiteralPath $pref)) {
      Write-Step "Chrome loader verified in $ffDir"
    }
    else {
      Write-Warn "Chrome loader files are missing after install. Re-run this installer from an elevated shell."
    }
  }
  else {
    Write-Note "Chrome loader already installed in $ffDir"
  }
}
else {
  Write-Warn "could not locate firefox.exe; chrome loader not installed (internal-page ; keys won't work)."
}

$userJs = Join-Path $profileDir "user.js"
$kept = @()
if (Test-Path -LiteralPath $userJs) {
  $kept = Get-Content -LiteralPath $userJs | Where-Object {
    if ($_ -match '^user_pref\("([^"]+)"') {
      -not $managed.ContainsKey($matches[1])
    }
    else { $true }
  }
}
$allLines = @($kept) + @($ourContent)
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllLines($userJs, $allLines, $utf8NoBom)
Write-Step "Merged preferences into user.js"

if (-not $NoExtension) {
  $extDir = Join-Path $repoRoot "dist\extension"
  $extensionsDir = Join-Path $profileDir "extensions"
  New-Item -ItemType Directory -Force -Path $extensionsDir | Out-Null
  $xpi = Join-Path $extensionsDir "lazyfox@lazyfox.dev.xpi"
  $tmp = Join-Path $env:TEMP ("lazyfox-build-" + [guid]::NewGuid().ToString("N"))
  Copy-Item -Recurse -Force $extDir $tmp
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  if (Test-Path -LiteralPath $xpi) {
    try { Remove-Item -Force -LiteralPath $xpi }
    catch {
      Write-Warn ".xpi is locked ($_.Exception.Message). Quit Firefox and re-run this installer to refresh the add-on."
    }
  }
  try {
    [System.IO.Compression.ZipFile]::CreateFromDirectory($tmp, $xpi, [System.IO.Compression.CompressionLevel]::Optimal, $false)
    Write-Step "Built and installed extension: $xpi"
  }
  catch {
    Write-Warn "could not write the extension ($_.Exception.Message). Quit Firefox and re-run."
  }
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue

  $extJson = Join-Path $profileDir "extensions.json"
  # The add-on startup cache (addonStartup.json.lz4) and extensions.json store
  # the content-script registration Firefox restored at the last boot. If a
  # newer xpi is installed with the same id+version, that cached metadata is
  # never refreshed, so content scripts silently stop injecting (the extension
  # still loads: the command center works, but ; / ;f / ;i / Esc on web pages
  # do nothing). Delete both while Firefox is stopped so the next launch
  # re-imports the add-on fresh from the new xpi. Other add-ons are untouched.
  $addonStartup = Join-Path $profileDir "addonStartup.json.lz4"
  if (Test-Path -LiteralPath $addonStartup) {
    try {
      Remove-Item -Force -LiteralPath $addonStartup -ErrorAction Stop
      Write-Step "Cleared the add-on startup cache (addonStartup.json.lz4)."
    } catch {
      Write-Warn "could not remove addonStartup.json.lz4 ($($_.Exception.Message))."
    }
  }
  if (Test-Path -LiteralPath $extJson) {
    # Firefox is stopped (or was never running): the edit sticks. Drop the
    # cached entry so the freshly built xpi is re-imported with correct
    # content-script metadata (see Remove-LazyfoxEntry), then re-enable it.
    if (Remove-LazyfoxEntry $extJson) {
      Write-Step "Refreshed Lazyfox in extensions.json (re-imported on next launch with fresh metadata)."
    }
    elseif (Set-LazyfoxEnabled $extJson) {
      Write-Step "Enabled Lazyfox (sideload-protection bypass in extensions.json)."
    }
    else {
      Write-Note "Lazyfox is not listed in extensions.json yet; it will be imported on the next launch."
    }
  }
  elseif (-not $NoLaunch) {
    $ff = Find-FirefoxExe
    if ($ff) {
      Write-Step "First install: launching Firefox once to import Lazyfox..."
      $p = Start-Process -FilePath $ff -ArgumentList @('-profile', "`"$profileDir`"", 'about:blank') -PassThru
      $imported = $false
      $deadline = (Get-Date).AddSeconds(60)
      while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 3
        if (Test-Path -LiteralPath $extJson) {
          $t = Get-Content -Raw -LiteralPath $extJson
          if ($t -match 'lazyfox@lazyfox.dev') { $imported = $true; break }
        }
      }
      Stop-FirefoxForProfile $profileDir
      if ($imported) {
        Start-Sleep -Seconds 2
        if (Set-LazyfoxEnabled $extJson) {
          Write-Step "Lazyfox imported and enabled. It stays enabled on future launches."
        }
        else {
          Write-Warn "Lazyfox was imported but could not be auto-enabled. Enable it once in about:addons."
        }
      }
      else {
        Write-Warn "Firefox did not finish importing the add-on. Enable Lazyfox once in about:addons after your next launch."
      }
    }
    else {
      Write-Warn "could not locate firefox.exe to trigger the first import. Enable Lazyfox once in about:addons."
    }
  }
}

Write-Host ""
Write-Host "Done. Lazyfox is installed and enabled."
Write-Host ""
Write-Host "Things to check:"
Write-Host "  1. All chrome UI (tabs, URL bar, menus) is removed. Move the mouse to the very top edge of the window to reveal the URL bar on demand; ;z toggles zen/fullscreen mode."
Write-Host "  2. Press ; (semicolon) on any page for the which-key overlay: ;o URL, ;s search, ;t tabs, ;n new tab, ;w resize..."
Write-Host "  3. If Lazyfox is not listed in about:addons, load it manually: about:debugging -> This Firefox -> Load Temporary Add-on -> dist\extension\manifest.json"

if ($stoppedFirefox -and -not $NoLaunch) {
  $ff = Find-FirefoxExe
  if ($ff) {
    Write-Step "Relaunching Firefox with the profile..."
    Start-Process -FilePath $ff -ArgumentList @('-profile', "`"$profileDir`"") | Out-Null
  }
}
elseif (-not $NoLaunch) {
  Write-Note "Fully quit and restart Firefox to apply the changes (or re-run with no flags and it will relaunch for you)."
}
