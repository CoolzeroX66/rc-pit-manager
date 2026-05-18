@echo off
title RC Pit Manager – Build Produktion
echo.
echo  ==========================================
echo   RC PIT MANAGER – PRODUKTION BUILD
echo  ==========================================
echo.

set DIST=dist

if exist %DIST% (
    echo  [..] Altes dist\ Verzeichnis loeschen...
    rmdir /s /q %DIST%
)

echo  [..] Erstelle dist\...
mkdir %DIST%

echo  [..] Kopiere Dateien...
copy index.html  %DIST%\index.html  >nul
copy style.css   %DIST%\style.css   >nul
copy app.js      %DIST%\app.js      >nul

echo.
echo  [OK] Produktion Build erstellt in: %DIST%\
echo.
echo  Zum Starten des Produktiv-Servers:
echo    start-prod.bat
echo.
pause
