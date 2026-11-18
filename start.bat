@echo off
title QuizLive Server
cd /d "%~dp0"
set "PATH=%USERPROFILE%\node;%PATH%"

where npm >nul 2>nul
if errorlevel 1 (
  echo [LOI] Khong tim thay Node.js tai %USERPROFILE%\node
  echo Hay giai nen Node.js zip vao thu muc do roi chay lai.
  pause
  exit /b
)

if not exist node_modules (
  echo Dang cai thu vien lan dau...
  call npm install
)

if exist cloudflared-windows-amd64.exe (
  echo Dang mo tunnel o cua so moi - link https se hien o do.
  start "QuizLive Tunnel" cmd /k cloudflared-windows-amd64.exe tunnel --url http://localhost:3000
)

call npm start
pause
