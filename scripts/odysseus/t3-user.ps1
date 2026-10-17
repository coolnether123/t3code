[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('Install', 'Update', 'Health', 'Start', 'Stop')][string]$Action,
    [string]$Root = (Join-Path $env:LOCALAPPDATA 'OdysseusT3'),
    [ValidateRange(1024, 65535)][int]$Port = 3784,
    [string]$ReceiptPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
if ($Port -in 3773, 3774) { throw 'Ports 3773 and 3774 are reserved.' }
if ([Security.Principal.WindowsIdentity]::GetCurrent().Name.Split('\')[-1] -eq 'otis') {
    throw 'Run as the laptop owner, not the restricted otis account. Use the approved broker.'
}
$Root = [IO.Path]::GetFullPath($Root).TrimEnd('\')
if ($Root -eq [IO.Path]::GetPathRoot($Root).TrimEnd('\') -or $Root.Contains('"')) {
    throw 'Use a dedicated absolute install directory.'
}
# Refuse links at every existing ancestor, including a redirected install root.
$ancestor = $Root
while ($ancestor) {
    if ((Test-Path -LiteralPath $ancestor) -and
        ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'The install directory must not pass through a reparse point.'
    }
    $ancestor = [IO.Path]::GetDirectoryName($ancestor)
}
$currentFile = Join-Path $Root 'current.json'
$pidFile = Join-Path $Root 'server.json'
$dataDir = Join-Path $Root 'data'
$lock = $null

function Get-Release {
    if (-not (Test-Path -LiteralPath $currentFile)) { throw 'T3 is not installed. Run Install first.' }
    $release = Get-Content -LiteralPath $currentFile -Raw | ConvertFrom-Json
    if ($release.directory -notmatch '^[a-f0-9]{32}$') { throw 'Invalid release pointer.' }
    return Join-Path (Join-Path $Root 'releases') $release.directory
}

function Get-OwnedServer {
    if (-not (Test-Path -LiteralPath $pidFile)) { return $null }
    $record = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$record.pid)"
    if ($process -and ($process.ExecutablePath -eq $record.executable) -and
        $process.CommandLine.Contains("--base-dir `"$dataDir`"")) {
        return $process
    }
    if ($process) { throw 'Recorded PID no longer identifies this server. Refusing to act on it.' }
    return $null
}

function Invoke-Checked {
    param([string]$Executable, [string[]]$Arguments)
    $savedPreference = $ErrorActionPreference
    try {
        # Windows PowerShell treats native stderr notices as errors. The exit code owns success.
        $ErrorActionPreference = 'Continue'
        $output = & $Executable @Arguments 2>&1
        $code = $LASTEXITCODE
    }
    finally { $ErrorActionPreference = $savedPreference }
    if ($code -ne 0) { throw "Command failed with exit code $code. Executable: $Executable" }
    return ($output | Out-String).Trim()
}

try {
    if ($Action -ne 'Health') {
        New-Item -ItemType Directory -Path $Root -Force | Out-Null
        # Keep server state private to this user, SYSTEM and administrators.
        $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        $acl = New-Object Security.AccessControl.DirectorySecurity
        $acl.SetSecurityDescriptorSddlForm("D:P(A;OICI;FA;;;${sid})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)", [Security.AccessControl.AccessControlSections]::Access)
        [IO.Directory]::SetAccessControl($Root, $acl)
        $lock = [IO.File]::Open((Join-Path $Root 'maintenance.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
    }
    if ($Action -in 'Install', 'Update') {
        if (Get-OwnedServer) { throw 'Stop the local server after its agents are idle before updating.' }
        if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
            throw 'The selected port is occupied. No existing server was changed.'
        }
        $directory = [guid]::NewGuid().ToString('N')
        $release = Join-Path (Join-Path $Root 'releases') $directory
        New-Item -ItemType Directory -Path $release -Force | Out-Null
        $cpu = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
        if ($cpu -notin 'x64', 'arm64') { throw 'Only Windows x64 and arm64 are supported.' }
        # A portable supported LTS runtime avoids changing the machine's Node or PATH.
        $checksums = (Invoke-WebRequest 'https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt' -UseBasicParsing).Content
        $match = [regex]::Match($checksums, "(?m)^([a-f0-9]{64})\s+(node-v24\.[0-9]+\.[0-9]+-win-$cpu\.zip)\s*$")
        if (-not $match.Success) { throw 'Could not resolve the official Node 24 archive checksum.' }
        $downloads = Join-Path $Root 'downloads'
        New-Item -ItemType Directory -Path $downloads -Force | Out-Null
        $archive = Join-Path $downloads $match.Groups[2].Value
        if (-not (Test-Path -LiteralPath $archive)) {
            Invoke-WebRequest ("https://nodejs.org/dist/latest-v24.x/" + $match.Groups[2].Value) -OutFile $archive -UseBasicParsing
        }
        if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $match.Groups[1].Value) {
            throw 'Node archive checksum mismatch.'
        }
        Expand-Archive -LiteralPath $archive -DestinationPath $release
        $nodeDir = Join-Path $release ([IO.Path]::GetFileNameWithoutExtension($match.Groups[2].Value))
        $node = Join-Path $nodeDir 'node.exe'
        $npm = Join-Path $nodeDir 'node_modules\npm\bin\npm-cli.js'
        $packages = Join-Path $release 'packages'
        $oldPath = $env:PATH
        try {
            $env:PATH = "$nodeDir;$oldPath"
            # No package lifecycle scripts; native executables arrive in platform packages.
            $null = Invoke-Checked $node @($npm, 'install', '--prefix', $packages, '--cache', (Join-Path $Root 'npm-cache'), '--registry', 'https://registry.npmjs.org', '--ignore-scripts', '--no-audit', '--no-fund', 't3@latest', '@openai/codex@latest')
            $t3 = Join-Path $packages "node_modules\@t3code\t3-win32-$cpu\t3.exe"
            $t3Version = Invoke-Checked $t3 @('--version')
            $codexVersion = Invoke-Checked $node @((Join-Path $packages 'node_modules\@openai\codex\bin\codex.js'), '--version')
            $null = Invoke-Checked $t3 @('serve', '--help')
        }
        finally { $env:PATH = $oldPath }
        $manifest = [ordered]@{
            directory = $directory; nodeDir = [IO.Path]::GetFileName($nodeDir); cpu = $cpu
            t3 = $t3Version; codex = $codexVersion; installedAt = [DateTimeOffset]::Now.ToString('o')
        }
        $manifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $release 'release.json') -Encoding UTF8
        $pending = Join-Path $Root 'current.pending'
        $manifest | ConvertTo-Json | Set-Content -LiteralPath $pending -Encoding UTF8
        if (Test-Path -LiteralPath $currentFile) { [IO.File]::Replace($pending, $currentFile, (Join-Path $Root 'previous.json')) }
        else { [IO.File]::Move($pending, $currentFile) }
        Write-Output "Installed $t3Version; $codexVersion. Start separately after sign-in."
    }
    if ($Action -eq 'Start') {
        $release = Get-Release
        if (Get-OwnedServer) { throw 'This server is already running.' }
        if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { throw 'Port occupied.' }
        $manifest = Get-Content -LiteralPath $currentFile -Raw | ConvertFrom-Json
        $nodeDir = Join-Path $release $manifest.nodeDir
        $env:PATH = "$nodeDir;$(Join-Path $release 'packages\node_modules\.bin');$env:PATH"
        $t3 = Join-Path $release "packages\node_modules\@t3code\t3-win32-$($manifest.cpu)\t3.exe"
        New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
        # WMI detaches SSH pipes. CREATE_NO_WINDOW plus CREATE_UNICODE_ENVIRONMENT avoids a console.
        $startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{
            ShowWindow = [uint16]0; CreateFlags = [uint32]0x08000400
            EnvironmentVariables = [string[]]@(Get-ChildItem Env: | Where-Object {
                $_.Name -in 'PATH', 'PATHEXT', 'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
                    'TEMP', 'TMP', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PROGRAMDATA', 'PROGRAMFILES',
                    'PROGRAMFILES(X86)', 'PROGRAMW6432', 'SYSTEMDRIVE', 'COMPUTERNAME', 'USERNAME', 'USERDOMAIN', 'CODEX_HOME'
            } | ForEach-Object { "$($_.Name)=$($_.Value)" })
        }
        $process = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
            CommandLine = "`"$t3`" serve --host 127.0.0.1 --port $Port --base-dir `"$dataDir`" --no-browser"
            CurrentDirectory = $Root; ProcessStartupInformation = $startup
        }
        if ($process.ReturnValue -ne 0) { throw "Server launch failed with Windows result $($process.ReturnValue)." }
        @{ pid = $process.ProcessId; executable = $t3; port = $Port } | ConvertTo-Json |
            Set-Content -LiteralPath $pidFile -Encoding UTF8
        Write-Output "Started PID $($process.ProcessId) on http://127.0.0.1:$Port. Use T3 pair locally to authorize your browser."
    }
    if ($Action -eq 'Stop') {
        $process = Get-OwnedServer
        if ($process) { Stop-Process -Id $process.ProcessId -ErrorAction Stop }
        Write-Output 'Local server stopped. Conversation data retained.'
    }
    if ($Action -eq 'Health') {
        $release = Get-Release
        $manifest = Get-Content -LiteralPath $currentFile -Raw | ConvertFrom-Json
        $owned = Get-OwnedServer
        $reachable = $false
        if ($owned) {
            $record = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
            try { $reachable = (Invoke-WebRequest "http://127.0.0.1:$($record.port)/" -UseBasicParsing -TimeoutSec 5).StatusCode -eq 200 }
            catch { $reachable = $false }
        }
        $health = [ordered]@{
            observedAt = [DateTimeOffset]::Now.ToString('o'); action = 'Health'; succeeded = $true; installed = $true
            t3 = $manifest.t3; codex = $manifest.codex; gitAvailable = [bool](Get-Command git.exe -ErrorAction SilentlyContinue)
            serverRunning = [bool]$owned; httpReady = $reachable
            providerSignIn = 'Will must verify locally'; localAgentAcceptance = 'not tested'
        }
        $health | ConvertTo-Json | Write-Output
        if ($ReceiptPath) { $health | ConvertTo-Json | Set-Content -LiteralPath $ReceiptPath -Encoding UTF8 }
    }
    elseif ($ReceiptPath) {
        @{ observedAt = [DateTimeOffset]::Now.ToString('o'); succeeded = $true; action = $Action } |
            ConvertTo-Json | Set-Content -LiteralPath $ReceiptPath -Encoding UTF8
    }
}
catch {
    if ($ReceiptPath) {
        @{ observedAt = [DateTimeOffset]::Now.ToString('o'); succeeded = $false; action = $Action } |
            ConvertTo-Json | Set-Content -LiteralPath $ReceiptPath -Encoding UTF8
    }
    throw
}
finally { if ($lock) { $lock.Dispose() } }
