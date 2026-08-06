param(
  [string]$Profile = "",
  [switch]$NoExtension,
  [switch]$NoLaunch
)

$ErrorActionPreference = "Stop"

function Write-Step {
  param([string]$Msg)
  Write-Host "==> $Msg" -ForegroundColor Cyan
}

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

$chromeDir = Join-Path $profileDir "chrome"
New-Item -ItemType Directory -Force -Path $chromeDir | Out-Null
Copy-Item -Force (Join-Path $repoRoot "chrome\userChrome.css") (Join-Path $chromeDir "userChrome.css")
Write-Step "Installed chrome\userChrome.css"

$managed = @{}
$ourContent = Get-Content -LiteralPath (Join-Path $repoRoot "chrome\user.js")
foreach ($line in $ourContent) {
  if ($line -match '^user_pref\("([^"]+)"') { $managed[$matches[1]] = $true }
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
  $extDir = Join-Path $repoRoot "extension"
  $extensionsDir = Join-Path $profileDir "extensions"
  New-Item -ItemType Directory -Force -Path $extensionsDir | Out-Null
  $xpi = Join-Path $extensionsDir "lazyfox@lazyfox.dev.xpi"
  $tmp = Join-Path $env:TEMP ("lazyfox-build-" + [guid]::NewGuid().ToString("N"))
  Copy-Item -Recurse -Force $extDir $tmp
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  if (Test-Path -LiteralPath $xpi) { Remove-Item -Force -LiteralPath $xpi }
  [System.IO.Compression.ZipFile]::CreateFromDirectory($tmp, $xpi, [System.IO.Compression.CompressionLevel]::Optimal, $false)
  Remove-Item -Recurse -Force $tmp
  Write-Step "Built and installed extension: $xpi"

  $extJson = Join-Path $profileDir "extensions.json"
  $lockFile = Join-Path $profileDir "lock"
  if (Test-Path -LiteralPath $extJson) {
    if (Test-Path -LiteralPath $lockFile) {
      Write-Host "NOTE: this profile is currently in use by Firefox. Quit it, then re-run this installer to auto-enable Lazyfox."
    }
    elseif (Set-LazyfoxEnabled $extJson) {
      Write-Step "Enabled Lazyfox (it was installed but disabled by Firefox's sideload protection)."
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
          Write-Host "WARNING: Lazyfox was imported but could not be auto-enabled. Enable it once in about:addons."
        }
      }
      else {
        Write-Host "WARNING: Firefox did not finish importing the add-on. Enable Lazyfox once in about:addons after your next launch."
      }
    }
    else {
      Write-Host "WARNING: could not locate firefox.exe to trigger the first import. Enable Lazyfox once in about:addons."
    }
  }
}

Write-Host ""
Write-Host "Done. Fully quit and restart Firefox."
Write-Host ""
Write-Host "Things to check:"
Write-Host "  1. All chrome UI (tabs, URL bar, menus) should be hidden. Move the mouse to the very top edge to reveal them; ;z toggles fullscreen/zen mode."
Write-Host "  2. If Lazyfox is not listed in about:addons, load it manually:"
Write-Host "       about:debugging -> This Firefox -> Load Temporary Add-on -> extension\manifest.json"
Write-Host "  3. The unsigned add-on only persists on Firefox Developer Edition / Nightly (xpinstall.signatures.required=false is already set)."
