param([string]$Repository)
$ErrorActionPreference = 'Stop'
$root = Join-Path ([IO.Path]::GetTempPath()) ('t3-repin-synthetic-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
try {
    $config = Join-Path $root 'deploy-config.json'
    $original = @{releaseRoot=$root;artifactRoot=$root;node='synthetic';supervisorScript='old'} | ConvertTo-Json
    [IO.File]::WriteAllText($config,$original)
    [IO.File]::WriteAllText((Join-Path $root 'state.json'),(@{current='synthetic-current';pending=$null} | ConvertTo-Json))
    . (Join-Path $Repository 'scripts/t3-repin-control.ps1') -Config $config
    function Invoke-GitText { return '' }
    function Get-ScheduledTask { return @{State='Running'} }
    function Export-ScheduledTask { return '<Task>synthetic</Task>' }
    function Test-T3Idle { $script:idleChecked=$true }
    function Copy-T3ControlScripts { return (Join-Path $root 'new-control') }
    function Stop-ScheduledTask { $script:stops++ }
    function Wait-T3Ports { param([bool]$Up) }
    function Restart-T3Tasks {
        $script:starts++
        if ($script:starts -eq 1) { throw 'synthetic startup failure' }
        if ($script:starts -eq 2 -and [IO.File]::ReadAllText($config) -ne $original) { throw 'Old config was not restored' }
    }
    function Test-T3Owners { $script:ownersChecked=$true }
    $DryRun=$true
    Invoke-Repin
    if (-not $idleChecked -or $stops -or $starts -or (Get-ChildItem $root -Directory).Count) { throw 'Dry run mutated state or missed idle check' }
    $DryRun=$false
    try { Invoke-Repin; throw 'Expected startup failure' } catch {
        if ($_.Exception.Message -notlike '*old config restored and T3 restarted*') { throw }
    }
    if ($starts -ne 2 -or $stops -ne 4) { throw 'Restore did not restart both tasks' }
    $backups = @(Get-ChildItem $root -Directory)
    if ($backups.Count -ne 1) { throw 'Backup missing' }
    foreach ($name in @('deploy-config.json','T3 Code Native Supervisor.xml','T3 Code Native Web Supervisor.xml')) {
        if (-not (Test-Path -LiteralPath (Join-Path $backups[0].FullName $name))) { throw "Missing backup $name" }
    }
    Invoke-Repin
    if (-not $ownersChecked -or $settings.supervisorScript -eq 'old') { throw 'Successful re-pin was not verified' }
    [IO.File]::WriteAllText((Join-Path $root 'state.json'),'{"current":"synthetic-current","pending":{"id":"test"}}')
    try { Invoke-Repin; throw 'Expected pending refusal' } catch {
        if ($_.Exception.Message -notlike '*Resolve pending deployment*') { throw }
    }
    Write-Output 'PASS: dry run, idle check, backups, failed-start restore, both restarts, pending refusal'
} finally {
    $resolved = [IO.Path]::GetFullPath($root)
    if (-not $resolved.StartsWith([IO.Path]::GetTempPath()) -or (Split-Path $resolved -Leaf) -notlike 't3-repin-synthetic-*') { throw 'Unsafe fixture cleanup path' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
