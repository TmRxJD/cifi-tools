@echo off
rem ===========================================================================
rem  Runs at the end of setup: makes sure Node.js is present and installs the
rem  bridge globally (best effort -- the launcher falls back to npx).
rem
rem  Args:  silent
rem ===========================================================================
setlocal enabledelayedexpansion

set "NPM_TIMEOUT_MS=180000"
set "SILENT=%~1"

rem Make a freshly installed Node visible without opening a new shell.
for %%D in ("%ProgramFiles%\nodejs" "%ProgramFiles(x86)%\nodejs" "%LOCALAPPDATA%\Programs\nodejs") do (
  if exist "%%~D\node.exe" set "PATH=%%~D;!PATH!"
)

where node >nul 2>nul
if %errorlevel%==0 goto have_node

echo Node.js was not found. Installing it with winget...
winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent
for %%D in ("%ProgramFiles%\nodejs" "%LOCALAPPDATA%\Programs\nodejs") do (
  if exist "%%~D\node.exe" set "PATH=%%~D;!PATH!"
)
where node >nul 2>nul
if not %errorlevel%==0 (
  echo Could not install Node.js automatically. Install it from https://nodejs.org
  echo and then run "npx cifi-bridge" from a terminal.
  goto done
)

:have_node
echo Node.js found. Installing CIFI Bridge...

rem Bounded, best-effort global install: a stalled registry can never wedge the
rem wizard, and the launcher falls back to npx if this does not complete.
rem
rem Run inline with -Command rather than -File. Execution policy applies to
rem script files, not -Command, so this needs no -ExecutionPolicy Bypass -- a
rem setup that does not override the user's policy is one less behaviour for
rem Defender's heuristics to score. Exit codes: 0 ok, 1 failed, 2 timed out.
powershell -NoProfile -Command "$ErrorActionPreference='SilentlyContinue'; try { $p = Start-Process -FilePath 'npm.cmd' -ArgumentList 'install','-g','cifi-bridge@latest','--no-audit','--no-fund','--loglevel=error' -NoNewWindow -PassThru; if ($null -eq $p) { exit 1 }; if (-not $p.WaitForExit(%NPM_TIMEOUT_MS%)) { try { $p.Kill() } catch {}; exit 2 }; exit $p.ExitCode } catch { exit 1 }" < NUL
if errorlevel 2 (
  echo Global install timed out; CIFI Bridge will run via npx instead.
) else if errorlevel 1 (
  echo Global install failed; CIFI Bridge will run via npx instead.
)

:done
if /i not "%SILENT%"=="silent" pause
exit /b 0
