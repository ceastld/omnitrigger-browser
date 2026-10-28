#requires -Version 5.1
[CmdletBinding()]
param([string]$InstallDirectory = (Join-Path $env:LOCALAPPDATA 'OmniTriggerBrowser'))
$ErrorActionPreference = 'Stop'
$installRoot = [IO.Path]::GetFullPath($InstallDirectory)
$registrationScript = Join-Path $PSScriptRoot 'register-native-host.ps1'
$resultText = & $registrationScript -Mode Unregister -InstallDirectory $installRoot
if ($LASTEXITCODE -ne 0) { throw "未卸载：$resultText" }
$result = $resultText | ConvertFrom-Json
if (-not $result.ok) { throw $result.error.message }

$files = @('omnitrigger-browser.exe','omnitrigger-browser-host.exe','connection.json','com.omnitrigger.browser.json')
$index = Join-Path $installRoot 'installation-files.json'
if (Test-Path -LiteralPath $index) {
    $item = Get-Item -LiteralPath $index
    if ($item.Length -gt 1048576 -or ([int64]$item.Attributes -band (0x400 + 0x1000 + 0x40000 + 0x400000)) -ne 0) { throw '安装文件清单不可用。' }
    $files += @(Get-Content -LiteralPath $index -Raw | ConvertFrom-Json)
}
$files += 'installation-files.json'
$directories = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
foreach ($relative in @($files | Select-Object -Unique)) {
    if ($relative -isnot [string] -or [IO.Path]::IsPathRooted($relative)) { throw '安装清单包含无效路径。' }
    $path = [IO.Path]::GetFullPath((Join-Path $installRoot $relative))
    if (-not $path.StartsWith($installRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw '卸载路径超出安装目录。' }
    $current = $path
    while ($current -and $current.StartsWith($installRoot, [StringComparison]::OrdinalIgnoreCase)) {
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force
            if (([int64]$item.Attributes -band (0x400 + 0x1000 + 0x40000 + 0x400000)) -ne 0) { throw '卸载路径包含链接或云端占位文件。' }
        }
        $current = [IO.Path]::GetDirectoryName($current)
    }
    if (Test-Path -LiteralPath $path -PathType Leaf) { Remove-Item -LiteralPath $path -Force }
    $parent = [IO.Path]::GetDirectoryName($path)
    while ($parent -and -not [StringComparer]::OrdinalIgnoreCase.Equals($parent, $installRoot)) {
        $null = $directories.Add($parent)
        $parent = [IO.Path]::GetDirectoryName($parent)
    }
}
foreach ($directory in @($directories | Sort-Object Length -Descending)) {
    if ((Test-Path -LiteralPath $directory -PathType Container) -and -not @(Get-ChildItem -LiteralPath $directory -Force).Count) { Remove-Item -LiteralPath $directory }
}
Write-Output '已移除自身注册和清单列出的安装文件；未修改 Chrome 资料、书签或其他文件。'
