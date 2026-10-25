[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][string]$Binary,
    [Parameter(Mandatory)][string]$ProjectId,
    [Parameter(Mandatory)][string]$TailnetHealthUrl,
    [string]$ProviderInstanceId = 'codex',
    [string]$ReleaseRoot = 'A:/Runtime/T3CodeReleases',
    [string]$ArtifactRoot = 'A:/Dev/Artifacts/t3-auto-sync-20261025',
    [string]$BaseDir = 'D:/MovedAppData/T3CodeServer',
    [string]$InitialRelease = 'A:/Dev/Worktrees/t3code-deploy'
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path (Split-Path $PSScriptRoot)
. (Join-Path $repo 'scripts/t3-build-common.ps1')
$node = 'A:/Dev/Tooling/t3-node-v24.19.0/node.exe'
if (-not (Test-Path -LiteralPath $Binary -PathType Leaf)) { throw 'Build the supervisor binary first' }
if (-not $PSCmdlet.ShouldProcess('T3 supervisor tasks and executable', 'Back up and install release-aware supervisor')) { return }
$backup = Join-Path $ArtifactRoot ('supervisor-backup-' + (Get-Date -Format yyyyMMdd-HHmmss))
New-Item -ItemType Directory -Path $backup, $ReleaseRoot -Force | Out-Null
$tasks = @('T3 Code Native Supervisor', 'T3 Code Native Web Supervisor')
$installed = 'D:/_Programs/T3CodeDev/supervisor-recovery/T3CodeSupervisor.exe'
Copy-Item -LiteralPath $installed -Destination (Join-Path $backup 'T3CodeSupervisor.exe')
foreach ($name in $tasks) {
    Export-ScheduledTask -TaskName $name | Set-Content -LiteralPath (Join-Path $backup ($name + '.xml')) -Encoding Unicode
    $state = (Get-ScheduledTask -TaskName $name).State
    if ($state -eq 'Running') { throw 'Parent must coordinate idle shutdown of both old supervisors before installation' }
}
$configPath = Join-Path $ReleaseRoot 'deploy-config.json'
if (Test-Path -LiteralPath $configPath) { throw 'Existing config requires an explicit migration' }
$control = Copy-T3ControlScripts $repo (Join-Path $ReleaseRoot 'control')
$settings = [ordered]@{ node=$node; releaseRoot=$ReleaseRoot; artifactRoot=$ArtifactRoot; backupRoot=(Join-Path $ReleaseRoot 'data-backups'); baseDir=$BaseDir; supervisorScript=(Join-Path $control 't3-supervisor.mjs'); projectId=$ProjectId; modelSelection=@{instanceId=$ProviderInstanceId;model='gpt-6.1-sol';options=@(@{id='effort';value='low'})}; healthUrls=@('http://127.0.0.1:3774/','http://127.0.0.1:6803/usage-resets',$TailnetHealthUrl) }
if (-not (Test-Path -LiteralPath (Join-Path $ReleaseRoot 'state.json'))) {
    & $node (Join-Path $repo 'scripts/t3-release-state.mjs') initialize $ReleaseRoot $InitialRelease
    if ($LASTEXITCODE -ne 0) { throw 'Release state initialization failed' }
} else {
    $existingState = Get-Content -LiteralPath (Join-Path $ReleaseRoot 'state.json') -Raw | ConvertFrom-Json
    if ($existingState.current -ne $InitialRelease -or $existingState.pending) { throw 'Existing release state requires an explicit migration' }
}
try {
    foreach ($name in $tasks) { Disable-ScheduledTask -TaskName $name | Out-Null }
    Copy-Item -LiteralPath $Binary -Destination $installed -Force
    for ($index=0; $index -lt $tasks.Count; $index++) {
        $mode = if ($index -eq 0) { 'server' } else { 'web' }
        $action = New-ScheduledTaskAction -Execute $installed -Argument "--release-config `"$configPath`" --node `"$node`" --mode $mode"
        Set-ScheduledTask -TaskName $tasks[$index] -Action $action | Out-Null
    }
    [IO.File]::WriteAllText($configPath, ($settings | ConvertTo-Json -Depth 8))
} catch {
    Copy-Item -LiteralPath (Join-Path $backup 'T3CodeSupervisor.exe') -Destination $installed -Force
    foreach ($name in $tasks) {
        Register-ScheduledTask -TaskName $name -Xml ([IO.File]::ReadAllText((Join-Path $backup ($name + '.xml')))) -Force | Out-Null
    }
    throw
}
Write-Output "Installed with both tasks disabled. Backups: $backup. Parent enables and starts both tasks, then proves deployment."
