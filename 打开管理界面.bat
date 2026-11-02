@echo off
chcp 65001 >nul
rem 打开管理界面.bat — 双击即可：确保网关已启动，并在浏览器打开网页管理台。
rem Windows 版，与 打开管理界面.command 对应：launchd 部署仅 macOS，Windows 从本目录
rem 直接跑 node（providers.json / 日志等运行时文件都在 server.mjs 同目录，无需安装步骤）。
cd /d "%~dp0"
rem 端口优先级与 .command 一致：环境变量（PGW_ 新前缀，CANNBOT_ 旧前缀兜底）>
rem 安装时记录的端口（新目录优先、更名前旧目录兜底）> 默认 8484
set "PORT="
if defined PGW_PROXY_PORT set "PORT=%PGW_PROXY_PORT%"
if not defined PORT if defined CANNBOT_PROXY_PORT set "PORT=%CANNBOT_PROXY_PORT%"
if not defined PORT if exist "%USERPROFILE%\.local\share\personal-gateway\port" set /p PORT=<"%USERPROFILE%\.local\share\personal-gateway\port"
if not defined PORT if exist "%USERPROFILE%\.local\share\cannbot-gateway-proxy\port" set /p PORT=<"%USERPROFILE%\.local\share\cannbot-gateway-proxy\port"
if not defined PORT set "PORT=8484"

echo 正在检查个人网关…
curl -fsS -m 3 "http://127.0.0.1:%PORT%/healthz" >nul 2>&1
if %errorlevel% equ 0 (
  echo 网关已在运行。
) else (
  echo 网关未启动，正在最小化窗口启动（关窗即停；常驻可用任务计划程序开机自启）…
  if not defined PGW_PROXY_PORT set "PGW_PROXY_PORT=%PORT%"
  start "个人网关" /min cmd /k "node server.mjs"
  rem 给服务一点启动时间再探活，起不来就别打开一个死地址
  timeout /t 2 /nobreak >nul
  curl -fsS -m 3 "http://127.0.0.1:%PORT%/healthz" >nul 2>&1
  if errorlevel 1 (
    echo 网关启动失败，请查看弹出的「个人网关」窗口里的报错（常见：端口被占用、node 不在 PATH）。
    pause
    exit /b 1
  )
)

echo 打开个人网关管理台：http://127.0.0.1:%PORT%/
start "" "http://127.0.0.1:%PORT%/"
