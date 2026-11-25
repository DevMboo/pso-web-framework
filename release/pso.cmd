@echo off
setlocal
rem Version-directory launcher: prefers the private PSO runtime of the installation, falls back to node on PATH.
set "PSO_NODE=%~dp0..\..\..\runtime\node.exe"
if not exist "%PSO_NODE%" set "PSO_NODE=node"
"%PSO_NODE%" "%~dp0..\node_modules\@pso\cli\bin\pso.js" %*
exit /b %ERRORLEVEL%
