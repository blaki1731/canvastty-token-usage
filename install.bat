@echo off
rem Installs / updates the CanvasTTY "token-usage" plugin from this folder.
rem CanvasTTY must be restarted afterwards so it reloads the plugin registry.
setlocal
set "SRC=%~dp0"
if "%SRC:~-1%"=="\" set "SRC=%SRC:~0,-1%"
set "DEST=%APPDATA%\canvastty\plugins\token-usage"

echo Copying plugin files to %DEST% ...
if not exist "%DEST%" mkdir "%DEST%"
xcopy "%SRC%\app" "%DEST%\app\" /E /I /Y /Q >nul
xcopy "%SRC%\services" "%DEST%\services\" /E /I /Y /Q >nul
copy /Y "%SRC%\canvastty.plugin.json" "%DEST%\" >nul

echo Updating %APPDATA%\canvastty\plugins.json ...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$p=Join-Path $env:APPDATA 'canvastty\plugins.json';" ^
  "$reg=@{};" ^
  "if(Test-Path $p){ try{ $reg=Get-Content $p -Raw|ConvertFrom-Json }catch{} };" ^
  "if(-not $reg.PSObject.Properties['token-usage']){" ^
  "  $entry=[pscustomobject]@{sourceUrl='https://github.com/blaki1731/canvastty-token-usage';enabled=$true;installedAt=[int64]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds());selectedModules=@();enabledHooks=@()};" ^
  "  $reg | Add-Member -NotePropertyName 'token-usage' -NotePropertyValue $entry -Force;" ^
  "  $json=$reg | ConvertTo-Json -Depth 6;" ^
  "  [System.IO.File]::WriteAllText($p,$json,(New-Object System.Text.UTF8Encoding($false)));" ^
  "  Write-Output 'registered'" ^
  "} else { Write-Output 'already registered - entry preserved (trust kept)' }"

echo.
echo Done. Restart CanvasTTY, then open the plugin from Settings -^> Plugins -^> Token Usage:
echo   - "Расход токенов"        - окно на рабочем столе CanvasTTY (как терминал),
echo   - "Расход токенов (окно)" - отдельное окно Electron.
echo.
echo Если сервис не запускается: на карточке плагина выключите и включите native code.
exit /b 0
