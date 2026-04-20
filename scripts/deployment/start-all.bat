@echo off
echo === A-Share Stock Backtesting System Startup Script ===
echo.

echo 1. Check port occupancy...
netstat -ano | findstr ":3003" > nul
if %errorlevel% equ 0 (
    echo Port 3003 is in use, attempting to terminate the occupying process...
    for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3003" ^| findstr "LISTENING"') do (
        taskkill /F /PID %%a > nul 2>&1
        echo Terminated process PID: %%a
    )
)

netstat -ano | findstr ":4001" > nul
if %errorlevel% equ 0 (
    echo Port 4001 is in use, attempting to terminate the occupying process...
    for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":4001" ^| findstr "LISTENING"') do (
        taskkill /F /PID %%a > nul 2>&1
        echo Terminated process PID: %%a
    )
)

echo.
echo 2. Start backend service (port 3003)...
cd backend
start "Stock Backend" cmd /c "npm run dev"
cd ..

echo Wait for backend to start... (5 seconds)
timeout /t 5 /nobreak > nul

echo.
echo 3. Start frontend service (port 4001)...
cd frontend
start "Stock Frontend" cmd /c "npm start"
cd ..

echo.
echo 4. System startup completed!
echo.
echo Backend API: http://localhost:3003
echo Frontend UI: http://localhost:4001
echo Portfolio simulation: http://localhost:4001/portfolio
echo.
echo Press any key to open frontend interface...
pause > nul
start http://localhost:4001/portfolio