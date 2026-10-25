[CmdletBinding()]
param([string]$ArtifactRoot = 'A:/Dev/Artifacts/t3-auto-sync-20261025', [string]$ReleaseRoot = 'A:/Runtime/T3CodeReleases', [string]$Repository, [switch]$Update)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot
. (Join-Path $PSScriptRoot 't3-build-common.ps1')
if ([string]::IsNullOrWhiteSpace($Repository)) { $Repository = $repo }
$Repository = Assert-SafeRoot $Repository 'nightly repository'
if ((Invoke-GitText $repo @('rev-parse','--path-format=absolute','--git-common-dir')) -ne (Invoke-GitText $Repository @('rev-parse','--path-format=absolute','--git-common-dir'))) { throw 'Nightly repository must share the source Git owner' }
$node = 'A:/Dev/Tooling/t3-node-v24.19.0/node.exe'
if (Test-Path -LiteralPath (Join-Path $ReleaseRoot 'auto-deploy-enabled')) { throw 'First registration requires auto-deploy to remain disabled' }
New-Item -ItemType Directory -Path $ArtifactRoot -Force | Out-Null
$control = Copy-T3ControlScripts $repo (Join-Path $ArtifactRoot 'nightly-control')
$configPath = Join-Path $ArtifactRoot 'nightly-config.json'
$settings = [ordered]@{repository=$Repository;node=$node;artifactRoot=$ArtifactRoot;releaseRoot=$ReleaseRoot;deployConfig=(Join-Path $ReleaseRoot 'deploy-config.json');otisCall='A:/Dev/Projects/Otis/tools/otis-call/otis-call.mjs';taskLinkCheck='A:/Dev/Projects/Otis/tools/change-tracking/check-task-links.mjs';taskId='agenda-task:43f97c65571d4e89baa85b2349753c3d';handoff=(Join-Path $ArtifactRoot 'HANDOFF.md');workerCapabilities=(Join-Path $ArtifactRoot 'manifest.json')}
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\conhost.exe" -Argument "--headless `"$node`" `"$control/t3-nightly-sync.mjs`" `"$configPath`"" -WorkingDirectory $Repository
$trigger = New-ScheduledTaskTrigger -Daily -At '03:30'
# Omit the offset so Windows follows the local daylight-saving rules.
$trigger.StartBoundary = (Get-Date).Date.AddHours(3).AddMinutes(30).ToString("yyyy-MM-dd'T'HH:mm:ss")
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$options = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
$name = 'Otis T3 Nightly Sync'
$existing = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
if ($existing) {
    if ($existing.State -eq 'Running') { throw 'Wait for the existing nightly run before updating its action' }
    if (-not $Update -or $existing.Actions.Arguments -notlike '*t3-nightly-sync.mjs*' -or $existing.Actions.Arguments -notlike ('*' + $configPath.Replace('/','\') + '*')) { throw 'Task exists; inspect before replacing' }
    Export-ScheduledTask -TaskName $name | Set-Content -LiteralPath (Join-Path $ArtifactRoot ('nightly-task-before-' + (Get-Date -Format yyyyMMdd-HHmmss) + '.xml')) -Encoding Unicode
}
[IO.File]::WriteAllText($configPath, ($settings | ConvertTo-Json -Depth 5))
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Principal $principal -Settings $options -Force:$Update | Out-Null
Export-ScheduledTask -TaskName $name | Set-Content -LiteralPath (Join-Path $ArtifactRoot 'nightly-task.xml') -Encoding Unicode
Write-Output "Registered \$name, daily 03:30 local, interactive limited user, headless. Auto-deploy remains disabled."
