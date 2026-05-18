@echo off
title RC Pit Manager – PROD (Port 8000)
echo.
echo  ==========================================
echo   RC PIT MANAGER – PRODUKTIVSYSTEM
echo   Branch: main   Port: 8000
echo  ==========================================
echo.

where python >nul 2>&1
if %errorlevel% == 0 (
    echo  [OK] Starte Produktiv-Server auf Port 8000...
    echo.
    start http://localhost:8000
    python -m http.server 8000
    goto end
)

where py >nul 2>&1
if %errorlevel% == 0 (
    start http://localhost:8000
    py -m http.server 8000
    goto end
)

where npx >nul 2>&1
if %errorlevel% == 0 (
    start http://localhost:8000
    npx serve -l 8000
    goto end
)

echo  [FEHLER] Kein Server verfuegbar.
echo  Bitte index.html direkt im Browser oeffnen (file://).
echo.
pause

:end
