[CmdletBinding()]
param([Parameter(Mandatory)][string]$Command)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# Accept the entire original SSH command. Do not split, trim, evaluate, or append arguments.
$commands = @{ 't3-install' = 'Install'; 't3-update' = 'Update'; 't3-health' = 'Health' }
if (($Command -cnotin @($commands.Keys) + 't3-status') -or $args.Count) { throw 'Command refused.' }
$receiptRoot = Join-Path $env:ProgramData 'OdysseusT3\receipts'
if ($Command -ceq 't3-status') {
    $results = foreach ($name in 'Install', 'Update', 'Health') {
        $path = Join-Path $receiptRoot "$name.json"
        if (Test-Path -LiteralPath $path) { Get-Content -LiteralPath $path -Raw | ConvertFrom-Json }
    }
    @{ observedAt = [DateTimeOffset]::Now.ToString('o'); receipts = @($results) } | ConvertTo-Json -Depth 5
    exit 0
}
$action = $commands[$Command]
$service = New-Object -ComObject 'Schedule.Service'
$service.Connect()
$task = $service.GetFolder('\OdysseusT3').GetTask($action)
$previousRun = $task.LastRunTime
$null = $task.Run($null)
$receiptFile = Join-Path $receiptRoot "$action.json"
$receipt = $null
if (Test-Path -LiteralPath $receiptFile) { $receipt = Get-Content -LiteralPath $receiptFile -Raw | ConvertFrom-Json }
@{
    requested = $action; state = 'requested, not a completion claim'
    previousRun = $previousRun.ToString('o'); taskState = $task.State
    lastTaskResult = $task.LastTaskResult; lastReceipt = $receipt
    note = 'Read t3-status for current receipts. Will must be signed in.'
} | ConvertTo-Json -Depth 5
