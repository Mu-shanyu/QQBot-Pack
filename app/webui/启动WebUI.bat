@echo off
cd /d "%~dp0..\.."
title QQBot-WebUI
echo QQBot 管理台启动中: http://127.0.0.1:3210
node app\webui\server.mjs
echo.
echo [!] 管理台退出了（Ctrl+C 或直接关窗即停止）
pause