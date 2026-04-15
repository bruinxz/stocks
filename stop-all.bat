@echo off
echo === Stop A-Share Stock Backtesting System ===
echo.

echo 1. Stop frontend service...
taskkill /F /IM node.exe 2>nul | findstr /V "PID"
if %errorlevel% equ 0 (
    echo Frontend service stopped
) else (
    echo Frontend service not running or cannot be stopped
)

echo.
echo 2. Stop backend service...
taskkill /F /IM node.exe 2>nul | findstr /V "PID"
if %errorlevel% equ 0 (
    echo Backend service stopped
) else (
    echo Backend service not running or cannot be stopped
)

echo.
echo 3. Check port release status...
echo Port 3003 status:
netstat -ano | findstr ":3003" > nul
if %errorlevel% equ 0 (
    echo WARNING: Port 3003 still in use
    netstat -ano | findstr ":3003"
) else (
    echo Port 3003 released
)

echo.
echo Port 4001 status:
netstat -ano | findstr ":4001" > nul
if %errorlevel% equ 0 (
    echo WARNING: Port 4001 still in use
    netstat -ano | findstr ":4001"
) else (
    echo Port 4001 released
)

echo.
echo 4. System stopped!
echo.
echo To restart, run start-all.bat
pause