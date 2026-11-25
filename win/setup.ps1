#Requires -Version 5.1
<#
.SYNOPSIS
  Brilliance: check this machine and install the pinned build toolchain into .toolchain\. Safe to
  re-run.

.DESCRIPTION
  Everything the build runs comes from .toolchain\ in this checkout, at a pinned version, from an
  archive whose SHA-256 is written below:

    .toolchain\python      CPython 3.13.18 (python-build-standalone 20261026), used only to hold
                           the ROCm SDK wheels
    .toolchain\cmake       CMake 4.4.5
    .toolchain\ninja       Ninja 1.13.2
    .toolchain\rocm-venv   ROCm 10.1.0 (TheRock wheels) with the gfx1201 device libraries
    .toolchain\ffmpeg      FFmpeg 8.1.3, Brilliance's own LGPL-2.1-or-later shared build
                           (win\ffmpeg, built with vcpkg): the image, video and audio decoding
                           upstream gets from the distribution's libavformat (8.1 in upstream's
                           container, docs/DOCKER.md), and the encoders the generation APIs write
                           with (H.264 only through AMD AMF or Media Foundation). Shared and LGPL,
                           so the engine links it dynamically and ships its DLLs and licence
    .toolchain\downloads   the archives themselves, kept so a reinstall needs no network

  The one system prerequisite is Visual Studio Build Tools with the C++ workload: ROCm's clang
  compiles against the MSVC STL/UCRT and the Windows SDK, and links with them. That is checked
  here, not installed: the MSVC toolset is pinned by version (win\env.ps1 selects it with
  -vcvars_ver), and so is the SDK.

  The ROCm SDK wheels are installed from the downloads directory with pip --no-index, after their
  hashes are checked, so a configure never sees a version this file does not name. Recorded in
  .toolchain\toolchain.json, which win\env.ps1 reads.

  Written for Windows PowerShell 5.1; ASCII only (5.1 reads a BOM-less script as the ANSI page).

.PARAMETER CheckOnly
  Report only. Download, install and change nothing.
.PARAMETER Force
  Re-extract and recreate everything under .toolchain\ (the downloads are kept when they match).
#>
[CmdletBinding()]
param(
  [switch]$CheckOnly,
  [switch]$Force
)

# 'Continue', not 'Stop': under Windows PowerShell 5.1 a native command's stderr becomes an error
# record, and 'Stop' turns pip's warnings into a crash. Failures are checked explicitly.
$ErrorActionPreference = 'Continue'
Set-StrictMode -Version 2.0
$ProgressPreference = 'SilentlyContinue'

$Repo      = Split-Path -Parent $PSScriptRoot
$Toolchain = Join-Path $Repo '.toolchain'
$Downloads = Join-Path $Toolchain 'downloads'
$Manifest  = Join-Path $Toolchain 'toolchain.json'

# ------------------------------------------------------------------------------------------ pins
$RocmVersion = '10.1.0'
$GpuTarget   = 'gfx1201'
$AmdIndex    = 'https://stable.repo.amd.com/rocm/whl-next'
$Pins = @(
  @{ key='python'; file='cpython-3.13.18+20261026-x86_64-pc-windows-msvc-install_only.tar.gz'
     url='https://github.com/astral-sh/python-build-standalone/releases/download/20261026/cpython-3.13.18%2B20261026-x86_64-pc-windows-msvc-install_only.tar.gz'
     sha='ebe90cc1dce2dd2d7afa1f0aa9b6c269c7c0174aeabdc6a801381602b7283424' },
  @{ key='cmake'; file='cmake-4.4.5-windows-x86_64.zip'
     url='https://github.com/Kitware/CMake/releases/download/v4.4.5/cmake-4.4.5-windows-x86_64.zip'
     sha='326c826486d46a23cf9d5a1c9ee3a567d427bdd02c4a34071937a2a675cff004' },
  @{ key='ninja'; file='ninja-win-1.13.2.zip'
     url='https://github.com/ninja-build/ninja/releases/download/v1.13.2/ninja-win.zip'
     sha='07fc8261b42b20e71d1720b39068c2e14ffcee6396b76fb7a795fb460b78dc65' },
  @{ key='setuptools'; file='setuptools-84.2.1-py3-none-any.whl'
     url='https://files.pythonhosted.org/packages/ef/55/6dc6d6bb953bdfc52519a0059592c52b6e3b8ad51cf8256dffceb55b0610/setuptools-84.2.1-py3-none-any.whl'
     sha='ca140b45d5325a9478f880e351484f62fef15f336462e449ca0c03c873d589c2' },
  @{ key='rocm'; file="rocm-$RocmVersion.tar.gz"
     url="$AmdIndex/rocm/rocm-$RocmVersion.tar.gz"
     sha='e6616e62ebd1324031681e6e59349d46ee4f143a8d8f4f901a91c35c993041fc' },
  @{ key='rocm-core'; file="rocm_sdk_core-$RocmVersion-py3-none-win_amd64.whl"
     url="$AmdIndex/rocm-sdk-core/rocm_sdk_core-$RocmVersion-py3-none-win_amd64.whl"
     sha='b12f1c4cde14ed1cd8864006d17586c6b1e6a4e4695b9597cfe04ed7715e952f' },
  @{ key='rocm-libraries'; file="rocm_sdk_libraries-$RocmVersion-py3-none-win_amd64.whl"
     url="$AmdIndex/rocm-sdk-libraries/rocm_sdk_libraries-$RocmVersion-py3-none-win_amd64.whl"
     sha='0c34bafbb4aa626cc710d8b130bb314f591194c3d79eeb5892b755ea0be06159' },
  @{ key='rocm-device'; file="rocm_sdk_device_$GpuTarget-$RocmVersion-py3-none-win_amd64.whl"
     url="$AmdIndex/rocm-sdk-device-$GpuTarget/rocm_sdk_device_$GpuTarget-$RocmVersion-py3-none-win_amd64.whl"
     sha='56085e8f865b6b96c230fe8d1731074103553d0d958a31be13907d01e558fd0e' },
  @{ key='rocm-devel'; file="rocm_sdk_devel-$RocmVersion-py3-none-win_amd64.whl"
     url="$AmdIndex/rocm-sdk-devel/rocm_sdk_devel-$RocmVersion-py3-none-win_amd64.whl"
     sha='58847f1b2b30f9194188c38de6f9f3c71b8fdf6a10a203e8e7ec73d34a5c0c7e' },
  # Brilliance's FFmpeg, built from the recipe in win\ffmpeg (its README) and pinned by the zip's
  # SHA-256. It replaces BtbN's LGPL build (ffmpeg-n8.1.3-35-gf1acb0a266-win64-lgpl-shared-8.1.zip,
  # c11b3c0e...), which carried OpenH264. The zip is an asset of the v0.3.0-alpha.1 release (url).
  # A copy the recipe left in artifacts\ffmpeg ('local', relative to the checkout) is taken first
  # when present, hash-checked like a download.
  @{ key='ffmpeg'; file='brilliance-ffmpeg-8.1.3-win64-lgpl-20261118.zip'
     url='https://github.com/adamczhang/Brilliance/releases/download/v0.3.0-alpha.1/brilliance-ffmpeg-8.1.3-win64-lgpl-20261118.zip'
     local='artifacts\ffmpeg\brilliance-ffmpeg-8.1.3-win64-lgpl-20261118.zip'
     sha='1ebb1bdab0a56d1a47b342a5e4abbd9c7db21f507c7a7c711a11077e9e4a7f18' }
)
$FfmpegInner = 'brilliance-ffmpeg-8.1.3-win64-lgpl-20261118'
# The system half: Visual Studio Build Tools. The toolset is selected by this version prefix
# (vcvars64 -vcvars_ver), so a VS update that adds a newer toolset does not change the build.
$MsvcToolset = '14.51'
$SdkVersion  = '10.0.26100.0'
# The AMD driver. 0.3.0 is tested on 32.0.32015.12012 (Adrenalin 26.10.2) and needs it or later,
# as README.md and PREVIEW.md say; older drivers are not tested with this HIP runtime. Older than
# 32.0.32015.2008 (Adrenalin 26.9.2) is known bad as well: those drivers move an idle R9700's VRAM
# to system RAM (ROCm/TheRock#7221; radiance warns at start, win\device\hipnative.cpp).
$TestedDriver = [version]'32.0.32015.12012'
$MinDriver   = [version]'32.0.32015.2008'

$script:Problems = New-Object System.Collections.Generic.List[string]
$script:Advice   = New-Object System.Collections.Generic.List[string]
function Say-Step([string]$m) { Write-Host ''; Write-Host "== $m" -ForegroundColor Cyan }
function Say-Ok([string]$m)   { Write-Host "  ok    $m" -ForegroundColor Green }
function Say-Info([string]$m) { Write-Host "        $m" }
function Say-Warn([string]$m) { Write-Host "  warn  $m" -ForegroundColor Yellow; $script:Advice.Add($m) }
function Say-Bad([string]$m)  { Write-Host "  FAIL  $m" -ForegroundColor Red; $script:Problems.Add($m) }
function Get-RegValue([string]$Path, [string]$Name) {
  try { return (Get-ItemProperty -Path $Path -Name $Name -ErrorAction Stop).$Name } catch { return $null }
}
function Get-Sha256([string]$Path) { return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant() }

# ------------------------------------------------------------------------------------------ Windows
Say-Step 'Windows'
$cv = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
$build = [int](Get-RegValue $cv 'CurrentBuild')
Say-Info ("Windows {0} build {1}" -f (Get-RegValue $cv 'DisplayVersion'), $build)
if ($build -lt 26100) { Say-Warn "ROCm 10.1 is validated on Windows 11 24H2/25H2 (build 26100+); this is build $build" } else { Say-Ok 'Windows 11 24H2 or later' }
if ((Get-RegValue 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' 'LongPathsEnabled') -eq 1) { Say-Ok 'long paths enabled' }
else { Say-Warn 'LongPathsEnabled is off (admin: reg add HKLM\SYSTEM\CurrentControlSet\Control\FileSystem /v LongPathsEnabled /t REG_DWORD /d 1 /f)' }
$git = Get-Command git.exe -ErrorAction SilentlyContinue
if ($git) { Say-Ok ((& git.exe --version) -join '') } else { Say-Bad 'git is not on PATH' }

Say-Step 'AMD driver'
$r9700 = @(Get-PnpDevice -Class Display -PresentOnly -ErrorAction SilentlyContinue | Where-Object { $_.FriendlyName -match 'R9700' })
if ($r9700.Count -eq 0) { Say-Warn 'no Radeon AI PRO R9700 present (fine for a host-only build)' }
else {
  $drv = (Get-PnpDeviceProperty -InstanceId $r9700[0].InstanceId -KeyName DEVPKEY_Device_DriverVersion -ErrorAction SilentlyContinue).Data
  Say-Info ("{0} x Radeon AI PRO R9700, driver {1}" -f $r9700.Count, $drv)
  if ($drv -and ([version]$drv -lt $MinDriver)) { Say-Warn "driver $drv is older than $MinDriver (idle VRAM is moved to system RAM) and than $TestedDriver, the tested driver; update it" }
  elseif ($drv -and ([version]$drv -lt $TestedDriver)) { Say-Warn "driver $drv is older than $TestedDriver, the driver Brilliance 0.3.0 is tested on and needs; update it" }
  else { Say-Ok "driver new enough (tested on $TestedDriver)" }
}
if ([Environment]::GetEnvironmentVariable('HIP_PATH', 'Machine')) { Say-Warn 'a machine-wide HIP_PATH is set; win\env.ps1 overrides it per shell' }

# ------------------------------------------------------------------------------------------ VS
Say-Step "Visual Studio Build Tools (MSVC $MsvcToolset, SDK $SdkVersion)"
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$vs = $null
if (Test-Path $vswhere) {
  $vsPath = (& $vswhere -products * -latest -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath) | Select-Object -First 1
  if ($vsPath) {
    $msvcDirs = @(Get-ChildItem (Join-Path $vsPath 'VC\Tools\MSVC') -Directory -ErrorAction SilentlyContinue)
    $msvc = $msvcDirs | Where-Object { $_.Name -like "$MsvcToolset.*" } | Sort-Object Name -Descending | Select-Object -First 1
    $msvcFallback = $false
    if (-not $msvc) {
      $minVer = [version]"$MsvcToolset.0"
      $msvc = $msvcDirs | Where-Object {
        $v = $null; [version]::TryParse($_.Name, [ref]$v) -and $v.Major -eq $minVer.Major -and $v -ge $minVer
      } | Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
      $msvcFallback = [bool]$msvc
    }
    $vs = [pscustomobject]@{
      Path         = $vsPath
      Msvc         = $(if ($msvc) { $msvc.Name } else { $null })
      MsvcFallback = $msvcFallback
      Vcvars       = Join-Path $vsPath 'VC\Auxiliary\Build\vcvars64.bat'
      Sdk          = Test-Path (Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\Include\$SdkVersion")
      Libomp       = Join-Path $vsPath 'VC\Tools\Llvm\x64'
    }
  }
}
if (-not $vs) { Say-Bad 'no Visual Studio with the MSVC x64 tools (install VS Build Tools 2026 with the C++ workload)' }
else {
  if ($vs.Msvc -and $vs.MsvcFallback) { Say-Warn "MSVC toolset $($vs.Msvc) at $($vs.Path) (newer than tested $MsvcToolset.*)" }
  elseif ($vs.Msvc) { Say-Ok "MSVC toolset $($vs.Msvc) at $($vs.Path)" }
  else { Say-Bad "MSVC toolset $MsvcToolset.* (or newer $($MsvcToolset.Split('.')[0]).x) is not installed in $($vs.Path) (Visual Studio Installer: Individual components)" }
  if ($vs.Sdk) { Say-Ok "Windows SDK $SdkVersion" } else { Say-Bad "Windows SDK $SdkVersion is not installed" }
  if (Test-Path (Join-Path $vs.Libomp 'lib\libomp.lib')) { Say-Ok 'libomp (C++ Clang tools component)' }
  else { Say-Warn 'no libomp (VS component "C++ Clang tools for Windows"): the host kernels will build single-threaded' }
}

# ------------------------------------------------------------------------------------------ downloads
Say-Step 'Pinned archives (.toolchain\downloads)'
if (-not $CheckOnly) { New-Item -ItemType Directory -Force $Downloads | Out-Null }
$have = @{}
foreach ($p in $Pins) {
  $dst = Join-Path $Downloads $p.file
  if ($p.sha -like '@*@') { Say-Bad "$($p.file): no pinned SHA-256 in win\setup.ps1"; continue }
  $ok = (Test-Path $dst) -and ((Get-Sha256 $dst) -eq $p.sha)
  $local = $(if ($p.ContainsKey('local') -and $p.local) { Join-Path $Repo $p.local } else { $null })
  if (-not $ok -and -not $CheckOnly) {
    if ($local -and (Test-Path $local)) {
      # An archive built here and not yet published (the FFmpeg zip): copied, then checked.
      Say-Info "copying $($p.file) from $local"
      Copy-Item -Force $local $dst
    } elseif ($p.url) {
      Say-Info "downloading $($p.file)"
      & curl.exe -sSfL --retry 5 --retry-delay 5 -o $dst $p.url
      if ($LASTEXITCODE -ne 0) { Say-Bad "download failed: $($p.url) (curl $LASTEXITCODE)"; continue }
    } else {
      Say-Bad "$($p.file) has no download address: build it (win\ffmpeg\README.md) or copy it to $local"
      continue
    }
    $got = Get-Sha256 $dst
    if ($got -ne $p.sha) { Remove-Item -Force $dst; Say-Bad "$($p.file): SHA-256 $got, pinned $($p.sha) -- deleted"; continue }
    $ok = $true
  }
  if ($ok) { Say-Ok $p.file; $have[$p.key] = $dst } else { Say-Bad "$($p.file) missing (re-run without -CheckOnly)" }
}

# ------------------------------------------------------------------------------------------ install
function Expand-Into([string]$Archive, [string]$Dest, [string]$Inner) {
  # Extracts into a scratch directory beside the destination, then moves the one directory the
  # archive holds (or its contents, when $Inner is '') into place, so a failed extraction never
  # leaves a half-written tool where the build would find it.
  $tmp = "$Dest.extract"
  if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
  New-Item -ItemType Directory -Force $tmp | Out-Null
  & tar.exe -xf $Archive -C $tmp
  if ($LASTEXITCODE -ne 0) { throw "tar could not extract $Archive" }
  # The old tree is renamed aside before it is deleted: a rename fails whole while a process holds
  # a file in it (a test or a build using its DLLs, another checkout's tools), where a delete would
  # stop halfway and the move below would land the new tree INSIDE the remains of the old one.
  if (Test-Path $Dest) {
    $old = "$Dest.old"
    if (Test-Path $old) { Remove-Item -Recurse -Force $old -ErrorAction SilentlyContinue }
    try { Rename-Item -LiteralPath $Dest -NewName (Split-Path -Leaf $old) -ErrorAction Stop }
    catch {
      Remove-Item -Recurse -Force $tmp
      throw "$Dest is in use (a process holds a file in it) and was left as it was: stop what uses it and run setup again"
    }
    Remove-Item -Recurse -Force $old -ErrorAction SilentlyContinue
  }
  if ($Inner) { Move-Item (Join-Path $tmp $Inner) $Dest; Remove-Item -Recurse -Force $tmp }
  else { Move-Item $tmp $Dest }
}

$Python = Join-Path $Toolchain 'python\python.exe'
$Cmake  = Join-Path $Toolchain 'cmake\bin\cmake.exe'
$Ninja  = Join-Path $Toolchain 'ninja\ninja.exe'
$Venv   = Join-Path $Toolchain 'rocm-venv'
$VenvPy = Join-Path $Venv 'Scripts\python.exe'
$Ffmpeg = Join-Path $Toolchain 'ffmpeg'
# The SHA-256 of the archive .toolchain\ffmpeg was unpacked from, so a new pin replaces an old
# install (a checkout that still holds BtbN's build gets Brilliance's).
$FfmpegStamp = Join-Path $Ffmpeg '.archive-sha256'
$FfmpegSha = ($Pins | Where-Object { $_.key -eq 'ffmpeg' }).sha
function Get-FfmpegStamp {
  if (-not (Test-Path (Join-Path $Ffmpeg 'lib\avformat.lib')) -or -not (Test-Path $FfmpegStamp)) { return '' }
  return ([string](Get-Content -Path $FfmpegStamp -TotalCount 1)).Trim()
}

if (-not $CheckOnly -and $script:Problems.Count -eq 0) {
  Say-Step 'Installing into .toolchain'
  if ($Force -or -not (Test-Path $Python)) { Expand-Into $have['python'] (Join-Path $Toolchain 'python') 'python'; Say-Ok 'python' }
  if ($Force -or -not (Test-Path $Cmake))  { Expand-Into $have['cmake'] (Join-Path $Toolchain 'cmake') 'cmake-4.4.5-windows-x86_64'; Say-Ok 'cmake' }
  if ($Force -or -not (Test-Path $Ninja))  { Expand-Into $have['ninja'] (Join-Path $Toolchain 'ninja') ''; Say-Ok 'ninja' }
  if ($Force -or ((Get-FfmpegStamp) -ne $FfmpegSha)) {
    Expand-Into $have['ffmpeg'] $Ffmpeg $FfmpegInner
    Set-Content -Path $FfmpegStamp -Value $FfmpegSha -Encoding ASCII
    Say-Ok 'ffmpeg'
  }

  $venvOk = $false
  if ((Test-Path $VenvPy) -and -not $Force) {
    $v = (& $VenvPy -c "import importlib.metadata as m; print(m.version('rocm'))" 2>$null)
    $venvOk = ($LASTEXITCODE -eq 0 -and $v -and $v.Trim() -eq $RocmVersion)
  }
  if (-not $venvOk) {
    if (Test-Path $Venv) { Remove-Item -Recurse -Force $Venv }
    & $Python -m venv $Venv
    if ($LASTEXITCODE -ne 0) { throw 'python -m venv failed' }
    # From the checked archives only: --no-index, the downloads directory as the one source. The
    # rocm sdist builds with the pinned setuptools wheel from the same directory.
    Say-Info "pip install rocm[libraries,devel,device-$GpuTarget]==$RocmVersion from .toolchain\downloads"
    & $VenvPy -m pip install --no-index --find-links $Downloads --disable-pip-version-check "rocm[libraries,devel,device-$GpuTarget]==$RocmVersion"
    if ($LASTEXITCODE -ne 0) { throw "pip install of ROCm $RocmVersion failed" }
    # 'devel' is expanded on first init (and again whenever a device wheel is added).
    & $VenvPy -m rocm_sdk init
    if ($LASTEXITCODE -ne 0) { throw 'rocm-sdk init failed' }
  }
  Say-Ok "ROCm $RocmVersion venv"
}

# ------------------------------------------------------------------------------------------ verify
Say-Step 'Toolchain'
$RocmRoot = $null
if (Test-Path $VenvPy) {
  $RocmRoot = (& $VenvPy -m rocm_sdk path --root 2>$null)
  if ($RocmRoot) { $RocmRoot = $RocmRoot.Trim() }
}
$clang = $(if ($RocmRoot) { Join-Path $RocmRoot 'lib\llvm\bin\clang++.exe' } else { $null })
if ($clang -and (Test-Path $clang)) { Say-Ok ((& $clang --version | Select-Object -First 1)) } else { Say-Bad 'ROCm clang++ not installed' }
if (Test-Path $Cmake) { Say-Ok ((& $Cmake --version | Select-Object -First 1)) } else { Say-Bad 'cmake not installed' }
if (Test-Path $Ninja) { Say-Ok ("ninja " + (& $Ninja --version)) } else { Say-Bad 'ninja not installed' }
if ((Get-FfmpegStamp) -eq $FfmpegSha) { Say-Ok "FFmpeg (Brilliance's LGPL build, shared) $Ffmpeg" }
elseif (Test-Path (Join-Path $Ffmpeg 'lib\avformat.lib')) { Say-Bad "the FFmpeg in $Ffmpeg is not the pinned build (re-run without -CheckOnly to replace it)" }
else { Say-Bad 'FFmpeg not installed' }
if ($RocmRoot) {
  foreach ($dll in 'amdhip64_7.dll', 'amd_comgr.dll', 'rocm_kpack.dll') {
    if (Test-Path (Join-Path $RocmRoot "bin\$dll")) { Say-Ok "runtime $dll" } else { Say-Warn "runtime $dll missing from $RocmRoot\bin" }
  }
}

if (-not $CheckOnly -and $script:Problems.Count -eq 0) {
  $m = [ordered]@{
    rocm_version = $RocmVersion
    gpu_target   = $GpuTarget
    rocm_root    = $RocmRoot
    clang        = $clang
    cmake        = $Cmake
    ninja        = $Ninja
    python       = $Python
    vs_path      = $vs.Path
    vcvars       = $vs.Vcvars
    msvc_toolset = $vs.Msvc
    windows_sdk  = $SdkVersion
    libomp_dir   = $(if (Test-Path (Join-Path $vs.Libomp 'lib\libomp.lib')) { $vs.Libomp } else { $null })
    ffmpeg_root  = $(if (Test-Path (Join-Path $Ffmpeg 'lib\avformat.lib')) { $Ffmpeg } else { $null })
    archives     = [ordered]@{}
    written      = (Get-Date).ToString('s')
    machine      = $env:COMPUTERNAME
  }
  foreach ($p in $Pins) { $m.archives[$p.file] = $p.sha }
  $m | ConvertTo-Json -Depth 4 | Set-Content -Path $Manifest -Encoding ASCII
  Say-Ok "manifest $Manifest"
}

Say-Step 'Summary'
if ($script:Advice.Count) { Write-Host ("  {0} warning(s)." -f $script:Advice.Count) -ForegroundColor Yellow }
if ($script:Problems.Count) {
  Write-Host ("  {0} problem(s):" -f $script:Problems.Count) -ForegroundColor Red
  $script:Problems | ForEach-Object { Write-Host "    - $_" -ForegroundColor Red }
  exit 1
}
Write-Host '  toolchain ready. Next: . .\win\env.ps1' -ForegroundColor Green
exit 0
