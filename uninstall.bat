@echo off
rem Removes the CanvasTTY "token-usage" plugin.
setlocal
set "DEST=%APPDATA%\canvastty\plugins\token-usage"
if exist "%DEST%" rmdir /S /Q "%DEST%"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$p=Join-Path $env:APPDATA 'canvastty\plugins.json';" ^
  "if(Test-Path $p){ $reg=Get-Content $p -Raw|ConvertFrom-Json;" ^
  "if($reg.PSObject.Properties['token-usage']){ $reg.PSObject.Properties.Remove('token-usage') };" ^
  "$json=$reg | ConvertTo-Json -Depth 6;" ^
  "[System.IO.File]::WriteAllText($p,$json,(New-Object System.Text.UTF8Encoding($false))) }"
echo Removed. Restart CanvasTTY to finish.
exit /b 0
