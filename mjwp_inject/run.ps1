param(
    [Parameter(Mandatory = $false)]
    [string]$PlaySrc = (Join-Path $PSScriptRoot "..\\..\\mujoco-wasm-play"),

    [Parameter(Mandatory = $false)]
    [string]$PlayRef = "",

    [Parameter(Mandatory = $false)]
    [string]$WorkDir = (Join-Path ([System.IO.Path]::GetTempPath()) "mhr_mjwp_inject_main"),

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

function Get-TempRoot() {
    $tempRoot = [System.IO.Path]::GetTempPath()
    if (-not $tempRoot) {
        throw "Unable to resolve temp root."
    }
    return $tempRoot.TrimEnd('\', '/')
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

function Ensure-LodArtifacts([string]$RepoRoot, [string]$PythonExe, [int]$TargetLod) {
    $bundleRoot = Join-Path $RepoRoot "local_tools\\official_bundle"
    $bundleDir = Join-Path $bundleRoot ("lod{0}" -f $TargetLod)
    $bundleManifest = Join-Path $bundleDir "manifest.json"
    $runtimeIrRoot = Join-Path $RepoRoot "local_tools\\official_runtime_ir"
    $runtimeIrDir = Join-Path $runtimeIrRoot ("lod{0}" -f $TargetLod)
    $runtimeIrManifest = Join-Path $runtimeIrDir "manifest.json"

    if (-not (Test-Path -LiteralPath $bundleManifest)) {
        Write-Host "[mjwp_inject] preprocessing official bundle for lod$TargetLod -> $bundleDir"
        if (Test-Path -LiteralPath $bundleDir) {
            Remove-Item -LiteralPath $bundleDir -Recurse -Force
        }
        New-Item -ItemType Directory -Force -Path $bundleDir | Out-Null
        & $PythonExe (Join-Path $RepoRoot "tools\\mhr_asset_preprocess.py") --source-kind official --lod $TargetLod --out $bundleDir
        if ($LASTEXITCODE -ne 0) {
            throw "mhr_asset_preprocess.py failed with exit code $LASTEXITCODE"
        }
    }

    if ((-not (Test-Path -LiteralPath $runtimeIrManifest)) -and (Test-Path -LiteralPath $bundleManifest)) {
        Write-Host "[mjwp_inject] compiling official runtime IR for lod$TargetLod -> $runtimeIrDir"
        if (Test-Path -LiteralPath $runtimeIrDir) {
            Remove-Item -LiteralPath $runtimeIrDir -Recurse -Force
        }
        New-Item -ItemType Directory -Force -Path $runtimeIrDir | Out-Null
        & $PythonExe (Join-Path $RepoRoot "tools\\mhr_runtime_ir_compile.py") --manifest $bundleManifest --out $runtimeIrDir --zero-epsilon 0.0
        if ($LASTEXITCODE -ne 0) {
            throw "mhr_runtime_ir_compile.py failed with exit code $LASTEXITCODE"
        }
    }
}

function Copy-TreeIntoRoot([string]$SourceRoot, [string]$DestinationRoot) {
    $copiedFiles = @()
    if (-not (Test-Path -LiteralPath $SourceRoot)) {
        return $copiedFiles
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
        $copiedFiles += $relative.Replace('\', '/')
    }
    return $copiedFiles
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

function Remove-InjectedFiles([string]$CloneRoot, [object]$Meta) {
    if (-not $Meta) {
        return
    }
    $copiedFiles = @($Meta.copiedFiles)
    if ($copiedFiles.Count -eq 0) {
        return
    }

    $parentDirs = New-Object System.Collections.Generic.List[string]
    foreach ($relative in $copiedFiles) {
        if (-not $relative) {
            continue
        }
        $normalized = $relative.Replace('/', '\')
        $target = Join-Path $CloneRoot $normalized
        if (Test-Path -LiteralPath $target -PathType Leaf) {
            Remove-Item -LiteralPath $target -Force
        }
        $parent = Split-Path -Parent $target
        while ($parent -and $parent.StartsWith($CloneRoot, [System.StringComparison]::OrdinalIgnoreCase) -and ($parent.Length -gt $CloneRoot.Length)) {
            $parentDirs.Add($parent)
            $parent = Split-Path -Parent $parent
        }
    }

    $parentDirs |
        Sort-Object Length -Descending -Unique |
        ForEach-Object {
            if ((Test-Path -LiteralPath $_ -PathType Container) -and -not (Get-ChildItem -LiteralPath $_ -Force -ErrorAction SilentlyContinue | Select-Object -First 1)) {
                Remove-Item -LiteralPath $_ -Force
            }
        }
}

function Read-InjectMeta([string]$MetaPath) {
    if (-not (Test-Path -LiteralPath $MetaPath)) {
        return $null
    }
    try {
        return (Get-Content -LiteralPath $MetaPath -Raw | ConvertFrom-Json)
    } catch {
        Write-Warning "[mjwp_inject] failed to parse existing meta file; continuing without reuse cleanup."
        return $null
    }
}

function Normalize-InjectWorkDir([string]$PathLike) {
    if (-not $PathLike) {
        return ""
    }
    $candidate = $PathLike.Trim().Trim('"')
    if (-not $candidate) {
        return ""
    }
    if (Test-Path -LiteralPath $candidate) {
        $candidate = (Resolve-Path -LiteralPath $candidate).Path
    }
    $current = $candidate.TrimEnd('\', '/')
    while ($current) {
        $leaf = Split-Path -Leaf $current
        if ($leaf -like 'mhr_mjwp_inject*') {
            return $current
        }
        $parent = Split-Path -Parent $current
        if (-not $parent -or $parent -eq $current) {
            break
        }
        $current = $parent
    }
    return $candidate.TrimEnd('\', '/')
}

function Get-ActiveInjectWorkDirs() {
    $activeDirs = @()
    foreach ($process in (Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {
        if ($process.ProcessId -eq $PID) {
            continue
        }
        if ($process.Name -notmatch '^python(?:w)?\.exe$') {
            continue
        }
        $commandLine = $process.CommandLine
        if (-not $commandLine -or $commandLine -notmatch 'mjwp_inject\\server\.py') {
            continue
        }
        $rootMatch = [regex]::Match($commandLine, '(?i)--root\s+("([^"]+)"|([^\s"]+))')
        if (-not $rootMatch.Success) {
            continue
        }
        $rootArg = if ($rootMatch.Groups[2].Success) { $rootMatch.Groups[2].Value } else { $rootMatch.Groups[3].Value }
        $candidate = Normalize-InjectWorkDir $rootArg
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Container)) {
            $resolved = (Resolve-Path -LiteralPath $candidate).Path
            if ($resolved -and -not ($activeDirs -contains $resolved)) {
                $activeDirs += $resolved
            }
        }
    }
    return $activeDirs
}

function Prune-TempInjectWorkDirs([string]$CurrentWorkDir) {
    $tempRoot = Get-TempRoot
    if (-not $CurrentWorkDir) {
        return
    }
    if (-not $CurrentWorkDir.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        return
    }

    $defaultWorkDirs = @(
        (Join-Path $tempRoot 'mhr_mjwp_inject_main'),
        (Join-Path $tempRoot 'mhr_mjwp_inject')
    )
    $activeDirs = Get-ActiveInjectWorkDirs
    $allDirs = @(Get-ChildItem -LiteralPath $tempRoot -Directory -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'mhr_mjwp_inject*' })
    $removed = 0

    foreach ($dir in $allDirs) {
        $resolvedDir = (Resolve-Path -LiteralPath $dir.FullName).Path
        if ($resolvedDir -eq $CurrentWorkDir) {
            continue
        }
        if ($defaultWorkDirs -contains $resolvedDir) {
            continue
        }
        if ($activeDirs -contains $resolvedDir) {
            continue
        }
        try {
            Remove-Item -LiteralPath $resolvedDir -Recurse -Force -ErrorAction Stop
            $removed += 1
        } catch {
            Write-Warning "[mjwp_inject] failed to prune stale temp work dir: $resolvedDir"
        }
    }

    if ($removed -gt 0) {
        Write-Host "[mjwp_inject] pruned $removed stale temp work directories."
    }
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
$officialRuntimeIrRoot = Join-Path $repoRoot "local_tools\\official_runtime_ir"

if (-not (Test-Path -LiteralPath (Join-Path $playSrcAbs ".git"))) {
    throw "PlaySrc must point to a git checkout: $playSrcAbs"
}

foreach ($supportedLod in 0..6) {
    Ensure-LodArtifacts -RepoRoot $repoRoot -PythonExe $pythonExe -TargetLod $supportedLod
}

Prune-TempInjectWorkDirs -CurrentWorkDir $workDirAbs
$activeInjectWorkDirs = Get-ActiveInjectWorkDirs

$needFreshClone = $Clean.IsPresent -or (-not (Test-Path -LiteralPath (Join-Path $playClone ".git")))
if ($needFreshClone -and (Test-Path -LiteralPath $playClone)) {
    if ($activeInjectWorkDirs -contains $workDirAbs) {
        throw "WorkDir is currently in use by an active mjwp_inject server: $workDirAbs. Stop that server or choose a different -WorkDir."
    }
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

$existingMeta = Read-InjectMeta -MetaPath $metaPath
Remove-InjectedFiles -CloneRoot $playClone -Meta $existingMeta

$patches = Apply-PatchSet $patchRoot $playClone

Write-Host "[mjwp_inject] copying MHR plugin and page files"
$copiedFiles = @()
$copiedFiles += Copy-TreeIntoRoot $pluginRoot $playClone
$copiedFiles += Copy-TreeIntoRoot $siteRoot $playClone

$meta = @{
    repoRoot = $repoRoot
    playSrc = $playSrcAbs
    playRef = if ($PlayRef) { $PlayRef } else { "" }
    lod = $Lod
    appliedAt = (Get-Date).ToString("o")
    patchCount = @($patches).Count
    copiedFiles = @($copiedFiles | Sort-Object -Unique)
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
