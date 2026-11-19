# Arabic Church Assistant setup (run by Setup.bat). Safe to run again at any time: it only adds what is missing.
# Made by Sameh Welson Faragallah.
# Nothing has to be installed on the PC first (no Python, no Node.js): everything goes into this folder.
#   1. the desktop app itself (bin\Arabic Church Assistant.exe, built on Electron; downloaded once, about 150 MB)
#   2. the speech engine for Google speech and the paid services (engine\python: a Python of its own, about 80 MB to
#      download). The speech model that runs on this PC (3 to 7 GB more) is downloaded only when it is chosen in
#      Settings -> Listening -> On this PC, or with Setup.bat -Model.
#   3. "Arabic Church Assistant" shortcuts on the desktop and in the Start menu
param([switch]$Cpu, [switch]$Repair, [switch]$NoEngine, [switch]$Model)
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root
function Say($m, $c = 'Gray') { Write-Host "  $m" -ForegroundColor $c }
$pkg = Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$ElectronVersion = $pkg.devDependencies.electron
if (-not $ElectronVersion) { $ElectronVersion = '45.3.3' }
$AppVersion = $pkg.version
$Name = 'Arabic Church Assistant'
$Author = 'Sameh Welson Faragallah'

Write-Host ""
Write-Host "  ==============================================" -ForegroundColor Yellow
Write-Host "    $Name setup" -ForegroundColor Yellow
Write-Host "    Made by $Author" -ForegroundColor DarkYellow
Write-Host "  ==============================================" -ForegroundColor Yellow
Write-Host ""

# ---- 1. the desktop app
$bin = Join-Path $root 'bin'
$exe = Join-Path $bin "$Name.exe"
# (up to version 3.3 the app was called Verse Finder: its program is renamed, not downloaded again)
$oldExe = Join-Path $bin 'Verse Finder.exe'
if ((Test-Path $oldExe) -and -not (Test-Path $exe)) { Rename-Item $oldExe "$Name.exe" }
$haveVer = ''
if (Test-Path (Join-Path $bin 'version')) { $haveVer = (Get-Content (Join-Path $bin 'version') -Raw).Trim().TrimStart('v') }
if (-not (Test-Path $exe) -or $haveVer -ne $ElectronVersion -or $Repair) {
  Say "Setting up the desktop app (Electron $ElectronVersion)..." Cyan
  if (Test-Path $bin) { Remove-Item $bin -Recurse -Force -ErrorAction SilentlyContinue }
  $local = Join-Path $root 'node_modules\electron\dist'
  $localVer = ''
  if (Test-Path (Join-Path $local 'version')) { $localVer = (Get-Content (Join-Path $local 'version') -Raw).Trim().TrimStart('v') }
  if ((Test-Path (Join-Path $local 'electron.exe')) -and $localVer -eq $ElectronVersion) {
    Copy-Item $local $bin -Recurse
  } else {
    $zip = Join-Path $env:TEMP "electron-v$ElectronVersion-win32-x64.zip"
    $url = "https://github.com/electron/electron/releases/download/v$ElectronVersion/electron-v$ElectronVersion-win32-x64.zip"
    Say "Downloading $url"
    try { Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing } catch { Say "!! Could not download the desktop app: $($_.Exception.Message)" Red; Say "Check the internet connection and run Setup again." Red; exit 1 }
    Expand-Archive -Path $zip -DestinationPath $bin -Force
    Remove-Item $zip -ErrorAction SilentlyContinue
  }
  if (-not (Test-Path (Join-Path $bin 'electron.exe'))) { Say "!! The desktop app could not be set up." Red; exit 1 }
  Rename-Item (Join-Path $bin 'electron.exe') "$Name.exe"
  Remove-Item (Join-Path $bin 'resources\default_app.asar') -ErrorAction SilentlyContinue
  Remove-Item (Join-Path $bin 'name.txt') -ErrorAction SilentlyContinue
  Say "Desktop app ready." Green
} else { Say "Desktop app: already set up." Green }
# only English and Arabic for the menus and dialogs Windows shows around the app (the other 53 languages take 47 MB)
Get-ChildItem (Join-Path $bin 'locales') -Filter '*.pak' -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -notin @('en-US.pak', 'ar.pak') } | Remove-Item -Force -ErrorAction SilentlyContinue
# the app's code stays in this folder; bin\resources\app only points at it. And the name, version and icon on the program
# itself (taskbar, Task Manager, the Windows firewall question).
$stamp = Join-Path $bin 'name.txt'
$want = "$Name $AppVersion"
if (-not (Test-Path $stamp) -or (Get-Content $stamp -Raw).Trim() -ne $want) {
  $appDir = Join-Path $bin 'resources\app'
  New-Item -ItemType Directory -Force $appDir | Out-Null
  Set-Content -Path (Join-Path $appDir 'package.json') -Encoding UTF8 -Value ('{ "name": "arabic-church-assistant", "productName": "' + $Name + '", "version": "' + $AppVersion + '", "author": "' + $Author + '", "main": "../../../electron/main.js" }')
  try {
    $rcedit = Join-Path $env:TEMP 'rcedit-x64.exe'
    if (-not (Test-Path $rcedit)) { Invoke-WebRequest -Uri 'https://github.com/electron/rcedit/releases/download/v2.0.0/rcedit-x64.exe' -OutFile $rcedit -UseBasicParsing }
    & $rcedit $exe --set-icon (Join-Path $root 'electron\icon.ico') --set-version-string 'FileDescription' $Name --set-version-string 'ProductName' $Name `
      --set-version-string 'CompanyName' $Author --set-version-string 'LegalCopyright' "Made by $Author" --set-version-string 'OriginalFilename' "$Name.exe" `
      --set-file-version $AppVersion --set-product-version $AppVersion
    if ($LASTEXITCODE -eq 0) { Set-Content -Path $stamp -Value $want }
  } catch { Say "(Could not set the program icon: $($_.Exception.Message). $Name still works.)" Yellow }
}

# ---- 2. the speech engine: Google speech and the paid services; the model for this PC only when asked for
if (-not $NoEngine) {
  Write-Host ""
  $args2 = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $root 'engine\setup.ps1'))
  if ($Cpu) { $args2 += '-Cpu' }
  if ($Repair) { $args2 += '-Repair' }
  # (a PC that has the model already keeps it, with what it needs)
  $hasModel = Test-Path (Join-Path $root 'engine\models\cohere-transcribe-arabic-07-2026\model.safetensors')
  if ($Model -or $hasModel) {
    Say "Setting up the speech engine with the model for this PC (the first time takes about 10 minutes and downloads 3 to 7 GB)..." Cyan
  } else {
    $args2 += '-Light'
    Say "Setting up the speech engine for Google speech (about 80 MB). The model for this PC is downloaded only if it is chosen in Settings." Cyan
  }
  & powershell @args2
  if ($LASTEXITCODE -ne 0) { Say "!! The speech engine is not ready yet (see above). $Name opens anyway; run Setup again to finish it." Yellow }
}

# ---- 3. shortcuts (the ones from when the app was called Verse Finder are replaced)
$shell = New-Object -ComObject WScript.Shell
foreach ($dir in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
  try {
    $old = Join-Path $dir 'Verse Finder.lnk'
    if (Test-Path $old) {
      $t = $shell.CreateShortcut($old).TargetPath
      if ($t -and $t.StartsWith($bin, [StringComparison]::OrdinalIgnoreCase)) { Remove-Item $old -Force }
    }
    $lnk = $shell.CreateShortcut((Join-Path $dir "$Name.lnk"))
    $lnk.TargetPath = $exe
    $lnk.WorkingDirectory = $root
    $lnk.IconLocation = (Join-Path $root 'electron\icon.ico') + ',0'
    $lnk.Description = "${Name}: shows Bible verses as the pastor mentions them. Made by $Author."
    $lnk.Save()
  } catch { }
}
Write-Host ""
Write-Host "  ==============================================================" -ForegroundColor Green
Write-Host "    Done. Open $Name with its icon on the desktop" -ForegroundColor Green
Write-Host "    (or in the Start menu)." -ForegroundColor Green
Write-Host "  ==============================================================" -ForegroundColor Green
Write-Host ""
exit 0
