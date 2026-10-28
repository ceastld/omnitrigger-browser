#requires -Version 5.1
[CmdletBinding()]
param([Parameter(Mandatory)][string]$PackageDirectory)
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$packageRoot = [IO.Path]::GetFullPath($PackageDirectory)
$installRoot = Join-Path $repoRoot ('.local\package install test ' + [Guid]::NewGuid().ToString('N'))
$registry = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.omnitrigger.browser'
$registryBefore = $(if (Test-Path -LiteralPath $registry) { [string](Get-Item -LiteralPath $registry).GetValue('') } else { $null })
$nativePowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$savedPath = $env:PATH
try {
    # 本测试不提供 Cargo 或 Node，发布包安装只依赖 Windows PowerShell 和自身 EXE。
    $env:PATH = (Join-Path $env:SystemRoot 'System32')
    $script = Join-Path $packageRoot 'installer\install.ps1'
    & $nativePowerShell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $script -SourceDirectory $packageRoot -InstallDirectory $installRoot
    if ($LASTEXITCODE -ne 0) { throw '无 Rust 环境的发布包安装失败。' }
    foreach ($relative in @('omnitrigger-browser.exe','omnitrigger-browser-host.exe','sdk-js\index.mjs','sdk-js\protocol.mjs','LICENSE','THIRD_PARTY_NOTICES.md','third-party\index.json','connector.json','connection.json','installation-files.json')) {
        if (-not (Test-Path -LiteralPath (Join-Path $installRoot $relative) -PathType Leaf)) { throw "安装缺少文件：$relative" }
    }
    $config = Get-Content -LiteralPath (Join-Path $installRoot 'connection.json') -Raw | ConvertFrom-Json
    if (-not $config.pipe -or @($config.extension_ids).Count -ne 0) { throw '首次无扩展 ID 安装没有生成未注册连接配置。' }
    $registryAfter = $(if (Test-Path -LiteralPath $registry) { [string](Get-Item -LiteralPath $registry).GetValue('') } else { $null })
    if ($registryBefore -cne $registryAfter) { throw '首次空 ID 安装修改了现有 Native Host 注册。' }
    Write-Output '发布包安装测试通过：无 Cargo/Node、空 ID、空格路径、完整 SDK/许可/元数据、保护已有注册。'
} finally {
    $env:PATH = $savedPath
    # 留在已忽略 .local 中，便于检查实际安装；不尝试递归删除。
}
