[CmdletBinding()]
param([Parameter(Mandatory)][string]$WillAccount, [string]$OtisAccount = "$env:COMPUTERNAME\otis")

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# Will runs this once in an elevated shell. The maintenance jobs themselves are limited.
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Will must run broker setup as administrator.' }
$willSid = (New-Object Security.Principal.NTAccount($WillAccount)).Translate([Security.Principal.SecurityIdentifier]).Value
$otisSid = (New-Object Security.Principal.NTAccount($OtisAccount)).Translate([Security.Principal.SecurityIdentifier]).Value
if ($willSid -eq $otisSid) { throw 'The owner and restricted account must differ.' }
$root = Join-Path $env:ProgramData 'OdysseusT3'
if (Test-Path -LiteralPath $root) { throw 'Broker directory already exists. Review it before replacing a broker.' }
$service = New-Object -ComObject 'Schedule.Service'
$service.Connect()
$folder = $service.GetFolder('\')
try { $existing = $folder.GetFolder('OdysseusT3') } catch { $existing = $null }
if ($existing) { throw 'Task folder already exists. Review it before replacing a broker.' }
New-Item -ItemType Directory -Path $root | Out-Null
$acl = New-Object Security.AccessControl.DirectorySecurity
$acl.SetSecurityDescriptorSddlForm("O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;GRGX;;;${willSid})(A;OICI;GRGX;;;${otisSid})")
Set-Acl -LiteralPath $root -AclObject $acl
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 't3-user.ps1') -Destination $root
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'restricted-command.ps1') -Destination $root
$receipts = Join-Path $root 'receipts'
New-Item -ItemType Directory -Path $receipts | Out-Null
$receiptAcl = New-Object Security.AccessControl.DirectorySecurity
$receiptAcl.SetSecurityDescriptorSddlForm("O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;${willSid})(A;OICI;GRGX;;;${otisSid})")
Set-Acl -LiteralPath $receipts -AclObject $receiptAcl
$taskAcl = "D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;${willSid})(A;;GRGX;;;${otisSid})"
$taskFolder = $folder.CreateFolder('OdysseusT3', $taskAcl)
foreach ($action in 'Install', 'Update', 'Health') {
    $definition = $service.NewTask(0)
    $definition.RegistrationInfo.Description = "Owner-approved T3 $action. No caller arguments."
    $definition.Principal.UserId = $willSid
    $definition.Principal.LogonType = 3 # InteractiveToken. No stored password; Will must be signed in.
    $definition.Principal.RunLevel = 0 # Limited, never elevated.
    $definition.Settings.AllowDemandStart = $true
    $definition.Settings.DisallowStartIfOnBatteries = $false
    $definition.Settings.StopIfGoingOnBatteries = $false
    $definition.Settings.ExecutionTimeLimit = 'PT0S'
    $definition.Settings.MultipleInstances = 2 # Ignore a duplicate of the same maintenance job.
    $exec = $definition.Actions.Create(0)
    $exec.Path = Join-Path $env:WINDIR 'System32\conhost.exe'
    $powershell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $exec.Arguments = "--headless `"$powershell`" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$root\t3-user.ps1`" -Action $action -ReceiptPath `"$receipts\$action.json`""
    $exec.WorkingDirectory = $root
    $null = $taskFolder.RegisterTaskDefinition($action, $definition, 2, $willSid, $null, 3, $taskAcl)
}
Write-Output 'Registered three on-demand, limited tasks. No jobs started. No passwords stored.'
