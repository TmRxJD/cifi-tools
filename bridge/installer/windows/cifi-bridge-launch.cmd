@echo off
rem Launcher installed to the user's app folder, started by the Start Menu or
rem Desktop shortcut the installer creates.
setlocal enabledelayedexpansion
title CIFI Bridge

rem Make a winget/MSI-installed Node visible even in a fresh shell.
for %%D in ("%ProgramFiles%\nodejs" "%ProgramFiles(x86)%\nodejs" "%LOCALAPPDATA%\Programs\nodejs") do (
  if exist "%%~D\node.exe" set "PATH=%%~D;!PATH!"
)

where node >nul 2>nul
if not %errorlevel%==0 (
  echo Node.js is missing. Re-run the CIFI Bridge installer to repair it.
  pause
  exit /b 1
)

rem --foreground --skip-intro serves immediately with no prompts: the installer
rem already handled Node.js. Without --skip-intro the CLI waits at an
rem interactive prompt and never opens the port, so the site cannot connect.
rem (--daemon is the background mode; it re-spawns itself detached and hidden,
rem which is what the "start at sign-in" task uses.)
set "BRIDGE_ARGS=%*"
if "%BRIDGE_ARGS%"=="" set "BRIDGE_ARGS=--foreground --skip-intro"

rem Prefer a global install; fall back to npx.
where cifi-bridge >nul 2>nul
if %errorlevel%==0 (
  call cifi-bridge %BRIDGE_ARGS%
) else (
  call npx -y cifi-bridge@latest %BRIDGE_ARGS%
)

rem Only pause in the interactive case. When the installer or uninstaller calls
rem this with arguments (--boot, --remove-boot) it runs hidden with no console
rem to read a keypress from, so pausing strands an invisible cmd forever -- that
rem hung a silent uninstall until the process was killed by hand.
if not "%~1"=="" exit /b %errorlevel%

echo.
echo CIFI Bridge has stopped. You can close this window.
pause
