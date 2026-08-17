# Quick standalone test for the extensions.json text-splice helpers in
# install.ps1. Extracts the four functions from the real script and runs them
# against small, realistic and huge profiles. Run:  powershell -File scripts/test-install-json.ps1
$ErrorActionPreference = "Stop"

function Write-Warn { param([string]$Msg) Write-Host "WARNING: $Msg" -ForegroundColor Yellow }
function Write-Note { param([string]$Msg) Write-Host "NOTE: $Msg" -ForegroundColor DarkGray }

$root = Split-Path -Parent $PSScriptRoot
$src = [System.IO.File]::ReadAllText((Join-Path $root "scripts\install.ps1"))

# Extract the contiguous function block: Get-MatchingBrace .. Remove-LazyfoxEntry
$start = $src.IndexOf("function Get-MatchingBrace")
$end = $src.IndexOf("function Stop-FirefoxForProfile")
if ($start -lt 0 -or $end -lt 0) { throw "could not locate functions in install.ps1" }
$block = $src.Substring($start, $end - $start)
Invoke-Expression $block

$pass = 0
$fail = 0
function Check([string]$Name, [bool]$Cond, [string]$Detail = "") {
  if ($Cond) { $script:pass++; Write-Host "  ok   $Name" -ForegroundColor Green }
  else { $script:fail++; Write-Host "  FAIL $Name  $Detail" -ForegroundColor Red }
}

function Make-Addon {
  param([string]$Id)
  $s = "  {
    `"id`": `"$Id`",
    `"syncGUID`": `"guid-$Id`",
    `"location`": `"app-profile`",
    `"version`": `"1.0`",
    `"type`": `"extension`",
    `"internalName`": null,
    `"updateURL`": null,
    `"updateKey`": null,
    `"optionsURL`": null,
    `"optionsType`": null,
    `"aboutURL`": null,
    `"icons`": { `"48`": `"icon.png`" },
    `"iconURL`": null,
    `"icon64URL`": null,
    `"defaultLocale`": { `"name`": `"$Id`", `"description`": `"test`" },
    `"visible`": true,
    `"active`": true,
    `"userDisabled`": false,
    `"appDisabled`": false,
    `"pendingOperations`": 0,
    `"installDate`": 1,
    `"updateDate`": 1,
    `"applyBackgroundUpdates`": 1,
    `"bootstrap`": true,
    `"skinnable`": false,
    `"size`": 1234,
    `"sourceURI`": null,
    `"releaseNotesURI`": null,
    `"softDisabled`": false,
    `"foreignInstall`": true,
    `"hasBinaryComponents`": false,
    `"strictCompatibility`": false,
    `"locales`": [],
    `"targetApplications`": [],
    `"targetPlatforms`": [],
    `"multiprocessCompatible`": true,
    `"userPermissions`": { `"permissions`": [], `"origins`": [] },
    `"seen`": true,
    `"activeTests`": []
  }"
  return $s
}

function Write-Profile {
  param([string]$Path, [string[]]$AddonIds)
  $lines = @("{
  `"schemaVersion`": 30,
  `"addons`": [")
  for ($i = 0; $i -lt $AddonIds.Count; $i++) {
    $lines += Make-Addon $AddonIds[$i]
    if ($i -lt $AddonIds.Count - 1) { $lines += "    ," }
  }
  $lines += "  ]
}"
  $utf8 = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllLines($Path, $lines, $utf8)
}

function Assert-ValidJson([string]$Path, [string]$Name) {
  try {
    $null = Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
    Check "$Name remains valid JSON" $true
  }
  catch {
    Check "$Name remains valid JSON" $false $_.Exception.Message
  }
}

$tmp = Join-Path $env:TEMP ("lfejson-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
try {
  # --- scenario 1: lazyfox in the middle of three addons -----------------
  $p1 = Join-Path $tmp "mid.json"
  Write-Profile $p1 @("addon-a@x", "lazyfox@lazyfox.dev", "addon-b@x")
  $r = Remove-LazyfoxEntry $p1
  Check "remove (middle) reports removed" ($r -eq $true)
  $t1 = [System.IO.File]::ReadAllText($p1)
  Check "remove (middle) dropped lazyfox" ($t1.IndexOf("lazyfox@lazyfox.dev") -lt 0)
  Check "remove (middle) kept neighbours" ($t1.IndexOf("addon-a@x") -ge 0 -and $t1.IndexOf("addon-b@x") -ge 0)
  Assert-ValidJson $p1 "middle profile"

  # --- scenario 2: lazyfox last of two -----------------------------------
  $p2 = Join-Path $tmp "last.json"
  Write-Profile $p2 @("addon-a@x", "lazyfox@lazyfox.dev")
  $r = Remove-LazyfoxEntry $p2
  Check "remove (last) reports removed" ($r -eq $true)
  $t2 = [System.IO.File]::ReadAllText($p2)
  Check "remove (last) dropped lazyfox" ($t2.IndexOf("lazyfox@lazyfox.dev") -lt 0)
  Check "remove (last) kept neighbour" ($t2.IndexOf("addon-a@x") -ge 0)
  Assert-ValidJson $p2 "last profile"

  # --- scenario 3: lazyfox is the only addon ------------------------------
  $p3 = Join-Path $tmp "only.json"
  Write-Profile $p3 @("lazyfox@lazyfox.dev")
  $r = Remove-LazyfoxEntry $p3
  Check "remove (only) reports removed" ($r -eq $true)
  $t3 = [System.IO.File]::ReadAllText($p3)
  Check "remove (only) dropped lazyfox" ($t3.IndexOf("lazyfox@lazyfox.dev") -lt 0)
  Assert-ValidJson $p3 "only profile"

  # --- scenario 4: absent addon reports false, file untouched -------------
  $p4 = Join-Path $tmp "absent.json"
  Write-Profile $p4 @("addon-a@x")
  $r = Remove-LazyfoxEntry $p4
  Check "remove (absent) reports false" ($r -eq $false)
  $t4 = [System.IO.File]::ReadAllText($p4)
  Check "remove (absent) leaves file unchanged" ($t4.IndexOf("addon-a@x") -ge 0)
  $r2 = Set-LazyfoxEnabled $p4
  Check "enable (absent) reports false" ($r2 -eq $false)

  # --- scenario 5: enable a disabled entry --------------------------------
  $p5 = Join-Path $tmp "disabled.json"
  $lines = @("{
  `"schemaVersion`": 30,
  `"addons`": [")
  $lazy = Make-Addon "lazyfox@lazyfox.dev"
  $lazy = $lazy -replace '"visible": true', '"visible": false'
  $lazy = $lazy -replace '"active": true', '"active": false'
  $lazy = $lazy -replace '"userDisabled": false', '"userDisabled": true'
  $lines += $lazy
  $lines += "  ]
}"
  $utf8 = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllLines($p5, $lines, $utf8)
  $r = Set-LazyfoxEnabled $p5
  Check "enable reports enabled" ($r -eq $true)
  $t5 = [System.IO.File]::ReadAllText($p5)
  $m = [regex]::Match($t5, '"id"\s*:\s*"lazyfox@lazyfox.dev".*?\n\}', 'Singleline')
  $obj = $m.Value
  Check "enable sets userDisabled false" ($obj -match '"userDisabled": false')
  Check "enable sets active true" ($obj -match '"active": true')
  Check "enable sets visible true" ($obj -match '"visible": true')
  Assert-ValidJson $p5 "disabled profile"

  # --- scenario 6: idempotent re-enable -----------------------------------
  $r = Set-LazyfoxEnabled $p5
  Check "re-enable idempotent" ($r -eq $true)
  Assert-ValidJson $p5 "re-enabled profile"

  # --- scenario 7: huge profile (2000 addons) - must not OOM --------------
  $ids = @()
  for ($i = 0; $i -lt 2000; $i++) { $ids += "addon-$i@x" }
  $ids[1500] = "lazyfox@lazyfox.dev"
  $p7 = Join-Path $tmp "huge.json"
  Write-Profile $p7 $ids
  $sizeMb = [math]::Round((Get-Item $p7).Length / 1MB, 1)
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $r = Remove-LazyfoxEntry $p7
  $sw.Stop()
  Check "huge profile ($sizeMb MB) remove ok" ($r -eq $true) "took $($sw.ElapsedMilliseconds)ms"
  $t7 = [System.IO.File]::ReadAllText($p7)
  Check "huge profile dropped lazyfox" ($t7.IndexOf("lazyfox@lazyfox.dev") -lt 0)
  Check "huge profile kept addon-0" ($t7.IndexOf("addon-0@x") -ge 0)
  Check "huge profile kept addon-1999" ($t7.IndexOf("addon-1999@x") -ge 0)
  Assert-ValidJson $p7 "huge profile"

  # --- scenario 8: pathological oversized database -> reset, not parse ------
  $p8 = Join-Path $tmp "bloated.json"
  Write-Profile $p8 @("addon-a@x", "lazyfox@lazyfox.dev")
  $r = Remove-LazyfoxEntry $p8 -ResetThresholdMb 0
  Check "bloated file reports reset" ($r -eq $true)
  Check "bloated file deleted" (-not (Test-Path -LiteralPath $p8))
  $baks = Get-ChildItem -LiteralPath $tmp -Filter "bloated.json.lazyfox.bak-*"
  Check "bloated file backed up" ($baks.Count -eq 1)

  Write-Host ""
  Write-Host "==== $pass passed, $fail failed ===="
}
finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
exit ($fail -gt 0)
