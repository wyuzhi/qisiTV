@echo off
setlocal
cd /d "%~dp0"
if not defined LOCALAPPDATA goto failed
set "qisitvInstallDir=%LOCALAPPDATA%\qisiTV\MCP"
if not exist "%qisitvInstallDir%" mkdir "%qisitvInstallDir%"
if errorlevel 1 goto failed
copy /y "qisitv-connect.exe" "%qisitvInstallDir%\qisitv-connect.new.exe" >nul
if errorlevel 1 goto failed
move /y "%qisitvInstallDir%\qisitv-connect.new.exe" "%qisitvInstallDir%\qisitv-connect.exe" >nul
if errorlevel 1 goto busy
for %%F in (README.txt LICENSE NOTICE THIRD_PARTY_NOTICES.md) do (
  if exist "%%F" (
    copy /y "%%F" "%qisitvInstallDir%\" >nul
    if errorlevel 1 goto failed
  )
)
if exist licenses (
  xcopy /e /i /y licenses "%qisitvInstallDir%\licenses" >nul
  if errorlevel 1 goto failed
)
"%qisitvInstallDir%\qisitv-connect.exe" install-codex
if errorlevel 1 goto failed
echo.
echo qisiTV MCP installed at: "%qisitvInstallDir%"
echo You may delete the downloaded package. Reopen Codex and ask it to call qisitv_pair.
echo Codex starts the local service automatically. No separate terminal is needed.
pause
exit /b 0

:busy
echo Close Codex and wait for its qisiTV MCP service to stop, then run this installer again.
goto failed

:failed
echo Installation did not complete. Fix the error above and run this installer again.
pause
exit /b 1
