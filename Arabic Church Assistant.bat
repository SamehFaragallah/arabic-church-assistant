@echo off
rem Opens Arabic Church Assistant (the desktop icon does the same). Run Setup.bat once first.
cd /d "%~dp0"
if exist "%~dp0bin\Arabic Church Assistant.exe" ( start "" "%~dp0bin\Arabic Church Assistant.exe" & exit /b 0 )
if exist "%~dp0node_modules\electron\dist\electron.exe" ( start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0." & exit /b 0 )
echo.
echo  Arabic Church Assistant is not set up yet. Double-click Setup.bat first (one time).
echo.
pause
