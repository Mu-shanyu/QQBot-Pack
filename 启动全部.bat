@echo off
cd /d "%~dp0"
title QQBot-Pack 一键启动
echo ================================================
echo   QQBot-Pack 一键启动
echo ================================================
echo.

REM ---- 0. 前置检查 ----
node -v >nul 2>&1
if errorlevel 1 (
    echo [!] 未检测到 Node.js，请先双击 首次配置.bat 查看提示安装。
    pause
    exit /b 1
)
if not exist "%~dp0app\dsh\node_modules" (
    echo [!] app\dsh 还没有安装 DSH（没有 node_modules 目录）
    echo     请先双击  首次配置.bat  完成安装。
    pause
    exit /b 1
)
if not exist "%~dp0config\bridge.config.json" (
    echo [i] 还没找到 config\bridge.config.json：桥接要等配置就绪才工作。
    echo     可以先跑 首次配置.bat 生成，或手动复制 config\bridge.config.example.json。
    echo.
)

REM ---- 1. NapCat（QQ 登录端）----
netstat -ano | findstr ":6099" >nul 2>&1
if %errorlevel%==0 (
    echo [1/6] NapCat 已在运行（端口 6099 占用），跳过启动
) else (
    echo [1/6] 启动 NapCat（独立窗口）... 首次请打开 6099 网页版扫码登录你的 QQ 小号
    start "QQBot-NapCat" "%~dp0app\napcat\启动NapCat.bat"
)

REM ---- 2. DSH（AI 服务，后台窗口，日志在 logs\dsh.log）----
netstat -ano | findstr ":3080" >nul 2>&1
if %errorlevel%==0 (
    echo [2/6] DSH 已在运行（端口 3080 占用），跳过启动
) else (
    echo [2/6] 启动 DSH（DeepSeek Harness）... 首次初始化需要几十秒
    if not exist "%~dp0logs" mkdir "%~dp0logs"
    start "QQBot-DSH" /min cmd /c ""%~dp0app\dsh\启动DSH.bat" >> "%~dp0logs\dsh.log" 2>&1"
)

REM ---- 3. WebUI 门户 + 管理台 ----
netstat -ano | findstr ":3210" >nul 2>&1
if %errorlevel%==0 (
    echo [3/6] 管理台已在运行（端口 3210 占用），跳过启动
) else (
    echo [3/6] 启动管理台（http://127.0.0.1:3210）...
    if not exist "%~dp0logs" mkdir "%~dp0logs"
    start "QQBot-WebUI" /min cmd /c node "%~dp0app\webui\server.mjs" >> "%~dp0logs\webui.log" 2>&1
)

REM ---- 4. 等 DSH 的 3080 就绪（最长 2 分钟）----
echo [4/6] 等待 DSH (3080) 就绪，最长 2 分钟...
set /a tries=0
:wait_dsh
netstat -ano | findstr ":3080" >nul 2>&1
if %errorlevel%==0 goto dsh_ready
set /a tries+=1
if %tries% gtr 60 (
    echo   [!] 2 分钟内 3080 未就绪，DSH 可能启动失败。请看 logs\dsh.log 排查。
    goto after_dsh
)
ping -n 2 127.0.0.1 >nul
goto wait_dsh
:dsh_ready
echo   [OK] DSH 3080 已就绪
:after_dsh

REM ---- 5. 等 OneBot WS (3001) 就绪（最长 3 分钟；等不到说明还没扫码登录）----
echo [5/6] 等待 QQ 登录后的 OneBot WS (3001)，最长 3 分钟...
echo       如果一直等不到：请先在管理台/浏览器打开 http://127.0.0.1:6099/webui 扫码登录小号
set /a tries=0
:wait_ws
netstat -ano | findstr ":3001" >nul 2>&1
if %errorlevel%==0 goto ws_ready
set /a tries+=1
if %tries% gtr 90 (
    echo.
    echo   [!] 3 分钟内 3001 未就绪——NapCat 可能还没扫码登录成功。
    echo       请打开浏览器访问 http://127.0.0.1:6099/webui 完成登录后，
    echo       再双击  启动桥接.bat  单独把桥接拉起来即可（本脚本其余服务已在运行）。
    echo.
    goto after_ws
)
ping -n 2 127.0.0.1 >nul
goto wait_ws
:ws_ready
echo   [OK] WS 3001 已就绪

REM ---- 6. 启动桥接 ----
echo [6/6] 启动桥接（独立窗口）...
netstat -ano | findstr ":34567" >nul 2>&1
if %errorlevel%==0 (
    echo   [i] 桥接已在运行（34567 占用），跳过
) else (
    start "QQBot-Bridge" "%~dp0启动桥接.bat"
)
:after_ws

REM ---- 打开管理台 ----
echo.
set /a tries=0
:wait_ui
netstat -ano | findstr ":3210" >nul 2>&1
if %errorlevel%==0 goto ui_ready
set /a tries+=1
if %tries% gtr 10 (
    echo [!] 管理台 3210 未能就绪，可稍后手动打开 http://127.0.0.1:3210
    goto ui_done
)
ping -n 2 127.0.0.1 >nul
goto wait_ui
:ui_ready
start "" "http://127.0.0.1:3210"
:ui_done
echo.
echo ================================================
echo   启动流程走完！
echo   管理台: http://127.0.0.1:3210（已尝试用浏览器打开）
echo   NapCat 登录: http://127.0.0.1:6099/webui （用 QQ 小号扫码）
echo   DSH 控制台: http://127.0.0.1:3080 （填 DeepSeek API Key）
echo   三个服务窗口（NapCat / DSH / 桥接）请保留别关。
echo   本窗口可以关闭。
echo ================================================
pause