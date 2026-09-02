@echo off
cd /d "%~dp0"
title QQBot-Pack 停止全部
echo ================================================
echo   停止 QQBot-Pack（NapCat + DSH + 桥接 + 管理台）
echo ================================================
echo.

REM ---- 1. 按窗口标题结束各服务窗口（含循环重启的整棵进程树）----
taskkill /FI "WINDOWTITLE eq QQBot-NapCat*" /T /F >nul 2>&1
taskkill /FI "WINDOWTITLE eq QQBot-Bridge*" /T /F >nul 2>&1
taskkill /FI "WINDOWTITLE eq QQBot-WebUI*" /T /F >nul 2>&1
taskkill /FI "WINDOWTITLE eq QQBot-DSH*" /T /F >nul 2>&1
echo [1/2] 服务窗口已结束

REM ---- 2. 兜底：按命令行特征清理可能残留的 node 进程 ----
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'node-bundle' -or $_.CommandLine -match 'bridge\.mjs' -or $_.CommandLine -match 'webui.server' -or $_.CommandLine -match 'dsh[/\\]lib[/\\]bin\.js' } | ForEach-Object { Write-Host ('清理残留 PID ' + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
echo [2/2] 残留进程已清理

echo.
echo 已停止。NapCat 若弹过 QQ 相关窗口请手动关掉即可。
echo 说明：本脚本只停封装包自己的服务，不影响你电脑上其他东西。
pause