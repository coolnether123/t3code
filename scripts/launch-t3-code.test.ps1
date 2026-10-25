[CmdletBinding()]
param([string]$ArtifactRoot = (Join-Path $env:TEMP ("t3-prune-tests-" + [Guid]::NewGuid().ToString('N'))))

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$launcher = Join-Path $PSScriptRoot 'launch-t3-code.ps1'
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($launcher, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
# Load the launcher's actual definitions without executing its deployment entry point.
$entry = @($ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.TryStatementAst] })[0]
$definitions = $ast.Extent.Text.Substring(0, $entry.Extent.StartOffset)
# A synthetic ScriptBlock has no PSScriptRoot. Resolve the extracted module here.
$definitions = $definitions.Replace(". (Join-Path `$PSScriptRoot 't3-build-common.ps1')", ". '$($PSScriptRoot.Replace("'", "''"))/t3-build-common.ps1'")
. ([ScriptBlock]::Create($definitions))
$fixtureRoot = [IO.Path]::GetFullPath($ArtifactRoot)
New-Item -ItemType Directory -Path $fixtureRoot | Out-Null
$source = Join-Path $fixtureRoot 'source'
$mirror = Join-Path $fixtureRoot 'mirror'
$backups = Join-Path $fixtureRoot 'backups'
New-Item -ItemType Directory -Path $source, $mirror | Out-Null
$commit = '0123456789012345678901234567890123456789'
$script:passed = 0
function Assert-Test([bool]$Condition, [string]$Name) {
    if (-not $Condition) { throw "FAIL $Name" }
    $script:passed++
    Write-Host "PASS $Name"
}
function Write-Fixture([string]$Root, [string]$Relative, [string]$Text = 'synthetic fixture') {
    $path = Join-Path $Root $Relative
    New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($path)) -Force | Out-Null
    [IO.File]::WriteAllText($path, $Text)
}
function Assert-Rejected([ScriptBlock]$Action, [string]$Name) {
    $rejected = $false
    try { & $Action | Out-Null } catch { $rejected = $true }
    Assert-Test $rejected $Name
}

Write-Fixture $source 'keep.ts' 'new'
Write-Fixture $mirror 'keep.ts' 'old'
Write-Fixture $mirror 'removed/deleted.test.ts'
$unicodeRelative = 'untracked space/[old] caf' + [char]0xE9 + '.ts'
Write-Fixture $mirror $unicodeRelative
Write-Fixture $mirror '-option.txt'
$protected = @('.git', '.env', '.env.production', 'infra/relay/.env.local', 'settings.json',
    'apps/web/settings.local.json', '.logs/output.log', 'node_modules/pkg/index.js',
    'apps/server/dist/bin.mjs', 'apps/desktop/dist-electron/main.cjs', '.t3/state.sqlite',
    'userdata/state.sqlite', 'secrets/key', 'logs/trace', 'caches/cache', 'apps/web/tsconfig.tsbuildinfo',
    '.generated/license.json', '.plans/notes.md')
foreach ($relative in $protected) { Write-Fixture $mirror $relative }
$before = @(Get-ChildItem -LiteralPath $mirror -File -Recurse -Force).Count
$count = Remove-StaleDeployFiles $source $mirror $backups $commit -PlanOnly
Assert-Test ($count -eq 3) 'dry run finds tracked-removed and untracked stale files'
Assert-Test (-not (Test-Path $backups)) 'dry run writes no backup'
Assert-Test (@(Get-ChildItem -LiteralPath $mirror -File -Recurse -Force).Count -eq $before) 'dry run deletes nothing'
Assert-Rejected { Remove-StaleDeployFiles $source $mirror $source $commit } 'backup inside source rejected'
Assert-Test (Test-Path (Join-Path $mirror 'removed/deleted.test.ts')) 'unsafe backup leaves stale files intact'
$savedSystemRoot = $env:SystemRoot
try {
    $env:SystemRoot = Join-Path $fixtureRoot 'missing-tar'
    Assert-Rejected { Remove-StaleDeployFiles $source $mirror $backups $commit } 'backup command failure aborts pruning'
} finally { $env:SystemRoot = $savedSystemRoot }
Assert-Test (Test-Path (Join-Path $mirror 'removed/deleted.test.ts')) 'backup failure leaves stale files intact'
$count = Remove-StaleDeployFiles $source $mirror $backups $commit
Assert-Test ($count -eq 3 -and @(Get-StaleDeployFiles $source $mirror).Count -eq 0) 'real prune removes exactly stale files'
$archives = @(Get-ChildItem -LiteralPath $backups -Filter '*.tar')
Assert-Test ($archives.Count -eq 1 -and $archives[0].Name.Contains($commit)) 'backup tar includes deploy commit'
$restore = Join-Path $fixtureRoot 'restore'
New-Item -ItemType Directory -Path $restore | Out-Null
& (Join-Path $env:SystemRoot 'System32/tar.exe') -xf $archives[0].FullName -C $restore
if ($LASTEXITCODE -ne 0) { throw 'Backup restore failed' }
Assert-Test ((Get-Content -LiteralPath (Join-Path $restore $unicodeRelative) -Raw) -eq 'synthetic fixture') 'backup restores exact content and special names'
foreach ($relative in $protected) {
    Assert-Test (Test-Path -LiteralPath (Join-Path $mirror $relative)) "protected $relative"
}
[void](Sync-TrackedSourceFiles $source $mirror)
Assert-Test ((Get-Content (Join-Path $mirror 'keep.ts') -Raw) -eq 'new') 'source copy still updates included files'
Assert-Test ((Remove-StaleDeployFiles $source $mirror $backups $commit) -eq 0) 'second prune is empty'
# Force several tar invocations, including append, without a large process command line.
foreach ($index in 1..100) {
    Write-Fixture $mirror ("batch/$index-" + ('x' * 180) + '.ts')
}
Assert-Test ((Remove-StaleDeployFiles $source $mirror $backups $commit) -eq 100) 'large path batch is backed up and verified before pruning'
Write-Fixture $mirror 'verification-failure.ts'
$originalHashFunction = ${function:Get-FileSha256}
try {
    function Get-FileSha256([string]$Path) {
        if ($Path.Contains('.verify')) { return 'corrupted backup' }
        return & $originalHashFunction $Path
    }
    Assert-Rejected { Remove-StaleDeployFiles $source $mirror $backups $commit } 'backup content verification failure aborts pruning'
} finally { ${function:Get-FileSha256} = $originalHashFunction }
Assert-Test (Test-Path (Join-Path $mirror 'verification-failure.ts')) 'verification failure leaves stale file intact'
Assert-Rejected { Remove-StaleDeployFiles $mirror $mirror $backups $commit } 'identical roots rejected'
Assert-Rejected { Assert-MirrorFile $mirror '../source/keep.ts' } 'outside path rejected'
$outside = Join-Path $fixtureRoot 'outside'
New-Item -ItemType Directory -Path $outside | Out-Null
New-Item -ItemType Directory -Path (Join-Path $outside 'nested') | Out-Null
Write-Fixture $outside 'data.txt' 'outside data'
$junction = Join-Path $mirror 'linked'
New-Item -ItemType Junction -Path $junction -Target $outside | Out-Null
Assert-Rejected { Remove-StaleDeployFiles $source $mirror $backups $commit -PlanOnly } 'nested junction rejected'
Assert-Rejected { Assert-MirrorFile $mirror 'linked/data.txt' } 'candidate ancestor junction rejected'
Assert-Rejected { Assert-SafeRoot (Join-Path $junction 'nested') 'junction parent' } 'junction root ancestry rejected'
Assert-Test ((Get-Content (Join-Path $outside 'data.txt') -Raw) -eq 'outside data') 'junction target preserved'
Write-Host "RESULT pass=$script:passed fail=0 skip=0 fixtures=$fixtureRoot"
