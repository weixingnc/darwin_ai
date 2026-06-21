@echo off
REM Darwin CLI launcher (Windows).
REM Forwards all args to the real Node entrypoint in this directory.
node "%~dp0darwin" %*