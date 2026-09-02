@echo off
cd /d "%~dp0"
title QQBot-Pack 首次配置
echo ================================================
echo   QQBot-Pack 首次配置
echo ================================================
echo.

REM ---- 1. 检查 Node.js ----
node -v >nul 2>&1
if errorlevel 1 (
    echo [!] 没有检测到 Node.js！
    echo     请先到 https://nodejs.org 下载安装 Node.js 22 或更高版本（一路下一步即可）。
    echo     装完重新双击本脚本。
    echo.
    pause
    exit /b 1
)
for /f "delims=" %%v in ('node -v') do echo [OK] 检测到 Node.js %%v

REM ---- 2. 生成配置文件（从模板复制）----
if not exist "%~dp0config\bridge.config.json" (
    copy /y "%~dp0config\bridge.config.example.json" "%~dp0config\bridge.config.json" >nul
    echo [OK] 已从模板生成 config\bridge.config.json
    echo      请用记事本打开它，填写：群号白名单 groups、主人 owner、机器人名 bot.name
    echo      （每项都有中文说明，照着填即可）
) else (
    echo [OK] config\bridge.config.json 已存在，跳过复制
)

REM ---- 3. 安装 DSH（DeepSeek Harness，本地 npm 安装）----
echo.
echo [1/1] 正在安装 DSH 到 app\dsh（首次需要联网，国内用 npmmirror 镜像加速）...
echo       安装包较大，请耐心等待，不要关闭本窗口。
pushd "%~dp0app\dsh"
call npm install --registry https://registry.npmmirror.com
if errorlevel 1 (
    popd
    echo.
    echo [!] npm install 失败。请检查网络后重试；也可以去掉 --registry 参数直连官方源再试。
    pause
    exit /b 1
)
popd
echo [OK] DSH 安装完成

REM ---- 4. 生成目录与收尾提示 ----
if not exist "%~dp0logs" mkdir "%~dp0logs"
echo.
echo ================================================
echo   首次配置完成！
echo ================================================
echo   接下来：
echo   1) 打开 config\bridge.config.json 填好群号等配置（没填桥接不会工作）
echo   2) 双击  启动全部.bat   启动全部服务
echo   3) 浏览器会自动打开 QQBot 管理台 http://127.0.0.1:3210
echo      - 首次请在 NapCat 网页版用你的 QQ 小号扫码登录（换机会要求验证码，正常）
echo      - 在 DSH 控制台(3080) 里填入你的 DeepSeek API Key
echo   4) 详见 README.txt 与 docs\操作文档.txt
echo.
pause