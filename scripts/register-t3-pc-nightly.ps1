[CmdletBinding()]
param(
    [string]$ArtifactRoot = 'H:\Dev\T3Sync\artifacts',
    [string]$WorktreeRoot = 'F:\Dev\Worktrees',
    [switch]$S4U
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot
. (Join-Path $PSScriptRoot 't3-build-common.ps1')
$repo = Assert-SafeRoot $repo 'nightly controller'
$WorktreeRoot = Assert-SafeRoot $WorktreeRoot 'nightly worktree root'
if ($repo -notmatch '^[AF]:\\' -or $WorktreeRoot -notmatch '^[AF]:\\') {
    throw 'The controller and worktrees must be on A: or F:.'
}
$releaseRoot = 'A:\Runtime\T3CodeReleases'
$deployConfig = Join-Path $releaseRoot 'deploy-config.json'
$node = 'A:\Dev\Tooling\t3-node-v24.19.0\node.exe'
$vp = Join-Path $env:APPDATA 'npm\node_modules\vite-plus\bin\vp'
$corepack = Join-Path (Split-Path $node) 'node_modules\corepack\dist\corepack.js'
foreach ($file in @($node, $vp, $corepack, $deployConfig)) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing $file" }
}
if ((Get-TimeZone).Id -ne 'Central Standard Time') { throw 'Windows must be set to Chicago time.' }

$name = 'Otis T3 Nightly Sync'
$existing = Get-ScheduledTask -TaskName $name
if ($existing.State -eq 'Running' -or $existing.Actions.Arguments -notlike '*t3-nightly-sync.mjs*') {
    throw 'The existing Windows T3 nightly task is running or its action is unexpected.'
}
New-Item -ItemType Directory -Path $ArtifactRoot -Force | Out-Null
$backup = Join-Path $ArtifactRoot ('nightly-task-before-' + [Guid]::NewGuid().ToString() + '.xml')
Export-ScheduledTask -TaskName $name | Set-Content -LiteralPath $backup -Encoding Unicode

$control = Copy-T3ControlScripts $repo (Join-Path (Split-Path $WorktreeRoot) 'T3NightlyControl')
$pnpmBin = Join-Path $control 'bin'
New-Item -ItemType Directory -Path $pnpmBin -Force | Out-Null
& $node $corepack enable --install-directory $pnpmBin pnpm
if ($LASTEXITCODE -ne 0) { throw 'Pinned Node failed to install the pnpm shim.' }
$configPath = Join-Path $control 'pc-nightly-config.json'
$settings = [ordered]@{
    pcUnattended = $true
    repository = $repo
    worktreeRoot = $WorktreeRoot
    forkBranch = 'deploy/jared-pc-nightly'
    upstreamBranch = 'main'
    node = $node
    vp = $vp
    pnpmBin = $pnpmBin
    artifactRoot = $ArtifactRoot
    releaseRoot = $releaseRoot
    deployConfig = $deployConfig
    taskLinkCheck = 'A:\Dev\Projects\Otis\tools\change-tracking\check-task-links.mjs'
    taskId = 'agenda-task:ba95c24abc5647adbde4397a6856e74c'
}
[IO.File]::WriteAllText($configPath, ($settings | ConvertTo-Json -Depth 5))
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\conhost.exe" -Argument (
    '--headless "{0}" "{1}" "{2}"' -f $node, (Join-Path $control 't3-nightly-sync.mjs'), $configPath
) -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Daily -At '03:45'
# A floating local time preserves 03:45 through daylight-saving changes.
$trigger.StartBoundary = (Get-Date).Date.AddDays(1).AddHours(3).AddMinutes(45).ToString("yyyy-MM-dd'T'HH:mm:ss")
$logon = if ($S4U) { 'S4U' } else { 'Interactive' }
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType $logon -RunLevel Limited
$options = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Principal $principal -Settings $options -Force | Out-Null
Write-Output "Registered $name at 03:45 Central ($logon). Previous task XML: $backup"
