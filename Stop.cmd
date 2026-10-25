@echo off
cd /d "%~dp0"
if exist "%~dp0runtime\node.exe" (
  "%~dp0runtime\node.exe" "%~dp0launcher.cjs" --stop
) else (
  node "%~dp0launcher.cjs" --stop
)
if errorlevel 1 pause
