@echo off
rem ============================================================
rem  Lazyfox one-click installer (Windows)
rem  Double-click this file, or run it from cmd. Everything is
rem  automatic: profile detection, UI patch, add-on install and
rem  enable, and a Firefox relaunch at the end.
rem ============================================================
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
if errorlevel 1 (
  echo.
  echo Installation failed. See the messages above.
  rem Keep the window open on failure when double-clicked. Set
  rem LAZYFOX_NO_PAUSE=1 to disable (e.g. from a script).
  if "%LAZYFOX_NO_PAUSE%"=="" (
    pause
  )
)
