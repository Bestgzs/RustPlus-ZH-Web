@echo off
cd /d "%~dp0"
if exist "%~dp0runtime\node.exe" (
  "%~dp0runtime\node.exe" "%~dp0launcher.cjs"
) else (
  node "%~dp0launcher.cjs"
)
if errorlevel 1 pause
