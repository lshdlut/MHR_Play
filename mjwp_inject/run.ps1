param(
    [Parameter(Mandatory = $false)]
    [string]$PlaySrc = (Join-Path $PSScriptRoot "..\\..\\mujoco-wasm-play"),

    [Parameter(Mandatory = $false)]
    [string]$PlayRef = "",

    [Parameter(Mandatory = $false)]
    [string]$WorkDir = (Join-Path $env:TEMP "mhr_mjwp_inject"),

    [Parameter(Mandatory = $false)]
    [int]$Port = 4173,

    [Parameter(Mandatory = $false)]
    [int]$Lod = 1,

    [Parameter(Mandatory = $false)]
    [switch]$NoServe,

    [Parameter(Mandatory = $false)]
    [switch]$Clean
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Resolve-AbsPath([string]$PathLike) {
    return (Resolve-Path -LiteralPath $PathLike).Path
}

function Resolve-PythonExe() {
    if ($env:PYTHON_EXE -and (Test-Path -LiteralPath $env:PYTHON_EXE)) {
        return (Resolve-Path -LiteralPath $env:PYTHON_EXE).Path
    }
    $cmd = Get-Command python -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $cmd = Get-Command py -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    throw "Required tool not found in PATH: python (or set PYTHON_EXE)."
}

function Copy-TreeIntoRoot([string]$SourceRoot, [string]$DestinationRoot) {
    if (-not (Test-Path -LiteralPath $SourceRoot)) {
        return
    }
    Get-ChildItem -LiteralPath $SourceRoot -Recurse -Force | ForEach-Object {
        $relative = $_.FullName.Substring($SourceRoot.Length).TrimStart('\', '/')
        if (-not $relative) { return }
        $target = Join-Path $DestinationRoot $relative
        if ($_.PSIsContainer) {
            New-Item -ItemType Directory -Force -Path $target | Out-Null
            return
        }
        $targetParent = Split-Path -Parent $target
        if ($targetParent) {
            New-Item -ItemType Directory -Force -Path $targetParent | Out-Null
        }
        Copy-Item -LiteralPath $_.FullName -Destination $target -Force
    }
}

function Copy-FileIntoRoot([string]$SourceFile, [string]$DestinationFile) {
    $targetParent = Split-Path -Parent $DestinationFile
    if ($targetParent) {
        New-Item -ItemType Directory -Force -Path $targetParent | Out-Null
    }
    Copy-Item -LiteralPath $SourceFile -Destination $DestinationFile -Force
}

function Apply-PatchSet([string]$PatchRoot, [string]$DestinationRoot) {
    if (-not (Test-Path -LiteralPath $PatchRoot)) {
        return @()
    }
    $patches = @(Get-ChildItem -LiteralPath $PatchRoot -Filter *.patch -File | Sort-Object Name)
    foreach ($patch in $patches) {
        Write-Host "[mjwp_inject] applying patch -> $($patch.Name)"
        & git -C $DestinationRoot apply --ignore-space-change --ignore-whitespace $patch.FullName
        if ($LASTEXITCODE -ne 0) {
            throw "git apply failed for patch $($patch.FullName)"
        }
    }
    return $patches
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw "Required tool not found in PATH: git"
}
if ($Lod -lt 0) {
    throw "Lod must be a non-negative integer."
}

$pythonExe = Resolve-PythonExe
$repoRoot = Resolve-AbsPath (Join-Path $PSScriptRoot "..")
$playSrcAbs = Resolve-AbsPath $PlaySrc
$workDirAbs = Resolve-AbsPath (New-Item -ItemType Directory -Force -Path $WorkDir).FullName
$pluginRoot = Resolve-AbsPath (Join-Path $repoRoot "mjwp_inject\\plugin")
$siteRoot = Resolve-AbsPath (Join-Path $repoRoot "mjwp_inject\\site")
$patchRoot = Resolve-AbsPath (Join-Path $repoRoot "mjwp_inject\\patches")
$playClone = Join-Path $workDirAbs "play"
$metaPath = Join-Path $playClone ".mjwp_inject_meta.json"
$playParent = Split-Path -Parent $playSrcAbs
$playForgeRoot = Join-Path $playParent "mujoco-wasm-forge"
$officialBundleRoot = Join-Path $repoRoot "local_tools\\official_bundle"
$officialBundleDir = Join-Path $officialBundleRoot ("lod{0}" -f $Lod)
$officialBundleManifest = Join-Path $officialBundleDir "manifest.json"
$officialRuntimeIrRoot = Join-Path $repoRoot "local_tools\\official_runtime_ir"
$officialRuntimeIrDir = Join-Path $officialRuntimeIrRoot ("lod{0}" -f $Lod)
$officialRuntimeIrManifest = Join-Path $officialRuntimeIrDir "manifest.json"

if (-not (Test-Path -LiteralPath (Join-Path $playSrcAbs ".git"))) {
    throw "PlaySrc must point to a git checkout: $playSrcAbs"
}

if (-not (Test-Path -LiteralPath $officialBundleManifest)) {
    Write-Host "[mjwp_inject] preprocessing official bundle for lod$Lod -> $officialBundleDir"
    if (Test-Path -LiteralPath $officialBundleDir) {
        Remove-Item -LiteralPath $officialBundleDir -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path $officialBundleDir | Out-Null
    & $pythonExe (Join-Path $repoRoot "tools\\mhr_asset_preprocess.py") --source-kind official --lod $Lod --out $officialBundleDir
    if ($LASTEXITCODE -ne 0) {
        throw "mhr_asset_preprocess.py failed with exit code $LASTEXITCODE"
    }
}

if ((-not (Test-Path -LiteralPath $officialRuntimeIrManifest)) -and (Test-Path -LiteralPath $officialBundleManifest)) {
    Write-Host "[mjwp_inject] compiling official runtime IR for lod$Lod -> $officialRuntimeIrDir"
    if (Test-Path -LiteralPath $officialRuntimeIrDir) {
        Remove-Item -LiteralPath $officialRuntimeIrDir -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path $officialRuntimeIrDir | Out-Null
    & $pythonExe (Join-Path $repoRoot "tools\\mhr_runtime_ir_compile.py") --manifest $officialBundleManifest --out $officialRuntimeIrDir --zero-epsilon 0.0
    if ($LASTEXITCODE -ne 0) {
        throw "mhr_runtime_ir_compile.py failed with exit code $LASTEXITCODE"
    }
}

$needFreshClone = $Clean.IsPresent -or (-not (Test-Path -LiteralPath (Join-Path $playClone ".git")))
if ($needFreshClone -and (Test-Path -LiteralPath $playClone)) {
    Write-Host "[mjwp_inject] removing existing play clone -> $playClone"
    Remove-Item -LiteralPath $playClone -Recurse -Force
}

if (-not (Test-Path -LiteralPath (Join-Path $playClone ".git"))) {
    Write-Host "[mjwp_inject] cloning mujoco-wasm-play -> $playClone"
    & git clone --origin origin $playSrcAbs $playClone
    if ($LASTEXITCODE -ne 0) {
        throw "git clone failed with exit code $LASTEXITCODE"
    }
} else {
    Write-Host "[mjwp_inject] reusing existing play clone -> $playClone"
    & git -C $playClone fetch --force --prune origin
    if ($LASTEXITCODE -ne 0) {
        throw "git fetch failed with exit code $LASTEXITCODE"
    }
}

if ($PlayRef) {
    Write-Host "[mjwp_inject] checking out PlayRef -> $PlayRef"
    & git -C $playClone checkout --force $PlayRef
    if ($LASTEXITCODE -ne 0) {
        throw "git checkout failed with exit code $LASTEXITCODE"
    }
} else {
    Write-Host "[mjwp_inject] resetting clone to PlaySrc HEAD"
    $head = (& git -C $playSrcAbs rev-parse HEAD).Trim()
    if (-not $head) {
        throw "Failed to resolve PlaySrc HEAD."
    }
    & git -C $playClone checkout --force $head
    if ($LASTEXITCODE -ne 0) {
        throw "git checkout HEAD failed with exit code $LASTEXITCODE"
    }
}

$patches = Apply-PatchSet $patchRoot $playClone

Write-Host "[mjwp_inject] copying MHR plugin and page files"
Copy-TreeIntoRoot $pluginRoot $playClone
Copy-TreeIntoRoot $siteRoot $playClone

$meta = @{
    repoRoot = $repoRoot
    playSrc = $playSrcAbs
    playRef = if ($PlayRef) { $PlayRef } else { "" }
    lod = $Lod
    appliedAt = (Get-Date).ToString("o")
    patchCount = @($patches).Count
    sharedCopies = @()
}
$meta | ConvertTo-Json | Set-Content -LiteralPath $metaPath -Encoding UTF8

$url = "http://127.0.0.1:$Port/mhr.html?lod=$Lod"
Write-Host "[mjwp_inject] ready."
Write-Host "  Play clone:  $playClone"
Write-Host "  Repo root:   $repoRoot"
Write-Host "  URL:         $url"

if ($NoServe) {
    return
}

Write-Host "[mjwp_inject] serving play clone on port $Port (Ctrl+C to stop)"
& $pythonExe (Join-Path $repoRoot "mjwp_inject\\server.py") `
    --root $playClone `
    --repo-root $repoRoot `
    --forge-root $playForgeRoot `
    --official-root $officialRuntimeIrRoot `
    --port $Port
if ($LASTEXITCODE -ne 0) {
    throw "mjwp_inject/server.py failed with exit code $LASTEXITCODE"
}
