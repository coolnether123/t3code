# Queued hosts may disable module autoloading. JSON, sorting and host output
# below require Utility even though hashing itself uses .NET.
Import-Module Microsoft.PowerShell.Utility -ErrorAction Stop

# These paths are owned by the deploy checkout or by the D-backed runtime.
# The synchronizer never removes them and never copies over them.
$immutableProjection = $false
$usePreparedVp = $false
$singleThreadedTypecheck = $false

function Copy-T3ControlScripts {
    param([Parameter(Mandatory)][string]$Repository, [Parameter(Mandatory)][string]$ControlRoot)
    $Repository = Assert-SafeRoot $Repository 'maintenance source'
    if (Invoke-GitText $Repository @('status', '--porcelain')) { throw 'Maintenance scripts require a clean source candidate' }
    $sha = Invoke-GitText $Repository @('rev-parse', 'HEAD')
    $ControlRoot = Normalize-AbsolutePath $ControlRoot
    if ((Test-SamePath $Repository $ControlRoot) -or $ControlRoot.StartsWith($Repository + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Maintenance controls must be outside the source checkout' }
    New-Item -ItemType Directory -Path $ControlRoot -Force | Out-Null
    [void](Assert-SafeRoot $ControlRoot 'maintenance controls')
    $target = Join-Path $ControlRoot $sha
    $files = @('t3-nightly-sync.mjs','t3-nightly-check.mjs','t3-nightly-task-links.mjs','t3-build-job.mjs','t3-deploy.mjs','t3-deploy-idle.mjs','t3-release-state.mjs','t3-supervisor.mjs')
    if (-not (Test-Path -LiteralPath $target)) {
        $staging = Join-Path $ControlRoot ('.copy-' + [Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $staging | Out-Null
        foreach ($name in $files) { Copy-Item -LiteralPath (Join-Path $Repository ('scripts/' + $name)) -Destination (Join-Path $staging $name) }
        [IO.File]::WriteAllText((Join-Path $staging 'maintenance-control.json'), (@{commit=$sha;files=@($files | ForEach-Object { @{path=$_;sha256=(Get-FileSha256 (Join-Path $staging $_))} })} | ConvertTo-Json -Depth 6))
        [IO.Directory]::Move($staging, $target)
    }
    [void](Assert-SafeRoot $target 'versioned maintenance controls')
    if ((Get-Content -LiteralPath (Join-Path $target 'maintenance-control.json') -Raw | ConvertFrom-Json).commit -ne $sha) { throw 'Maintenance control receipt identity changed' }
    foreach ($name in $files) {
        if ((Get-FileSha256 (Join-Path $target $name)) -ne (Get-FileSha256 (Join-Path $Repository ('scripts/' + $name)))) { throw 'Versioned maintenance control identity changed' }
    }
    return $target
}
$excludedRelativeFiles = @(
    ".git",
    ".env",
    ".env.local",
    "infra\relay\.env",
    "infra\relay\.env.local",
    "apps\mobile\src\features\usage\usageProviders.ts",
    "scripts\import-codex-history.mjs",
    "apps\desktop\tsconfig.tsbuildinfo",
    "apps\web\tsconfig.tsbuildinfo"
)

$excludedDirectoryNames = @(
    ".git",
    ".logs",
    ".generated",
    ".plans",
    ".cache",
    ".turbo",
    "secrets",
    "logs",
    ".trigger-tree",
    ".t3",
    ".vite-plus",
    "node_modules",
    "caches",
    "dist",
    "dist-electron",
    "target",
    "userdata",
    "work",
    "worktrees",
    "release"
)

function Write-Phase {
    param([Parameter(Mandatory)][string]$Name)
    Write-Host "[$Name]"
}

function Write-Plan {
    param([Parameter(Mandatory)][string]$Message)
    if ($planOnly) {
        Write-Host "  PLAN $Message"
    }
    else {
        Write-Host "  $Message"
    }
}

function Normalize-AbsolutePath {
    param([Parameter(Mandatory)][string]$Path)
    $full = [System.IO.Path]::GetFullPath($Path)
    return $full.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
}

function Test-SamePath {
    param(
        [Parameter(Mandatory)][string]$Left,
        [Parameter(Mandatory)][string]$Right
    )
    return (Normalize-AbsolutePath $Left).Equals((Normalize-AbsolutePath $Right), [System.StringComparison]::OrdinalIgnoreCase)
}

function Assert-SafeRoot {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Label
    )
    if ($Path -notmatch '^[A-Za-z]:[\\/]') {
        throw "$Label must be an absolute path: $Path"
    }
    $resolved = Normalize-AbsolutePath $Path
    if ($resolved.Length -lt 4 -or $resolved -match '^[A-Za-z]:$') {
        throw "$Label resolves to an unsafe broad path: $resolved"
    }
    if (-not (Test-Path -LiteralPath $resolved -PathType Container)) {
        throw "$Label does not exist as a directory: $resolved"
    }
    $ancestor = $resolved
    while ($ancestor) {
        $item = Get-Item -LiteralPath $ancestor -Force
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "$Label has a reparse point. Refusing to operate through it: $ancestor"
        }
        $ancestor = [System.IO.Path]::GetDirectoryName($ancestor)
    }
    return $resolved
}

function Assert-ContainedPath {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$Candidate,
        [Parameter(Mandatory)][string]$Label
    )
    $rootFull = (Normalize-AbsolutePath $Root) + [System.IO.Path]::DirectorySeparatorChar
    $candidateFull = Normalize-AbsolutePath $Candidate
    if (-not $candidateFull.StartsWith($rootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "$Label is outside its approved root: $candidateFull"
    }
    return $candidateFull
}

function Invoke-GitText {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string[]]$Arguments
    )
    $savedErrorAction = $ErrorActionPreference
    try {
        # PowerShell 5 treats Git's progress on stderr as an exception under Stop.
        $ErrorActionPreference = 'Continue'
        $result = & git -C $Root @Arguments 2>&1
        $gitExit = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $savedErrorAction
    }
    if ($gitExit -ne 0) {
        throw "git $($Arguments -join ' ') failed in $Root with exit code ${gitExit}: $(($result | Out-String).Trim())"
    }
    return (($result | Out-String).Trim())
}

function Test-ExcludedRelativePath {
    param([Parameter(Mandatory)][string]$RelativePath)
    $normalized = $RelativePath.Replace('/', '\').TrimStart('\')
    $comparison = $normalized.ToLowerInvariant()
    $leaf = [System.IO.Path]::GetFileName($normalized)
    if ($immutableProjection -and ($normalized -split '\\')[0] -eq '.repos') { return $true }
    if ($leaf -like ".env*" -or (-not $immutableProjection -and $leaf -in @("settings.json", "settings.local.json")) -or $leaf -like "*.tsbuildinfo") {
        return $true
    }
    foreach ($excluded in $excludedRelativeFiles) {
        if ($comparison -eq $excluded.ToLowerInvariant()) {
            return $true
        }
    }
    foreach ($part in ($normalized -split '\\')) {
        if ($immutableProjection -and $part -in @('secrets', 'userdata', 'work', 'worktrees', 'release')) {
            if (($normalized -split '\\')[0] -eq $part) { return $true }
            continue
        }
        if ($excludedDirectoryNames -contains $part.ToLowerInvariant()) {
            return $true
        }
    }
    return $false
}

function Get-IncludedFiles {
    param([Parameter(Mandatory)][string]$Root)
    $pending = New-Object 'System.Collections.Generic.Stack[string]'
    $pending.Push($Root)
    $files = New-Object 'System.Collections.Generic.List[object]'

    while ($pending.Count -gt 0) {
        $directory = $pending.Pop()
        foreach ($item in @(Get-ChildItem -LiteralPath $directory -Force)) {
            $relative = $item.FullName.Substring($Root.Length).TrimStart('\', '/')
            if (Test-ExcludedRelativePath $relative) {
                continue
            }
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Refusing to traverse or copy a reparse point in the owned source projection: $($item.FullName)"
            }
            if ($item.PSIsContainer) {
                $pending.Push($item.FullName)
            }
            elseif ($item -is [System.IO.FileInfo]) {
                [void]$files.Add([pscustomobject]@{ Relative = $relative; FullName = $item.FullName })
            }
        }
    }
    return @($files.ToArray())
}

function Get-FileSha256 {
    param([Parameter(Mandatory)][string]$Path)
    # The build queue's PowerShell host does not autoload Microsoft.PowerShell.Utility.
    $stream = [IO.File]::OpenRead($Path)
    try {
        $sha = [Security.Cryptography.SHA256]::Create()
        try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '') }
        finally { $sha.Dispose() }
    } finally { $stream.Dispose() }
}

function Get-TextSha256 {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Text)
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
        return ([System.BitConverter]::ToString($algorithm.ComputeHash($bytes))).Replace("-", "")
    }
    finally {
        $algorithm.Dispose()
    }
}

function Get-ProjectionIdentity {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][object[]]$Files,
        [Parameter(Mandatory)][hashtable]$FingerprintMap
    )
    $entries = @($Files | Sort-Object Relative | ForEach-Object {
        $key = $_.Relative.ToLowerInvariant()
        [ordered]@{
            path = $_.Relative.Replace('\', '/')
            bytes = [int64](Get-Item -LiteralPath $_.FullName).Length
            sha256 = $FingerprintMap[$key]
        }
    })
    $identityText = (($entries | ForEach-Object {
        "$($_.path)`0$($_.bytes)`0$($_.sha256)"
    }) -join "`n")
    return [ordered]@{
        root = $Root
        fileCount = $entries.Count
        sha256 = Get-TextSha256 $identityText
        files = $entries
    }
}

function Get-BuildArtifactIdentity {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string[]]$RelativePaths
    )
    return @($RelativePaths | ForEach-Object {
        $fullPath = Assert-ContainedPath $Root (Join-Path $Root $_) "build artifact"
        if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
            return [ordered]@{ path = $_.Replace('\', '/'); present = $false }
        }
        $item = Get-Item -LiteralPath $fullPath
        return [ordered]@{
            path = $_.Replace('\', '/')
            present = $true
            bytes = [int64]$item.Length
            sha256 = Get-FileSha256 $fullPath
        }
    })
}

function Get-FingerprintMap {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Files
    )
    $map = @{}
    foreach ($file in $Files) {
        $map[$file.Relative.ToLowerInvariant()] = Get-FileSha256 $file.FullName
    }
    return $map
}

function Get-DependencyRelativePaths {
    param([Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Files)
    return @($Files | Where-Object {
        $name = [System.IO.Path]::GetFileName($_.Relative)
        $name -eq "package.json" -or $name -eq "pnpm-lock.yaml" -or $name -eq "pnpm-workspace.yaml"
    } | ForEach-Object { $_.Relative.ToLowerInvariant() })
}

function Get-StaleDeployFiles {
    param(
        [Parameter(Mandatory)][string]$SourceRoot,
        [Parameter(Mandatory)][string]$DeployRoot
    )
    $source = @{}
    foreach ($file in @(Get-IncludedFiles $SourceRoot)) {
        $source[$file.Relative.ToLowerInvariant()] = $true
    }
    return @(Get-IncludedFiles $DeployRoot | Where-Object {
        -not $source.ContainsKey($_.Relative.ToLowerInvariant())
    } | Sort-Object Relative)
}

function Assert-MirrorFile {
    param([string]$Root, [string]$Relative)
    $candidate = Assert-ContainedPath $Root (Join-Path $Root $Relative) "prune file"
    if (Test-ExcludedRelativePath $Relative) {
        throw "Refusing to prune a protected path: $Relative"
    }
    $ancestor = $candidate
    while (-not (Test-SamePath $ancestor $Root)) {
        $item = Get-Item -LiteralPath $ancestor -Force
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Refusing to prune through a reparse point: $ancestor"
        }
        $ancestor = [System.IO.Path]::GetDirectoryName($ancestor)
    }
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
        throw "Prune candidate is no longer a file: $candidate"
    }
    return $candidate
}

function Remove-StaleDeployFiles {
    param(
        [Parameter(Mandatory)][string]$SourceRoot,
        [Parameter(Mandatory)][string]$DeployRoot,
        [Parameter(Mandatory)][string]$ArtifactRoot,
        [Parameter(Mandatory)][string]$DeployCommit,
        [switch]$PlanOnly
    )
    $SourceRoot = Assert-SafeRoot $SourceRoot "prune source"
    $DeployRoot = Assert-SafeRoot $DeployRoot "prune mirror"
    if ((Test-SamePath $SourceRoot $DeployRoot) -or
        $SourceRoot.StartsWith($DeployRoot + '\', [StringComparison]::OrdinalIgnoreCase) -or
        $DeployRoot.StartsWith($SourceRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "Prune source and mirror must be separate trees."
    }
    $stale = @(Get-StaleDeployFiles $SourceRoot $DeployRoot)
    Write-Host "  stale deploy files $($stale.Count)"
    if ($PlanOnly) {
        foreach ($file in $stale) { Write-Host "  PRUNE $($file.Relative)" }
        return $stale.Count
    }
    if ($stale.Count -eq 0) { return 0 }
    if ($DeployCommit -notmatch '^[a-fA-F0-9]{40}$') { throw "Invalid deploy commit for backup name." }
    $artifactFull = Normalize-AbsolutePath $ArtifactRoot
    foreach ($root in @($SourceRoot, $DeployRoot)) {
        if ((Test-SamePath $root $artifactFull) -or $artifactFull.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) {
            throw "Prune backups must be outside source and mirror."
        }
    }
    New-Item -ItemType Directory -Path $artifactFull -Force | Out-Null
    $artifactFull = Assert-SafeRoot $artifactFull "prune artifacts"
    $backup = Join-Path $artifactFull "deploy-pruned-$DeployCommit-$([Guid]::NewGuid().ToString('N')).tar"
    $listPath = $backup + ".files.nul"
    $verifyRoot = $backup + ".verify"
    $hashes = @{}
    foreach ($file in $stale) {
        $path = Assert-MirrorFile $DeployRoot $file.Relative
        $hashes[$file.Relative] = Get-FileSha256 $path
        if ($file.Relative -match '[\r\n]') { throw "Cannot archive a path containing a newline." }
    }
    # ./ prevents a file name from being interpreted as an archive option.
    [IO.File]::WriteAllText($listPath, ((@($stale | ForEach-Object { './' + $_.Relative.Replace('\', '/') }) -join "`0") + "`0"), (New-Object Text.UTF8Encoding($false)))
    $tarPath = Join-Path $env:SystemRoot "System32\tar.exe"
    # Windows tar reads non-ASCII list files incorrectly. Pass Unicode arguments
    # in bounded batches to stay below the Windows command-line limit.
    $batch = New-Object 'System.Collections.Generic.List[string]'
    $batchLength = 0
    $archiveMode = '-cf'
    foreach ($file in @($stale) + @($null)) {
        $relative = if ($null -ne $file) { './' + $file.Relative.Replace('\', '/') } else { '' }
        if ($batch.Count -gt 0 -and ($batchLength + $relative.Length -gt 16000 -or $null -eq $file)) {
            & $tarPath $archiveMode $backup -C $DeployRoot @($batch.ToArray())
            if ($LASTEXITCODE -ne 0) { throw "Prune backup failed. No files deleted." }
            $archiveMode = '-rf'
            $batch.Clear()
            $batchLength = 0
        }
        if ($null -ne $file) {
            $batch.Add($relative)
            $batchLength += $relative.Length + 3
        }
    }
    New-Item -ItemType Directory -Path $verifyRoot | Out-Null
    & $tarPath -xf $backup -C $verifyRoot
    if ($LASTEXITCODE -ne 0) { throw "Prune backup extraction failed. No files deleted." }
    foreach ($file in $stale) {
        $archived = Assert-MirrorFile $verifyRoot $file.Relative
        if ((Get-FileSha256 $archived) -ne $hashes[$file.Relative]) {
            throw "Prune backup verification failed: $($file.Relative). No files deleted."
        }
    }
    Write-Host "  verified backup of $($stale.Count) files: $backup"
    # Recheck the whole batch before deletion, including files added to source during backup.
    $currentStale = @{}
    foreach ($file in @(Get-StaleDeployFiles $SourceRoot $DeployRoot)) { $currentStale[$file.Relative] = $true }
    foreach ($file in $stale) {
        $path = Assert-MirrorFile $DeployRoot $file.Relative
        if (-not $currentStale.ContainsKey($file.Relative) -or (Get-FileSha256 $path) -ne $hashes[$file.Relative]) {
            throw "Projection changed during backup. No files deleted; retry with a fresh plan."
        }
    }
    foreach ($file in $stale) {
        $path = Assert-MirrorFile $DeployRoot $file.Relative
        Remove-Item -LiteralPath $path -Force
    }
    # Only remove the disposable extraction after its absolute containment is checked.
    $verifyRoot = Assert-ContainedPath $artifactFull $verifyRoot "backup verification directory"
    [void](Assert-SafeRoot $verifyRoot "backup verification directory")
    Remove-Item -LiteralPath $verifyRoot -Recurse -Force
    Write-Host "  pruned $($stale.Count) deploy files"
    return $stale.Count
}

function Sync-TrackedSourceFiles {
    param(
        [Parameter(Mandatory)][string]$SourceRoot,
        [Parameter(Mandatory)][string]$DeployRoot,
        [switch]$PlanOnly
    )
    $sourceFiles = @(Get-IncludedFiles $SourceRoot)
    $deployFiles = @(Get-IncludedFiles $DeployRoot)
    $sourceMap = Get-FingerprintMap $SourceRoot $sourceFiles
    $deployMap = Get-FingerprintMap $DeployRoot $deployFiles
    $mismatches = @($sourceFiles | Where-Object {
        $key = $_.Relative.ToLowerInvariant()
        -not $deployMap.ContainsKey($key) -or $deployMap[$key] -ne $sourceMap[$key]
    })
    if ($mismatches.Count -eq 0) {
        Write-Plan "Deploy projection already matches source."
        return 0
    }
    if ($PlanOnly) {
        Write-Plan "Would copy $($mismatches.Count) source files into deploy."
        return $mismatches.Count
    }
    foreach ($file in $mismatches) {
        $destination = Assert-ContainedPath $DeployRoot (Join-Path $DeployRoot $file.Relative) "sync destination"
        $parent = [System.IO.Path]::GetDirectoryName($destination)
        if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
            New-Item -ItemType Directory -Path $parent -Force | Out-Null
        }
        $parentItem = Get-Item -LiteralPath $parent -Force
        if (($parentItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Sync destination parent is a reparse point: $parent"
        }
        Copy-Item -LiteralPath $file.FullName -Destination $destination -Force
    }
    Write-Host "  copied $($mismatches.Count) files."
    return $mismatches.Count
}

function Invoke-ProjectCommand {
    param(
        [Parameter(Mandatory)][string]$Label,
        [Parameter(Mandatory)][string[]]$Arguments,
        [Parameter(Mandatory)][string]$LogPath,
        [Parameter()][string]$WorkingDirectory
    )
    if ($singleThreadedTypecheck -and $Label.EndsWith(' typecheck')) { $Arguments += '--singleThreaded' }
    Write-Host "  RUN $Label"
    if ($planOnly) {
        Write-Host "       vp $($Arguments -join ' ')"
        return
    }
    if ([string]::IsNullOrWhiteSpace($WorkingDirectory)) {
        $WorkingDirectory = $deployRoot
    }
    Push-Location $WorkingDirectory
    $oldPath = $env:Path
    $oldCodexEnvironment = @{}
    $oldBundlerEnvironment = @{}
    try {
        $env:Path = "$([System.IO.Path]::GetDirectoryName($nodePath));$oldPath"
        if ($immutableProjection -and $Label -in @('web build', 'server bundle', 'desktop bundle')) {
            # Both native pools must fit the CPU build lane's 4 GiB admission.
            foreach ($name in @('ROLLDOWN_WORKER_THREADS', 'RAYON_NUM_THREADS')) {
                $oldBundlerEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
                Set-Item -Path "Env:$name" -Value '2'
            }
        }
        # The desktop launcher is a project command boundary. These are
        # agent-host markers, not T3 build settings; Vite+ treats them as an
        # agent invocation and promotes ordinary build warnings to failures.
        foreach ($entry in @(Get-ChildItem Env: | Where-Object { $_.Name -like "CODEX_*" })) {
            $oldCodexEnvironment[$entry.Name] = $entry.Value
            Remove-Item -LiteralPath "Env:$($entry.Name)" -ErrorAction SilentlyContinue
        }
        $projectCommandErrorAction = $ErrorActionPreference
        try {
            # Vite+ writes an informational built-in-command note to stderr.
            # Windows PowerShell 5 turns native stderr into ErrorRecord objects;
            # use the native exit code for this one boundary, then restore the
            # launcher's fail-closed preference.
            $ErrorActionPreference = "Continue"
            & $nodePath $vpCliPath @Arguments 1>> $LogPath 2>&1
            $projectCommandExitCode = $LASTEXITCODE
        }
        finally {
            $ErrorActionPreference = $projectCommandErrorAction
        }
        if ($projectCommandExitCode -ne 0) {
            throw "$Label failed with exit code $projectCommandExitCode. See $LogPath"
        }
    }
    finally {
        $env:Path = $oldPath
        foreach ($name in $oldBundlerEnvironment.Keys) {
            if ($null -eq $oldBundlerEnvironment[$name]) { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue }
            else { Set-Item -Path "Env:$name" -Value $oldBundlerEnvironment[$name] }
        }
        foreach ($entry in @(Get-ChildItem Env: | Where-Object { $_.Name -like "CODEX_*" })) {
            Remove-Item -LiteralPath "Env:$($entry.Name)" -ErrorAction SilentlyContinue
        }
        foreach ($name in $oldCodexEnvironment.Keys) {
            Set-Item -Path "Env:$name" -Value $oldCodexEnvironment[$name]
        }
        Pop-Location
    }
}


function Invoke-T3PreparedBuild {
    Write-Phase "dependencies"
    if ($dependencyNeedsInstall) {
        # Install the exact source lockfile without resolving or rewriting versions.
        $oldNpmConfigLockfile = $env:npm_config_lockfile
        try {
            $env:npm_config_lockfile = "true"
            Invoke-ProjectCommand "vp i --frozen-lockfile" @("i", "--frozen-lockfile") $commandLogPath
        }
        finally {
            if ($null -eq $oldNpmConfigLockfile) {
                Remove-Item Env:npm_config_lockfile -ErrorAction SilentlyContinue
            }
            else {
                $env:npm_config_lockfile = $oldNpmConfigLockfile
            }
        }
    }
    else {
        Write-Plan "Dependency state is current. Skipping vp i."
    }

    Write-Phase "final sync"
    if ($usePreparedVp) {
        $vpCliPath = Join-Path $deployRoot 'node_modules/vite-plus/bin/vp'
        if (-not (Test-Path -LiteralPath $vpCliPath -PathType Leaf)) { throw 'Prepared release has no local vp after install.' }
    }
    [void](Remove-StaleDeployFiles $sourceRoot $deployRoot $pruneArtifactRoot $deployCommitBefore -PlanOnly:$planOnly)
    [void](Sync-TrackedSourceFiles $sourceRoot $deployRoot -PlanOnly:$planOnly)

    Write-Phase "checks and builds"
    if ($Fast -or $SkipBuild) {
        Write-Plan "Fast readiness mode selected. Skipping full contract/server/web/desktop checks and builds."
    }
    else {
        if ($SkipTypecheck) {
            Write-Plan "Explicitly skipping package typechecks; build commands still run."
        }
        else {
            Invoke-ProjectCommand "contracts typecheck" @("run", "--filter", "@t3tools/contracts", "typecheck") $commandLogPath
            Invoke-ProjectCommand "server typecheck" @("run", "--filter", "t3", "typecheck") $commandLogPath
            Invoke-ProjectCommand "web typecheck" @("run", "--filter", "@t3tools/web", "typecheck") $commandLogPath
            Invoke-ProjectCommand "desktop typecheck" @("run", "--filter", "@t3tools/desktop", "typecheck") $commandLogPath
        }
        Invoke-ProjectCommand "web build" @("build", "--logLevel", "error") $commandLogPath (Join-Path $deployRoot "apps\web")
        # Fresh releases need the package CLI's served-client staging.
        $serverBuildArguments = if ($immutableProjection) { @('exec', 'node', 'scripts/cli.ts', 'build') } else { @('pack', '--logLevel', 'error') }
        Invoke-ProjectCommand "server bundle" $serverBuildArguments $commandLogPath (Join-Path $deployRoot "apps\server")
        Invoke-ProjectCommand "desktop bundle" @("pack", "--logLevel", "error") $commandLogPath (Join-Path $deployRoot "apps\desktop")
        Invoke-ProjectCommand "desktop Electron runtime" @("run", "--filter", "@t3tools/desktop", "ensure:electron") $commandLogPath
    }

}
