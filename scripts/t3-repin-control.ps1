[CmdletBinding()]
param(
    [string]$Config = 'A:/Runtime/T3CodeReleases/deploy-config.json',
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 't3-build-common.ps1')
$repository = Split-Path $PSScriptRoot
$settings = Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
$tasks = @('T3 Code Native Supervisor', 'T3 Code Native Web Supervisor')

function Write-AtomicConfig([string]$Text) {
    $temporary = $Config + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    [IO.File]::WriteAllText($temporary, $Text)
    [IO.File]::Replace($temporary, $Config, [NullString]::Value)
}
function Wait-T3Ports([bool]$Up) {
    $deadline = [DateTime]::UtcNow.AddSeconds($(if ($Up) { 330 } else { 30 }))
    do {
        $matches = 0
        foreach ($port in @(3774,6803)) {
            $client = New-Object Net.Sockets.TcpClient
            try {
                $connection = $client.ConnectAsync('127.0.0.1', $port)
                $connected = $connection.Wait(1000) -and $client.Connected
            } catch { $connected = $false } finally { $client.Dispose() }
            if ($connected -eq $Up) { $matches++ }
        }
        if ($matches -eq 2) { return }
        Start-Sleep -Seconds 2
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Ports 3774 and 6803 did not reach requested state up=$Up"
}
function Restart-T3Tasks {
    $startFailures = @()
    foreach ($name in $tasks) {
        try { Start-ScheduledTask -TaskName $name } catch { $startFailures += $_ }
    }
    if ($startFailures.Count) { throw "Task restart errors: $startFailures" }
    Wait-T3Ports $true
    foreach ($url in $settings.healthUrls[0..1]) {
        if ((Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 15).StatusCode -ne 200) { throw "Unhealthy T3 URL $url" }
    }
}
function Test-T3Idle {
    $operation = if ($DryRun) { 'idle-preview' } else { 'idle' }
    & $settings.node (Join-Path $PSScriptRoot 't3-deploy.mjs') $operation $Config
    if ($LASTEXITCODE -ne 0) { throw 'T3 idle check failed' }
}
function Test-T3Owners {
    & $settings.node (Join-Path $PSScriptRoot 't3-deploy.mjs') owners $Config
    if ($LASTEXITCODE -ne 0) { throw 'New supervisor owner proof failed' }
}
function Invoke-Repin {
    $statePath = Join-Path $settings.releaseRoot 'state.json'
    $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    if ($state.pending) { throw 'Resolve pending deployment before re-pinning' }
    if (Test-Path -LiteralPath (Join-Path $settings.releaseRoot 'auto-deploy-enabled')) { throw 'Disable auto-deploy before re-pinning' }
    foreach ($name in $tasks) { [void](Get-ScheduledTask -TaskName $name) }
    if (Invoke-GitText $repository @('status','--porcelain')) { throw 'Re-pin requires a clean committed checkout' }
    Test-T3Idle
    if ($DryRun) { Write-Output 'Would back up config and both task XMLs, pin controls, restart tasks, verify both ports and restore on failure.'; return }
    $backup = Join-Path $settings.artifactRoot ('repin-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $backup | Out-Null
    Copy-Item -LiteralPath $Config -Destination (Join-Path $backup 'deploy-config.json')
    foreach ($name in $tasks) { Export-ScheduledTask -TaskName $name | Set-Content -LiteralPath (Join-Path $backup ($name + '.xml')) -Encoding Unicode }
    $oldConfig = [IO.File]::ReadAllText($Config)
    $control = Copy-T3ControlScripts $repository (Join-Path $settings.releaseRoot 'control')
    $stopped = $false
    try {
        if ((Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json).current -ne $state.current) { throw 'Current release changed during re-pin' }
        Test-T3Idle
        $stopped = $true
        foreach ($name in $tasks) { Stop-ScheduledTask -TaskName $name }
        # The installed wrapper owns a kill-on-close job containing its descendants.
        Wait-T3Ports $false
        $settings.supervisorScript = Join-Path $control 't3-supervisor.mjs'
        Write-AtomicConfig ($settings | ConvertTo-Json -Depth 12)
        Restart-T3Tasks
        Test-T3Owners
        & $settings.node (Join-Path $PSScriptRoot 't3-cli-forward.mjs') $Config 'A:/Dev/Worktrees/t3code-deploy/apps/server/dist/bin.mjs' $backup
        if ($LASTEXITCODE -ne 0) { throw 'Fixed relay CLI forwarding installation failed' }
        Write-Output "Re-pin verified. Backup: $backup"
    } catch {
        $failure = $_
        if (-not $stopped) { throw }
        try {
            foreach ($name in $tasks) { Stop-ScheduledTask -TaskName $name }
            Wait-T3Ports $false
        } finally {
            try { Write-AtomicConfig $oldConfig } finally { Restart-T3Tasks }
        }
        throw "Re-pin failed; old config restored and T3 restarted. Backup: $backup. $failure"
    }
}
if ($MyInvocation.InvocationName -ne '.') {
    [void](Assert-SafeRoot $settings.releaseRoot 'release root')
    $hash = [Security.Cryptography.SHA256]::Create()
    try { $key = ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes([IO.Path]::GetFullPath($settings.releaseRoot).ToLowerInvariant())))).Replace('-','').ToLowerInvariant() } finally { $hash.Dispose() }
    $lock = New-Object IO.Pipes.NamedPipeServerStream("t3-release-$key")
    try { Invoke-Repin } finally { $lock.Dispose() }
}
