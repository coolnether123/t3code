[CmdletBinding()]
param([Parameter(Mandatory)][string]$TestRoot, [ValidateRange(1024, 65535)][int]$Port = 48784)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$TestRoot = [IO.Path]::GetFullPath($TestRoot)
if ($TestRoot -notlike '*odysseus*test*' -or $Port -in 3773, 3774, 3784) {
    throw 'Use an explicitly named odysseus test directory and a disposable port.'
}
$script = Join-Path $PSScriptRoot 't3-user.ps1'
$shell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$env:CODEX_HOME = Join-Path $TestRoot 'synthetic-codex'
$passed = 0

function Invoke-TestAction {
    param([string]$Action, [int]$TestPort = $Port, [switch]$ExpectFailure)
    $saved = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = & $shell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden `
            -File $script -Action $Action -Root $TestRoot -Port $TestPort 2>&1
        $exitCode = $LASTEXITCODE
    }
    finally { $ErrorActionPreference = $saved }
    if (($exitCode -eq 0) -eq [bool]$ExpectFailure) { throw "Unexpected exit code for $Action." }
    return ($output | Out-String).Trim()
}

function Assert-Check {
    param([bool]$Condition, [string]$Name)
    if (-not $Condition) { throw "Failed: $Name" }
    $script:passed++
    Write-Output "PASS $Name"
}

$tokens = $null
$parseErrors = $null
foreach ($file in Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.ps1') {
    $null = [Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$parseErrors)
    Assert-Check ($parseErrors.Count -eq 0) "parse $($file.Name)"
}
foreach ($forbidden in @('t3-install extra', 't3-update;whoami', 'T3-HEALTH', 't3-status ', 'disk')) {
    $saved = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $null = & $shell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden `
            -File (Join-Path $PSScriptRoot 'restricted-command.ps1') -Command $forbidden 2>&1
        $code = $LASTEXITCODE
    }
    finally { $ErrorActionPreference = $saved }
    Assert-Check ($code -ne 0) "refuse command [$forbidden]"
}
$null = Invoke-TestAction Health
Assert-Check (Test-Path -LiteralPath (Join-Path $TestRoot 'current.json')) 'installed release pointer exists'
foreach ($reserved in 3773, 3774) {
    $null = Invoke-TestAction Start -TestPort $reserved -ExpectFailure
    Assert-Check $true "refuse reserved port $reserved"
}
$listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, $Port)
try {
    $listener.Start()
    $null = Invoke-TestAction Start -ExpectFailure
    Assert-Check $true 'refuse occupied port'
}
finally { $listener.Stop() }
$pointer = (Get-FileHash -LiteralPath (Join-Path $TestRoot 'current.json')).Hash
$started = $false
try {
    $null = Invoke-TestAction Start
    $started = $true
    $null = Invoke-TestAction Start -ExpectFailure
    Assert-Check $true 'refuse duplicate server'
    $null = Invoke-TestAction Update -ExpectFailure
    Assert-Check ((Get-FileHash -LiteralPath (Join-Path $TestRoot 'current.json')).Hash -eq $pointer) 'running update preserves pointer'
    $health = Invoke-TestAction Health | ConvertFrom-Json
    Assert-Check ($health.serverRunning -and $health.httpReady) 'owned server serves HTTP 200'
    Assert-Check ($health.localAgentAcceptance -eq 'not tested') 'health does not claim agent acceptance'
    $pidRecord = Get-Content -LiteralPath (Join-Path $TestRoot 'server.json') -Raw | ConvertFrom-Json
    $nativeProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($pidRecord.pid)"
    $owner = Invoke-CimMethod -InputObject $nativeProcess -MethodName GetOwnerSid
    Assert-Check ($owner.Sid -eq [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) 'detached process retains caller identity'
    $socket = Get-NetTCPConnection -LocalPort $Port -State Listen
    Assert-Check (($socket.LocalAddress -eq '127.0.0.1') -and ($socket.OwningProcess -eq $pidRecord.pid)) 'captured PID listens only on loopback'
}
finally { if ($started) { $null = Invoke-TestAction Stop } }
$health = Invoke-TestAction Health | ConvertFrom-Json
Assert-Check (-not $health.serverRunning -and -not $health.httpReady) 'stop removes owned server'
Write-Output "$passed checks passed. No provider sign-in, broker registration, or remote acceptance tested."
