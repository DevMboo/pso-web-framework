@echo off
rem PSO framework DEVELOPMENT command: runs this checkout's CLI (packages\cli\bin\pso.js) with the Node.js on PATH.
rem It is not the installed distribution (use "pso" for that). See packages\cli\docs\devops\installed-and-development-cli.md
setlocal
node "%~dp0..\..\packages\cli\bin\pso.js" %*
exit /b %ERRORLEVEL%
