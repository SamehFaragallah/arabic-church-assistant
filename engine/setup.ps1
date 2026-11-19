# Installs the Arabic Church Assistant speech engine (run by Setup.bat, and by the app when "On this PC" is chosen).
# Nothing has to be installed on the PC first: the engine gets a Python of its own in engine\python (the official
# Python from nuget.org, 15 MB), and its packages go inside that folder. The whole app folder can then be
# copied to another PC and run there.
#   -Light   Google speech or a paid service only (about 230 MB): no PyTorch and no speech model
#   (none)   also the speech model that runs on this PC (PyTorch and the model: 4.5 to 8.5 GB)
#   -Cpu     install the processor-only version even when there is an NVIDIA card
#   -Repair  install the Python and its packages again
#   -App     run by the app: no questions; exits with 3 when the model needs a Hugging Face token (HF_TOKEN)
param([switch]$Cpu, [switch]$Repair, [switch]$Light, [switch]$App)
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here
function Say($m, $c = 'Gray') { Write-Host "  $m" -ForegroundColor $c }
function Fail($m) { Write-Host ""; Write-Host "  !! $m" -ForegroundColor Red; Write-Host ""; exit 1 }

# What the engine was tested with. (A newer PyTorch is taken if this one is no longer offered.)
$PyVersion = '3.14.7'
$PySha256 = '46A4DA5529A92D18FF894911F6E6033A8253198D705B8161BF28C9123C87D46B'
$TorchVersion = '2.11.0'
$VcVersion = '14.51.36231'                         # the msvc-runtime package on pypi.org (its file for Python 3.14)
$VcSha256 = '55A017355394FA78F87DBAB6967CF2131398671CA0A77F8C97DADFC6C6F3DE38'

# only the packages installed here count, never ones from a Python the user happens to have
$env:PYTHONNOUSERSITE = '1'
$env:PIP_DISABLE_PIP_VERSION_CHECK = '1'
$env:PIP_NO_WARN_SCRIPT_LOCATION = '0'      # (pip reads this one upside down: 0 = don't warn that Scripts isn't on the PATH)
$env:PYTHONIOENCODING = 'utf-8'

# ---- 1. Python: the engine's own, in engine\python
$ownDir = Join-Path $here 'python'
$ownPy = Join-Path $ownDir 'python.exe'
$oldDir = Join-Path $here '.venv'                  # installs from before version 3.2: a virtual environment made from a Python on the PC
$oldPy = Join-Path $oldDir 'Scripts\python.exe'
function Works($exe) {
  if (-not (Test-Path $exe)) { return $false }
  $null = & $exe -c "import sys, pip" 2>$null
  return ($LASTEXITCODE -eq 0)
}
function Get-OwnPython {
  Say "Getting Python $PyVersion for the speech engine (15 MB). It stays inside this folder: nothing is installed on the PC." Cyan
  $pkg = Join-Path $env:TEMP "vf-python-$PyVersion.zip"
  $url = "https://api.nuget.org/v3-flatcontainer/python/$PyVersion/python.$PyVersion.nupkg"
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $url -OutFile $pkg -UseBasicParsing
  } catch { Fail "Could not download Python ($($_.Exception.Message)). Check the internet connection and run Setup again." }
  if ((Get-FileHash $pkg -Algorithm SHA256).Hash -ne $PySha256) {
    Remove-Item $pkg -ErrorAction SilentlyContinue
    Fail "The Python download did not arrive whole. Run Setup again."
  }
  $tmp = Join-Path $here 'python.tmp'
  if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }
  New-Item -ItemType Directory -Force $tmp | Out-Null
  # Windows' own tar unpacks the thousands of small files far faster than Expand-Archive
  $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
  if (Test-Path $tar) { & $tar -xf $pkg -C $tmp tools 2>$null }
  if (-not (Test-Path (Join-Path $tmp 'tools\python.exe'))) { Expand-Archive -Path $pkg -DestinationPath $tmp -Force }
  if (-not (Test-Path (Join-Path $tmp 'tools\python.exe'))) { Fail "Could not unpack Python into $tmp." }
  if (Test-Path $ownDir) { Remove-Item $ownDir -Recurse -Force -ErrorAction SilentlyContinue }
  Move-Item (Join-Path $tmp 'tools') $ownDir
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $pkg -ErrorAction SilentlyContinue
  if (-not (Works $ownPy)) { Fail "The speech engine's Python does not start. Run Setup again; if it keeps happening, the antivirus may be blocking engine\python\python.exe." }
}

$py = $null; $pyHome = $null
if ($Repair -and (Test-Path $ownDir)) { Remove-Item $ownDir -Recurse -Force -ErrorAction SilentlyContinue }
if (Works $ownPy) { $py = $ownPy; $pyHome = $ownDir }
elseif (-not $Repair -and (Works $oldPy) -and (Test-Path (Join-Path $oldDir 'ready.txt'))) {
  $py = $oldPy; $pyHome = $oldDir
  Say "Speech engine: keeping the install that is already here (engine\.venv)."
} else {
  Get-OwnPython
  $py = $ownPy; $pyHome = $ownDir
}
Say ("Python: " + (& $py --version 2>&1) + "  (" + $py + ")")

# ---- 1b. Microsoft's Visual C++ runtime. PyTorch and the voice detector load two of its libraries (msvcp140.dll and
# msvcp140_1.dll). Most PCs have them because some other program installed them; a freshly installed Windows does not.
# A copy goes next to the engine's Python, so the engine does not depend on what the PC has: here, or on the PC this
# folder is copied to. (They come in the msvc-runtime package on pypi.org; the download is checked like Python's.)
function Add-VcRuntime($python, $dir, $sys = (Join-Path $env:SystemRoot 'System32')) {
  $names = @('msvcp140.dll', 'msvcp140_1.dll')
  if (-not ($names | Where-Object { -not (Test-Path (Join-Path $dir $_)) })) { return $true }
  $tmp = Join-Path $env:TEMP ('vf-vcrt-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
  New-Item -ItemType Directory -Force $tmp | Out-Null
  try {
    # (Out-Host: what pip prints goes to the screen, not into this function's answer)
    & $python -m pip download "msvc-runtime==$VcVersion" --no-deps --only-binary ':all:' -d $tmp -q 2>$null | Out-Host
    $whl = Get-ChildItem $tmp -Filter 'msvc_runtime-*.whl' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($whl -and (Get-FileHash $whl.FullName -Algorithm SHA256).Hash -eq $VcSha256) {
      Add-Type -AssemblyName System.IO.Compression.FileSystem
      $zip = [IO.Compression.ZipFile]::OpenRead($whl.FullName)
      try {
        foreach ($n in $names) {
          $e = $zip.Entries | Where-Object { $_.FullName -like "*.data/data/$n" } | Select-Object -First 1
          if ($e) { [IO.Compression.ZipFileExtensions]::ExtractToFile($e, (Join-Path $dir $n), $true) }
        }
      } finally { $zip.Dispose() }
    }
  } catch { }
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  if (-not ($names | Where-Object { -not (Test-Path (Join-Path $dir $_)) })) { return $true }
  # no download: this PC's own copy, when it has one
  if (-not ($names | Where-Object { -not (Test-Path (Join-Path $sys $_)) })) {
    foreach ($n in $names) { Copy-Item (Join-Path $sys $n) $dir -Force }
    return $true
  }
  return $false
}
if ($pyHome -eq $ownDir -and -not (Add-VcRuntime $py $ownDir)) {
  Fail "The speech engine needs Microsoft's Visual C++ runtime, and it could not be downloaded. Check the internet connection and run Setup again (or install it from https://aka.ms/vs/17/release/vc_redist.x64.exe first)."
}
$up = @(); if ($Repair) { $up = @('--upgrade') }
function Ready($text) {
  Set-Content -Path (Join-Path $pyHome 'ready.txt') -Value $text
  # the engine has its own Python now: an older environment made from a Python on this PC is no longer used
  if ($pyHome -eq $ownDir -and (Test-Path $oldDir)) {
    Say "Removing the old engine\.venv (the engine uses engine\python now)..."
    Remove-Item $oldDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

# ---- light install (Google speech or a paid service only): no PyTorch and no 4 GB model
if ($Light) {
  Say "Light install: for Google speech or a paid service (no speech model on this PC)..." Cyan
  & $py -m pip install @up numpy onnxruntime soundcard sounddevice av "websockets>=15"
  if ($LASTEXITCODE -ne 0) { Fail "Could not install the speech engine's packages. Check the internet connection and run Setup again." }
  $null = & $py -c "import numpy, onnxruntime, soundcard, sounddevice, av, websockets" 2>&1
  if ($LASTEXITCODE -ne 0) { Fail "The speech engine is not working yet. Run Setup again." }
  Ready 'light (cloud speech only)'
  Say "Ready. Arabic Church Assistant listens with Google speech (through Chrome); the model for this PC or a paid service can be chosen in Settings -> Listening." Green
  exit 0
}

# ---- 2. PyTorch: the graphics-card build for NVIDIA cards, otherwise the processor build
$nvidia = $false
if (-not $Cpu) { try { $null = & nvidia-smi -L 2>$null; if ($LASTEXITCODE -eq 0) { $nvidia = $true } } catch { } }
$haveTorch = $false
try { $t = & $py -c "import torch; print(torch.cuda.is_available())" 2>$null; if ($LASTEXITCODE -eq 0) { $haveTorch = (-not $nvidia) -or ($t -eq 'True') } } catch { }
function Install-Torch($index, $force) {
  $extra = @(); if ($force) { $extra = @('--force-reinstall') }
  foreach ($spec in @("torch==$TorchVersion", 'torch')) {
    # (Out-Host: what pip prints goes to the screen, not into this function's answer)
    & $py -m pip install @extra $spec --index-url "https://download.pytorch.org/whl/$index" | Out-Host
    if ($LASTEXITCODE -eq 0) { return $true }
  }
  return $false
}
if (-not $haveTorch -or $Repair) {
  if ($nvidia) {
    Say "NVIDIA graphics card found: installing the graphics-card version of PyTorch (about 2.5 GB, one time only)..." Cyan
    $ok = $false; $again = [bool]$Repair
    foreach ($cu in @('cu128', 'cu130', 'cu126')) {
      if (Install-Torch $cu $again) {
        $t = & $py -c "import torch; print(torch.cuda.is_available())" 2>$null
        if ($t -eq 'True') { $ok = $true; Say "PyTorch ($cu) can use the graphics card." Green; break }
      }
      $again = $true                             # (another build over the one just tried)
    }
    if (-not $ok) { Say "The graphics-card version did not work; installing the processor version." Yellow; $nvidia = $false }
  }
  if (-not $nvidia) {
    Say "Installing PyTorch for the processor (about 200 MB)..." Cyan
    if (-not (Install-Torch 'cpu' ($haveTorch -or $Repair))) { Fail "Could not install PyTorch. Check the internet connection and run Setup again." }
  }
}

# ---- 3. the rest
Say "Installing the speech engine's other parts..." Cyan
& $py -m pip install @up -r requirements.txt
if ($LASTEXITCODE -ne 0) { Fail "Could not install the speech engine's packages. Check the internet connection and run Setup again." }

# ---- 4. the speech model (4 GB): already in engine\models, in the Hugging Face cache, or downloaded now (straight
# into engine\models: no second copy in the Hugging Face cache)
$modelDir = Join-Path $here 'models\cohere-transcribe-arabic-07-2026'
if (-not (Test-Path (Join-Path $modelDir 'model.safetensors'))) {
  Say "Getting the speech model (Cohere Transcribe Arabic, about 4 GB)..." Cyan
  $script = @'
import os, shutil, sys
from huggingface_hub import snapshot_download
REPO = "CohereLabs/cohere-transcribe-arabic-07-2026"
dest = sys.argv[1]
os.makedirs(dest, exist_ok=True)
try:
    p = snapshot_download(REPO, local_files_only=True)
    for f in os.listdir(p):
        shutil.copy(os.path.join(p, f), os.path.join(dest, f))
except Exception:
    try:
        snapshot_download(REPO, local_dir=dest, token=os.environ.get("HF_TOKEN") or None)
    except Exception as e:
        name = type(e).__name__
        print("Model download failed:", name, str(e).splitlines()[0][:300] if str(e) else "")
        # the model's page asks everyone to sign in to Hugging Face first
        sys.exit(3 if name in ("GatedRepoError", "RepositoryNotFoundError") or " 401" in str(e) or " 403" in str(e) else 1)
print("ok")
'@
  $tmp = Join-Path $env:TEMP 'vf_get_model.py'
  Set-Content -Path $tmp -Value $script -Encoding UTF8
  & $py $tmp $modelDir
  $got = $LASTEXITCODE
  if ($got -ne 0 -and $App) { Remove-Item $tmp -ErrorAction SilentlyContinue; exit $(if ($got -eq 3) { 3 } else { 1 }) }
  if ($got -ne 0) {
    Say "The model download needs a free Hugging Face account:" Yellow
    Say "  1. Sign in at https://huggingface.co and open https://huggingface.co/CohereLabs/cohere-transcribe-arabic-07-2026" Yellow
    Say "  2. Accept the terms on that page (approved straight away)." Yellow
    Say "  3. Create a 'Read' token at https://huggingface.co/settings/tokens and paste it below." Yellow
    $tok = Read-Host "  Hugging Face token (or press Enter to skip)"
    if ($tok) { $env:HF_TOKEN = $tok.Trim(); & $py $tmp $modelDir }
    if ($LASTEXITCODE -ne 0) { Say "No speech model yet. You can also copy the engine\models folder from another PC with Arabic Church Assistant." Yellow }
  }
  Remove-Item $tmp -ErrorAction SilentlyContinue
}

# ---- 5. check
$check = & $py -c "import torch, transformers, onnxruntime, av, soundcard, sounddevice, websockets; print('cuda' if torch.cuda.is_available() else 'cpu', torch.__version__, transformers.__version__)" 2>&1
if ($LASTEXITCODE -ne 0) { Write-Host $check; Fail "The speech engine is not working yet. Run Setup again." }
Ready $check
Say ("Speech engine ready: " + $check) Green
exit 0
