[CmdletBinding()]
param([string]$ArtifactRoot = 'A:/Dev/Artifacts/t3-auto-sync-20261025', [string]$ReleaseRoot = 'A:/Runtime/T3CodeReleases')
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot
$node = 'A:/Dev/Tooling/t3-node-v24.19.0/node.exe'
if (Test-Path -LiteralPath (Join-Path $ReleaseRoot 'auto-deploy-enabled')) { throw 'First registration requires auto-deploy to remain disabled' }
New-Item -ItemType Directory -Path $ArtifactRoot -Force | Out-Null
$configPath = Join-Path $ArtifactRoot 'nightly-config.json'
$settings = [ordered]@{repository=$repo;node=$node;artifactRoot=$ArtifactRoot;releaseRoot=$ReleaseRoot;deployConfig=(Join-Path $ReleaseRoot 'deploy-config.json');queueCli='A:/Dev/Projects/Otis/tools/resource/build-queue.mjs';otisCall='A:/Dev/Projects/Otis/tools/otis-call/otis-call.mjs';taskLinkCheck='A:/Dev/Projects/Otis/tools/change-tracking/check-task-links.mjs';taskId='agenda-task:43f97c65571d4e89baa85b2349753c3d';handoff=(Join-Path $ArtifactRoot 'HANDOFF.md');workerCapabilities=(Join-Path $ArtifactRoot 'manifest.json')}
[IO.File]::WriteAllText($configPath, ($settings | ConvertTo-Json -Depth 5))
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\conhost.exe" -Argument "--headless `"$node`" `"$repo/scripts/t3-nightly-sync.mjs`" `"$configPath`"" -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Daily -At '03:30'
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$options = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
$name = 'Otis T3 Nightly Sync'
if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) { throw 'Task exists; inspect before replacing' }
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Principal $principal -Settings $options | Out-Null
Export-ScheduledTask -TaskName $name | Set-Content -LiteralPath (Join-Path $ArtifactRoot 'nightly-task.xml') -Encoding Unicode
Write-Output "Registered \$name, daily 03:30 local, interactive limited user, headless. Auto-deploy remains disabled."
