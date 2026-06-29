@echo off
REM Triggers Ava's MCP TTS server with a sample message for manual testing.
REM Ava must be running (desktop build). Double-click or run from a terminal.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0test-mcp-tts.ps1" %*
pause
