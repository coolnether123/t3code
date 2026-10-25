[CmdletBinding()]
param([string]$Commit = 'HEAD', [string]$Config = 'A:/Runtime/T3CodeReleases/deploy-config.json', [switch]$DryRun, [switch]$Recover, [switch]$Status)
$ErrorActionPreference = 'Stop'
$node = 'A:/Dev/Tooling/t3-node-v24.19.0/node.exe'
$settings = Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
if ($Status -or $Recover) {
    $operation = if ($Status) { 'status' } else { 'recover' }
    & $node (Join-Path $PSScriptRoot 't3-deploy.mjs') $operation $Config
    exit $LASTEXITCODE
}
$sha = & git -C (Split-Path $PSScriptRoot) rev-parse --verify "$Commit^{commit}"
if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve requested commit' }
$candidate = Join-Path $settings.releaseRoot $sha
if ($DryRun) { Write-Output "Would prepare and deploy $sha using $Config"; return }
if (-not (Test-Path -LiteralPath $candidate)) {
    $jobPath = Join-Path $settings.artifactRoot ('prepare-job-' + [Guid]::NewGuid().ToString() + '.json')
    $job = @{requestId=[Guid]::NewGuid().ToString();taskId='agenda-task:43f97c65571d4e89baa85b2349753c3d';title='Prepare exact T3 release';command="$env:SystemRoot/System32/WindowsPowerShell/v1.0/powershell.exe";args=@('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',(Join-Path $PSScriptRoot 't3-prepare-release.ps1'),'-Commit',$sha,'-ReleaseRoot',$settings.releaseRoot,'-ArtifactRoot',$settings.artifactRoot);cwd=(Split-Path $PSScriptRoot);outputs=@($settings.releaseRoot,$settings.artifactRoot);lane='heavy'}
    [IO.File]::WriteAllText($jobPath, ($job | ConvertTo-Json -Depth 6))
    & $node (Join-Path $PSScriptRoot 't3-build-job.mjs') $jobPath
    if ($LASTEXITCODE -ne 0) { throw 'Release preparation failed' }
}
& $node (Join-Path $PSScriptRoot 't3-deploy.mjs') deploy $Config $candidate
exit $LASTEXITCODE
