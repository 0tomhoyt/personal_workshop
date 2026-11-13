@echo off
setlocal
cd /d "%~dp0"

set "PGW_CONFIG=%~1"
if "%PGW_CONFIG%"=="" set "PGW_CONFIG=%~dp0providers.json"

if not exist "%PGW_CONFIG%" (
  echo providers.json not found: %PGW_CONFIG%
  echo Run the gateway once or pass the full config path as the first argument.
  pause
  exit /b 1
)

node "%~dp0scripts\configure-codex.mjs" --config "%PGW_CONFIG%"
if errorlevel 1 pause
