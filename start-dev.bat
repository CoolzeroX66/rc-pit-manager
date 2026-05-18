@echo off
title RC Pit Manager – DEV (Port 8066)
echo.
echo  ==========================================
echo   RC PIT MANAGER – ENTWICKLUNGSUMGEBUNG
echo   Branch: dev   Port: 8066
echo  ==========================================
echo.

REM Versuche npx browser-sync (Live-Reload)
where npx >nul 2>&1
if %errorlevel% == 0 (
    echo  [OK] Node.js gefunden – starte Browser-Sync mit Live-Reload...
    echo.
    start http://localhost:8066
    npx browser-sync start --server --port 8066 --files "*.html,*.css,*.js" --no-notify
    goto end
)

REM Fallback: Python http.server
where python >nul 2>&1
if %errorlevel% == 0 (
    echo  [OK] Python gefunden – starte http.server...
    echo  Hinweis: Kein Live-Reload. Seite nach Aenderungen manuell neu laden.
    echo.
    start http://localhost:8066
    python -m http.server 8066
    goto end
)

REM Letzter Fallback: py-Launcher
where py >nul 2>&1
if %errorlevel% == 0 (
    start http://localhost:8066
    py -m http.server 8066
    goto end
)

echo  [FEHLER] Weder Node.js noch Python gefunden.
echo  Bitte index.html direkt im Browser oeffnen (file://).
echo.
pause

:end
