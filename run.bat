@echo off
title ClipGames 9:16 - Iniciando Servidores
echo ========================================================
echo   Iniciando ClipGames 9:16 Converter (LoL & Gameplays)
echo ========================================================

start "ClipGames Backend (FastAPI)" cmd /k "cd /d %~dp0 && venv\Scripts\python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000 --reload"
start "ClipGames Frontend (Vite/React)" cmd /k "cd /d %~dp0frontend && npm run dev"

echo Aguardando inicializacao dos servidores...
timeout /t 3 /nobreak >nul
start http://localhost:3000

echo Tudo pronto! O navegador foi aberto em http://localhost:3000
