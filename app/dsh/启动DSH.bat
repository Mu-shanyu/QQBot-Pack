@echo off
cd /d "%~dp0"
set DSH_HOME=%~dp0home
title QQBot-DSH
echo ================================================
echo   DeepSeek Harness (DSH) 启动中...
echo   首次运行会初始化本地目录 home\profiles，需几十秒
echo   就绪后访问 http://127.0.0.1:3080
echo   首次请在里面填入你的 DeepSeek API Key（设置页）
echo   本窗口请保留别关（关闭=停止 AI 服务）
echo ================================================
:loop
node_modules\.bin\dsh.cmd web --no-open
echo.
echo [!] DSH 退出了，5 秒后自动重启...
ping -n 6 127.0.0.1 >nul 2>&1
goto loop