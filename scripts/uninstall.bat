@echo off
rem ============================================================
rem  Lazyfox one-click uninstaller (Windows)
rem  Removes everything Lazyfox installed and nothing else.
rem  Add -RemoveChromeLoader to also remove the chrome loader
rem  from the Firefox install folder (needs admin once).
rem ============================================================
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1" %*
if errorlevel 1 (
  echo.
  echo Uninstall failed. See the messages above.
  if "%LAZYFOX_NO_PAUSE%"=="" (
    pause
  )
)
