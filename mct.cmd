@echo off
setlocal
set "MCT_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if exist "%MCT_NODE%" (
  "%MCT_NODE%" "%~dp0bin\mct.mjs" %*
) else (
  node "%~dp0bin\mct.mjs" %*
)
exit /b %errorlevel%
