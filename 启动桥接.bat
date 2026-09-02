@echo off
cd /d "%~dp0"
title QQBot-Bridge
echo ================================================
echo   QQBot 桥接启动中...
echo   请确认：1) NapCat 已启动并扫码登录成功（3001 有监听）
echo            2) config\bridge.config.json 已填好群号
echo ================================================
:loop
node app\bridge\bridge.mjs
echo.
echo [!] 桥接退出了，5 秒后自动重启...（彻底停止请 Ctrl+C 或运行 停止全部.bat）
ping -n 6 127.0.0.1 >nul 2>&1
goto loop