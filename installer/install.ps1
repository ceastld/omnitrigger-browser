#requires -Version 5.1
[CmdletBinding()]
param(
    [ValidatePattern('^[a-p]{32}$')][string[]]$ExtensionId = @(),
    [string]$InstallDirectory = (Join-Path $env:LOCALAPPDATA 'OmniTriggerBrowser'),
    [string]$SourceDirectory,
    [switch]$SkipBuild
)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$installRoot = [IO.Path]::GetFullPath($InstallDirectory)
$sourceRoot = $(if ($SourceDirectory) { [IO.Path]::GetFullPath($SourceDirectory) } else { $repoRoot })
$registrationScript = Join-Path $PSScriptRoot 'register-native-host.ps1'
$registryPath = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.omnitrigger.browser'
$manifestPath = Join-Path $installRoot 'com.omnitrigger.browser.json'
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Assert-Ordinary([string]$Path) {
    $current = [IO.Path]::GetFullPath($Path)
    if ($current -match '(?i)(^|[\\/])(OneDrive[^\\/]*|Dropbox|iCloud[^\\/]*)([\\/]|$)') { throw '连接器文件不能位于云盘同步目录。' }
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            if (([int64](Get-Item -LiteralPath $current -Force).Attributes -band (0x400 + 0x1000 + 0x40000 + 0x400000)) -ne 0) { throw '拒绝安装链接、联接点或云端占位文件。' }
        }
        $parent = [IO.Path]::GetDirectoryName($current)
        if ($parent -eq $current) { break }
        $current = $parent
    }
}
function Copy-OrdinaryTree([string]$Source, [string]$Relative) {
    Assert-Ordinary $Source
    $item = Get-Item -LiteralPath $Source -Force
    if ($item.PSIsContainer) {
        $sourceFull = [IO.Path]::GetFullPath($Source).TrimEnd('\')
        if ([StringComparer]::OrdinalIgnoreCase.Equals($installRoot, $sourceFull) -or $installRoot.StartsWith($sourceFull + '\', [StringComparison]::OrdinalIgnoreCase)) { throw '安装目录不能位于待复制的组件目录内。' }
        foreach ($child in Get-ChildItem -LiteralPath $Source -Force) { Copy-OrdinaryTree $child.FullName (Join-Path $Relative $child.Name) }
    } else {
        $target = [IO.Path]::GetFullPath((Join-Path $installRoot $Relative))
        if (-not $target.StartsWith($installRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw '安装目标越界。' }
        Assert-Ordinary $target
        $null = New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force
        if (-not [StringComparer]::OrdinalIgnoreCase.Equals($Source, $target)) { Copy-Item -LiteralPath $Source -Destination $target -Force }
        $installedFiles.Add($Relative)
    }
}
Assert-Ordinary $sourceRoot
Assert-Ordinary $installRoot
$existingConfig = $null
$existingConfigPath = Join-Path $installRoot 'connection.json'
if (Test-Path -LiteralPath $existingConfigPath) {
    Assert-Ordinary $existingConfigPath
    if ((Get-Item -LiteralPath $existingConfigPath).Length -gt 65536) { throw '已有连接配置超过 64 KiB。' }
    $existingConfig = [IO.File]::ReadAllText($existingConfigPath, $utf8) | ConvertFrom-Json
    if (-not $PSBoundParameters.ContainsKey('ExtensionId')) {
        $ExtensionId = @($existingConfig.extension_ids)
        foreach ($id in $ExtensionId) { if ($id -cnotmatch '^[a-p]{32}$') { throw '已有连接配置包含无效扩展 ID。' } }
    }
}
if ($ExtensionId.Count -and (Test-Path -LiteralPath $registryPath)) {
    $existing = [string](Get-Item -LiteralPath $registryPath).GetValue('')
    if ($existing -and -not [StringComparer]::OrdinalIgnoreCase.Equals($existing, $manifestPath)) { throw "Native Host 已注册到另一位置，请先处理原安装：$existing" }
}

$artifacts = @{}
$packageSource = (Test-Path -LiteralPath (Join-Path $sourceRoot 'omnitrigger-browser.exe') -PathType Leaf) -and (Test-Path -LiteralPath (Join-Path $sourceRoot 'omnitrigger-browser-host.exe') -PathType Leaf)
if ($packageSource) {
    foreach ($name in @('omnitrigger-browser','omnitrigger-browser-host')) { $artifacts[$name] = Join-Path $sourceRoot "$name.exe" }
} elseif ($SourceDirectory) {
    throw '发布包目录缺少连接器 CLI 或 Native Host。'
} elseif ($SkipBuild) {
    foreach ($name in @('omnitrigger-browser','omnitrigger-browser-host')) { $artifacts[$name] = Join-Path $repoRoot "target\debug\$name.exe" }
} else {
    Push-Location -LiteralPath $repoRoot
    try {
        $build = & cargo build --locked --message-format=json
        if ($LASTEXITCODE -ne 0) { throw '构建失败。' }
        foreach ($line in $build) {
            try { $item = $line | ConvertFrom-Json } catch { continue }
            if ($item.reason -eq 'compiler-artifact' -and $item.executable) { $artifacts[$item.target.name] = $item.executable }
        }
    } finally { Pop-Location }
}
foreach ($name in @('omnitrigger-browser','omnitrigger-browser-host')) {
    if (-not $artifacts[$name] -or -not (Test-Path -LiteralPath $artifacts[$name] -PathType Leaf)) { throw "缺少本次构建产物：$name" }
    Assert-Ordinary $artifacts[$name]
}
$pipe = $(if ($existingConfig -and $existingConfig.pipe) { [string]$existingConfig.pipe } else { & $artifacts['omnitrigger-browser'] endpoint })
if (-not $pipe) { throw '无法取得本机连接地址。' }
$null = New-Item -ItemType Directory -Path $installRoot -Force
$installedFiles = New-Object 'System.Collections.Generic.List[string]'
foreach ($name in @('omnitrigger-browser','omnitrigger-browser-host')) { Copy-OrdinaryTree $artifacts[$name] "$name.exe" }
foreach ($name in @('sdk-js','installer','LICENSE','THIRD_PARTY_NOTICES.md','third-party','README.md','connector.json')) {
    $path = Join-Path $sourceRoot $name
    if (Test-Path -LiteralPath $path) { Copy-OrdinaryTree $path $name }
}
[IO.File]::WriteAllText((Join-Path $installRoot 'installation-files.json'), (@($installedFiles) | ConvertTo-Json -Depth 5), $utf8)
# 空 ID 只准备配置，不抢占已经由另一安装管理的 Native Host。
$resultText = & $registrationScript -Mode Configure -InstallDirectory $installRoot -ExtensionId $ExtensionId -Pipe "$pipe"
if ($LASTEXITCODE -ne 0) { throw "连接器文件已安装，但 Native Host 配置失败：$resultText" }
$result = $resultText | ConvertFrom-Json
if (-not $result.ok) { throw $result.error.message }
Write-Output "已安装连接器：$installRoot"
if ($result.state.registered) { Write-Output 'Native Host 已注册，可在扩展中启用连接。' }
else { Write-Output '尚未注册扩展 ID，可稍后运行 omnitrigger-browser register --extension-id ID。' }
Write-Output "启动服务：& '$installRoot\omnitrigger-browser.exe' serve"
