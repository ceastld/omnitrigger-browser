#requires -Version 7.0
[CmdletBinding()]
param(
    [ValidateSet('x86_64-pc-windows-msvc')][string]$Target = 'x86_64-pc-windows-msvc',
    [ValidatePattern('^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$')][string]$Repository = 'ceastld/omnitrigger-browser',
    [string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $repoRoot 'release/package-common.ps1')
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $repoRoot 'dist' }
$outputRoot = Assert-LocalPackagePath $OutputDirectory
$version = Get-ReleaseVersion $repoRoot
$identity = Get-ReleaseExtensionIdentity $repoRoot
$null = [IO.Directory]::CreateDirectory($outputRoot)

Push-Location -LiteralPath $repoRoot
try {
    $messages = & cargo build --release --locked --target $Target --message-format=json
    if ($LASTEXITCODE -ne 0) { throw 'Release 构建失败。' }
    $executables = @{}
    foreach ($line in $messages) {
        try { $item = $line | ConvertFrom-Json } catch { continue }
        if ($item.reason -eq 'compiler-artifact' -and $item.executable) { $executables[$item.target.name] = $item.executable }
    }
    & (Join-Path $PSScriptRoot 'collect-licenses.ps1') -Target $Target -Check
    if (-not $?) { throw '发行许可核验失败。' }
} finally { Pop-Location }

$files = [ordered]@{}
$binarySizes = [ordered]@{}
foreach ($name in @('omnitrigger-browser', 'omnitrigger-browser-host')) {
    if (-not $executables.ContainsKey($name)) { throw "本次构建没有返回程序：$name" }
    $file = Assert-LocalPackagePath $executables[$name]
    $files["$name.exe"] = $file
    $binarySizes["$name.exe"] = (Get-Item -LiteralPath $file).Length
}
$files['LICENSE'] = Join-Path $repoRoot 'LICENSE'
$files['THIRD_PARTY_NOTICES.md'] = Join-Path $repoRoot 'THIRD_PARTY_NOTICES.md'
$files['README.md'] = Join-Path $repoRoot 'release/RUNTIME_README.md'
foreach ($name in @('install.ps1', 'uninstall.ps1', 'register-native-host.ps1')) {
    $files["installer/$name"] = Join-Path $repoRoot "installer/$name"
}
foreach ($name in @('index.mjs', 'protocol.mjs', 'package.json', 'README.md')) {
    $files["sdk-js/$name"] = Join-Path $repoRoot "sdk-js/$name"
}
$licenseIndexPath = Assert-LocalPackagePath (Join-Path $repoRoot 'third-party/index.json')
$licenseIndex = Get-Content -Raw -LiteralPath $licenseIndexPath | ConvertFrom-Json
if ($licenseIndex.format_version -ne 1 -or $licenseIndex.target -ne $Target) { throw '第三方许可索引目标不匹配。' }
$files['third-party/index.json'] = $licenseIndexPath
foreach ($package in $licenseIndex.packages) {
    foreach ($license in $package.files) {
        $name = [string]$license.path
        if ($name -match '(^/|\\|(^|/)\.\.?(/|$)|:)' -or $files.Contains("third-party/$name")) { throw '许可索引存在越界或重复条目。' }
        $source = Assert-LocalPackagePath (Join-Path $repoRoot "third-party/$name")
        if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant() -ne $license.sha256) { throw "许可内容与索引不符：$name" }
        $files["third-party/$name"] = $source
    }
}

$metadataDirectory = Join-Path $outputRoot ".metadata-$version"
$null = [IO.Directory]::CreateDirectory($metadataDirectory)
$connectorMetadataPath = Join-Path $metadataDirectory 'connector.json'
$encoding = [Text.UTF8Encoding]::new($false)
$connectorMetadata = [ordered]@{
    schemaVersion = 1; version = $version; protocolVersion = 1
    extensionId = $identity.extensionId
    hostName = 'com.omnitrigger.browser'; target = $Target
    entrypoints = [ordered]@{ cli = 'omnitrigger-browser.exe'; nativeHost = 'omnitrigger-browser-host.exe' }
}
[IO.File]::WriteAllText($connectorMetadataPath, ($connectorMetadata | ConvertTo-Json -Depth 8) + "`n", $encoding)
$files['connector.json'] = $connectorMetadataPath
$connector = Write-PackageZip (Join-Path $outputRoot "OmniTrigger-Browser-Connector-$version-windows-x86_64.zip") $files
$extension = & (Join-Path $PSScriptRoot 'package-extension.ps1') -OutputDirectory $outputRoot
if ($extension.ExtensionId -cne $identity.extensionId) { throw '打包过程中扩展身份发生变化，停止发布。' }
$baseUrl = "https://github.com/$Repository/releases/download/v$version"
$manifest = [ordered]@{
    schemaVersion = 1; version = $version; protocolVersion = 1; repository = $Repository
    extensionId = $identity.extensionId
    artifacts = [ordered]@{
        connector = [ordered]@{ fileName = $connector.FileName; url = "$baseUrl/$($connector.FileName)"; sha256 = $connector.Sha256; sizeBytes = $connector.SizeBytes; target = $Target }
        extension = [ordered]@{ fileName = $extension.FileName; url = "$baseUrl/$($extension.FileName)"; sha256 = $extension.Sha256; sizeBytes = $extension.SizeBytes }
    }
}
$manifestPath = Join-Path $outputRoot 'release-manifest.json'
[IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 10) + "`n", $encoding)
$checksumLines = @($connector.Path, $extension.Path, $manifestPath) | ForEach-Object {
    "{0}  {1}" -f (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash.ToLowerInvariant(), [IO.Path]::GetFileName($_)
}
[IO.File]::WriteAllText((Join-Path $outputRoot 'SHA256SUMS.txt'), ($checksumLines -join "`n") + "`n", $encoding)
Write-Host "连接器已打包：$($connector.FileName)，$($connector.SizeBytes) 字节。"
$summary = [ordered]@{
    version = $version; manifestPath = $manifestPath
    extensionId = $identity.extensionId
    connectorZipBytes = $connector.SizeBytes; extensionZipBytes = $extension.SizeBytes
    binaries = $binarySizes; connectorEntryCount = $connector.EntryCount
}
$summary | ConvertTo-Json -Depth 5 | Write-Host
[pscustomobject]$summary
