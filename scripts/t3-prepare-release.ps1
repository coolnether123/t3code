[CmdletBinding()]
param(
    [string]$Commit = 'HEAD',
    [Parameter(Mandatory)][string]$ReleaseRoot,
    [Parameter(Mandatory)][string]$ArtifactRoot,
    [string]$Repository,
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($Repository)) { $Repository = Split-Path $PSScriptRoot }
. (Join-Path $PSScriptRoot 't3-build-common.ps1')
$immutableProjection = $true
$usePreparedVp = $true
$singleThreadedTypecheck = $true
# Legacy mirrors retain these machine overrides. An immutable release uses
# the requested commit's versions instead of inheriting mirror-only files.
$excludedRelativeFiles = @($excludedRelativeFiles | Where-Object {
    $_ -notin @('apps\mobile\src\features\usage\usageProviders.ts', 'scripts\import-codex-history.mjs')
})
$Repository = Assert-SafeRoot $Repository 'release repository'
$sha = Invoke-GitText $Repository @('rev-parse', '--verify', "$Commit^{commit}")
if ($sha -notmatch '^[a-f0-9]{40}$') { throw 'Expected a full commit identity.' }
$ReleaseRoot = Normalize-AbsolutePath $ReleaseRoot
$ArtifactRoot = Normalize-AbsolutePath $ArtifactRoot
$targetRoot = Join-Path $ReleaseRoot $sha
$deployRoot = Join-Path $ReleaseRoot ('.building-' + $sha + '-' + [Guid]::NewGuid().ToString('N'))
$sourceRoot = Join-Path $ReleaseRoot ('.source-' + [Guid]::NewGuid().ToString('N'))
foreach ($target in @($ReleaseRoot, $ArtifactRoot)) {
    if ((Test-SamePath $target $Repository) -or $target.StartsWith($Repository + '\', [StringComparison]::OrdinalIgnoreCase) -or $Repository.StartsWith($target + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Release output and repository must be separate trees.'
    }
}
if ((Test-SamePath $ReleaseRoot $ArtifactRoot) -or $ArtifactRoot.StartsWith($ReleaseRoot + '\', [StringComparison]::OrdinalIgnoreCase) -or $ReleaseRoot.StartsWith($ArtifactRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Release output and artifacts must be separate trees.'
}
if ($DryRun) {
    Write-Host "Would prepare $sha in $targetRoot. No live data or services are used."
    return
}
New-Item -ItemType Directory -Path $ReleaseRoot, $ArtifactRoot -Force | Out-Null
[void](Assert-SafeRoot $ReleaseRoot 'release root')
[void](Assert-SafeRoot $ArtifactRoot 'release artifacts')
if (Test-Path -LiteralPath $targetRoot) { throw 'Immutable release already exists. Use its receipt or choose another commit.' }
$nodePath = 'A:\Dev\Tooling\t3-node-v24.19.0\node.exe'
if ((& $nodePath --version) -ne 'v24.19.0') { throw 'Expected Node 24.19.0.' }
$vpCliPath = Join-Path $Repository 'node_modules/vite-plus/bin/vp'
if (-not (Test-Path -LiteralPath $vpCliPath)) { throw 'Repository-local vp is missing.' }
New-Item -ItemType Directory -Path $deployRoot | Out-Null
$planOnly = $false
$Fast = $false
$SkipBuild = $false
$SkipTypecheck = $false
$dependencyNeedsInstall = $true
$deployCommitBefore = $sha
$pruneArtifactRoot = $ArtifactRoot
$commandLogPath = Join-Path $ArtifactRoot "prepare-$sha.log"
try {
    [void](Invoke-GitText $Repository @('-c', 'core.longpaths=true', 'worktree', 'add', '--detach', $sourceRoot, $sha))
    [void](Sync-TrackedSourceFiles $sourceRoot $deployRoot)
    Invoke-T3PreparedBuild
    foreach ($relative in @('apps/server/dist/bin.mjs', 'apps/server/dist/client/index.html', 'apps/web/dist/index.html')) {
        if (-not (Test-Path -LiteralPath (Join-Path $deployRoot $relative) -PathType Leaf)) {
            throw "Release is missing required artifact: $relative"
        }
    }
    $receipt = [ordered]@{
        commit = $sha
        preparedAt = [DateTime]::UtcNow.ToString('o')
        root = $targetRoot
        node = $nodePath
        liveDataUsed = $false
        artifacts = Get-BuildArtifactIdentity $deployRoot @('apps/server/dist/bin.mjs', 'apps/server/dist/client/index.html', 'apps/web/dist/index.html')
    }
    [IO.File]::WriteAllText((Join-Path $deployRoot 'release.json'), ($receipt | ConvertTo-Json -Depth 10), (New-Object Text.UTF8Encoding($false)))
    [void](Assert-ContainedPath $ReleaseRoot $deployRoot 'prepared build')
    [void](Assert-ContainedPath $ReleaseRoot $targetRoot 'immutable release')
    [IO.Directory]::Move($deployRoot, $targetRoot)
    Write-Host "Prepared $sha. Receipt: $targetRoot\release.json"
} finally {
    if (Test-Path -LiteralPath $sourceRoot) {
        [void](Invoke-GitText $Repository @('-c', 'core.longpaths=true', 'worktree', 'remove', $sourceRoot))
    }
}
