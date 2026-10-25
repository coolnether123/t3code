[CmdletBinding()]
param(
    [string]$NodeDirectory = 'A:/Dev/Tooling/t3-node-v24.19.0',
    [string]$AndroidSdk = 'D:/Android/Sdk',
    [ValidatePattern('^\d+\.\d+\.\d+$')]
    [string]$NdkVersion = '28.2.13676358',
    [string]$CMakeDirectory = 'A:/Dev/Tooling/cmake-t3-android-3.31.5',
    [string]$CMakeVersion = '3.31.5',
    [string]$JavaDirectory = 'C:/Program Files/Eclipse Adoptium/jdk-21.0.5.11-hotspot',
    [string]$GradleDirectory = 'A:/Dev/Tooling/gradle-t3-android',
    [string]$KeyDirectory = 'A:/Dev/Tooling/keys/t3-android',
    [string]$OutputDirectory = 'A:/Dev/Artifacts/t3-android-app-20261024/build',
    [ValidatePattern('^(arm64-v8a|x86_64)(,(arm64-v8a|x86_64))*$')]
    [string]$Architectures = 'arm64-v8a,x86_64',
    [switch]$PrepareOnly,
    [switch]$SkipPrebuild
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repoDirectory = Split-Path $PSScriptRoot -Parent
$mobileDirectory = Join-Path $repoDirectory 'apps/mobile'
$node = Join-Path $NodeDirectory 'node.exe'
$expo = Join-Path $mobileDirectory 'node_modules/expo/bin/cli'
$keytool = Join-Path $JavaDirectory 'bin/keytool.exe'

function Invoke-Checked {
    param([string]$Program, [string[]]$Arguments)
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with exit ${LASTEXITCODE}: $Program"
    }
}

foreach ($requiredPath in @($node, $expo, $keytool, $AndroidSdk, (Join-Path $AndroidSdk "ndk/$NdkVersion/source.properties"), (Join-Path $CMakeDirectory 'bin/cmake.exe'), (Join-Path $CMakeDirectory 'bin/ninja.exe'))) {
    if (-not (Test-Path -LiteralPath $requiredPath)) {
        throw "Missing prerequisite: $requiredPath. Install locked dependencies with the repo-local vp first."
    }
}
if ($PrepareOnly -and $SkipPrebuild) { throw 'PrepareOnly and SkipPrebuild cannot be combined.' }
$privateKeysRoot = [IO.Path]::GetFullPath('A:/Dev/Tooling/keys') + [IO.Path]::DirectorySeparatorChar
if (-not ([IO.Path]::GetFullPath($KeyDirectory) + [IO.Path]::DirectorySeparatorChar).StartsWith(
    $privateKeysRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Signing keys must stay under A:/Dev/Tooling/keys.'
}

$env:JAVA_HOME = $JavaDirectory
$env:ANDROID_HOME = $AndroidSdk
$env:ANDROID_SDK_ROOT = $AndroidSdk
$env:GRADLE_USER_HOME = $GradleDirectory
$env:Path = "$NodeDirectory;$JavaDirectory/bin;$AndroidSdk/platform-tools;$env:Path"
$env:APP_VARIANT = 'preview'
$env:T3CODE_MOBILE_UPDATES_ENABLED = '0'
$env:EXPO_NO_TELEMETRY = '1'
$env:EXPO_NO_DOTENV = '1'
$env:CI = '1'
$env:CMAKE_BUILD_PARALLEL_LEVEL = '1'

New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
Push-Location $mobileDirectory
try {
    if (-not $SkipPrebuild) {
        Invoke-Checked $node @($expo, 'prebuild', '--platform', 'android', '--no-install')
    }
    $androidDirectory = Join-Path $mobileDirectory 'android'
    $appGradle = Join-Path $androidDirectory 'app/build.gradle'
    if (-not (Test-Path -LiteralPath $appGradle)) { throw 'Expo did not generate app/build.gradle.' }
    $utf8 = New-Object System.Text.UTF8Encoding $false
    $sdkPath = $AndroidSdk.Replace('\', '/').Replace(':', '\:')
    $cmakePath = $CMakeDirectory.Replace('\', '/').Replace(':', '\:')
    [IO.File]::WriteAllText((Join-Path $androidDirectory 'local.properties'), "sdk.dir=$sdkPath`ncmake.dir=$cmakePath`n", $utf8)

    # Expo's fallback NDK can differ from the one already installed for React Native.
    $rootGradle = Join-Path $androidDirectory 'build.gradle'
    $rootGradleSource = [IO.File]::ReadAllText($rootGradle)
    $rootGradleSource = $rootGradleSource -replace '(?m)^ext\.ndkVersion = .*\r?\n', ''
    $rootGradleSource = ($rootGradleSource -split '(?m)^// Local Android build concurrency\r?$', 2)[0].TrimEnd()
    # AGP invokes Ninja directly, so CMAKE_BUILD_PARALLEL_LEVEL alone does not bound compilers.
    $nativePools = @'
// Local Android build concurrency
allprojects {
  pluginManager.withPlugin('com.android.base') {
    android.defaultConfig.externalNativeBuild.cmake.arguments(
      '-DCMAKE_JOB_POOLS=compile=1;link=1',
      '-DCMAKE_JOB_POOL_COMPILE=compile',
      '-DCMAKE_JOB_POOL_LINK=link'
    )
  }
}
'@
    $rootGradleSource = "$rootGradleSource`n`n$nativePools`n"
    [IO.File]::WriteAllText($rootGradle, "ext.ndkVersion = '$NdkVersion'`n$rootGradleSource", $utf8)

    # Sign the finished APK with the private local key instead of Expo's public debug key.
    $gradleSource = [IO.File]::ReadAllText($appGradle)
    $gradleSource = $gradleSource -replace '(?m)^\s*signingConfig signingConfigs\.debug\s*$', ''
    $gradleSource = $gradleSource -replace '(?m)^\s*(?://\s*)?extraPackagerArgs = .*$', '    extraPackagerArgs = ["--max-workers", "1"]'
    [IO.File]::WriteAllText($appGradle, $gradleSource, $utf8)
    if ($PrepareOnly) {
        Write-Output 'Android sources prepared. No APK built.'
        return
    }

    Push-Location $androidDirectory
    try {
        Invoke-Checked (Join-Path $androidDirectory 'gradlew.bat') @(
            ':app:assembleRelease', '--no-daemon', '--console=plain', '--max-workers=1',
            '-Dorg.gradle.jvmargs=-Xmx1536m -XX:MaxMetaspaceSize=512m',
            '-Dorg.gradle.parallel=false', '-Pkotlin.compiler.execution.strategy=in-process',
            "-Pandroid.cmakeVersion=$CMakeVersion",
            "-PreactNativeArchitectures=$Architectures", '-Pandroid.builder.sdkDownload=false'
        )
    } finally { Pop-Location }

    $unsignedApk = Join-Path $androidDirectory 'app/build/outputs/apk/release/app-release-unsigned.apk'
    if (-not (Test-Path -LiteralPath $unsignedApk)) { throw "Missing unsigned APK: $unsignedApk" }
    $buildTools = Get-ChildItem -LiteralPath (Join-Path $AndroidSdk 'build-tools') -Directory |
        Where-Object { $_.Name -match '^\d+\.\d+\.\d+$' } |
        Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
    if (-not $buildTools) { throw 'Android SDK build-tools are missing.' }

    New-Item -ItemType Directory -Path $KeyDirectory -Force | Out-Null
    $keyPath = Join-Path $KeyDirectory 't3-local.p12'
    $passwordPath = Join-Path $KeyDirectory 'store-password.txt'
    if ((Test-Path -LiteralPath $keyPath) -and -not (Test-Path -LiteralPath $passwordPath)) {
        throw 'The existing signing key has no password file. Restore its password before building.'
    }
    if (-not (Test-Path -LiteralPath $passwordPath)) {
        $bytes = New-Object byte[] 32
        $random = [Security.Cryptography.RandomNumberGenerator]::Create()
        try { $random.GetBytes($bytes) } finally { $random.Dispose() }
        [IO.File]::WriteAllText($passwordPath, [Convert]::ToBase64String($bytes), $utf8)
    }
    $env:T3_ANDROID_STORE_PASSWORD = [IO.File]::ReadAllText($passwordPath).Trim()
    try {
        if (-not (Test-Path -LiteralPath $keyPath)) {
            Invoke-Checked $keytool @(
                '-genkeypair', '-noprompt', '-storetype', 'PKCS12', '-keystore', $keyPath,
                '-alias', 't3-local', '-keyalg', 'RSA', '-keysize', '3072', '-validity', '10000',
                '-dname', 'CN=T3 Code local Android build',
                '-storepass:env', 'T3_ANDROID_STORE_PASSWORD'
            )
        }
        $apkPath = Join-Path $OutputDirectory 't3-code-preview-local.apk'
        $alignedPath = Join-Path $OutputDirectory 't3-code-preview-aligned.apk'
        Invoke-Checked (Join-Path $buildTools.FullName 'zipalign.exe') @('-f', '-P', '16', '4', $unsignedApk, $alignedPath)
        $apksigner = Join-Path $buildTools.FullName 'apksigner.bat'
        Invoke-Checked $apksigner @('sign', '--ks', $keyPath, '--ks-key-alias', 't3-local',
            '--ks-pass', 'env:T3_ANDROID_STORE_PASSWORD', '--out', $apkPath, $alignedPath)
        Invoke-Checked $apksigner @('verify', '--verbose', '--print-certs', $apkPath)
        Invoke-Checked (Join-Path $buildTools.FullName 'zipalign.exe') @('-c', '-P', '16', '4', $apkPath)
    } finally { Remove-Item Env:T3_ANDROID_STORE_PASSWORD -ErrorAction SilentlyContinue }

    $revision = & git -C $repoDirectory rev-parse HEAD
    if ($LASTEXITCODE -ne 0) { throw 'Could not read source revision.' }
    $metadata = [ordered]@{
        sourceRevision = $revision
        builtAtUtc = [DateTime]::UtcNow.ToString('o')
        apk = $apkPath
        sha256 = (Get-FileHash -LiteralPath $apkPath -Algorithm SHA256).Hash.ToLowerInvariant()
        sizeBytes = (Get-Item -LiteralPath $apkPath).Length
        architectures = $Architectures
        variant = 'preview'
        updatesEnabled = $false
        node = (& $node --version)
        androidSdk = $AndroidSdk
        ndkVersion = $NdkVersion
        cmakeVersion = $CMakeVersion
        cmakeDirectory = $CMakeDirectory
        buildTools = $buildTools.Name
        lockSha256 = (Get-FileHash (Join-Path $repoDirectory 'pnpm-lock.yaml')).Hash.ToLowerInvariant()
    }
    [IO.File]::WriteAllText((Join-Path $OutputDirectory 'build.json'), ($metadata | ConvertTo-Json), $utf8)
    Write-Output "APK: $apkPath"
    Write-Output "SHA256: $($metadata.sha256)"
} finally { Pop-Location }
