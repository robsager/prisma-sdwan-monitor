@echo off
rem Prisma SD-WAN Monitor for Windows: double-click, or run start.bat.
rem The first run creates a Python environment in .venv and installs the requirements (~1 min).
rem Stop the server with Ctrl+C or by closing this window.
cd /d "%~dp0"

if not exist .venv\Scripts\python.exe (
  echo Creating the Python environment ^(.venv^)...
  py -3 -m venv .venv 2>nul || python -m venv .venv 2>nul
)
if not exist .venv\Scripts\python.exe goto nopython
.venv\Scripts\python -c "import sys; sys.exit(sys.version_info < (3, 10))" || goto nopython

rem Install or update the requirements when requirements.txt has changed (e.g. after git pull).
fc /b requirements.txt .venv\installed-requirements.txt >nul 2>&1
if errorlevel 1 (
  echo Installing requirements...
  .venv\Scripts\python -m pip install -q --upgrade pip
  .venv\Scripts\python -m pip install -q -r requirements.txt || goto failed
  copy /y requirements.txt .venv\installed-requirements.txt >nul
)

.venv\Scripts\python app.py --open
rem Exit code 2: an older version is still running (app.py says how to stop it).
if errorlevel 2 pause
exit /b

:nopython
if exist .venv rmdir /s /q .venv
echo Python 3.10 or newer is required. Install it from https://www.python.org/downloads/ and try again.
pause
exit /b 1

:failed
echo Installing the requirements failed.
pause
exit /b 1
