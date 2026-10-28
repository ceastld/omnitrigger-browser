#requires -Version 7.0
[CmdletBinding()]
param([string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $repoRoot 'release/package-common.ps1')
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $repoRoot 'dist' }
$outputRoot = Assert-LocalPackagePath $OutputDirectory
$version = Get-ReleaseVersion $repoRoot
$extensionRoot = Join-Path $repoRoot 'extension'
$manifest = Get-Content -Raw -LiteralPath (Assert-LocalPackagePath (Join-Path $extensionRoot 'manifest.json')) | ConvertFrom-Json
if ($manifest.manifest_version -ne 3 -or $manifest.version -ne $version) { throw '扩展 manifest 与 Cargo 发行版本不一致。' }
$files = [ordered]@{}
# This explicit inventory deliberately excludes tests, source maps and local configuration.
foreach ($name in @('manifest.json', 'background.mjs', 'api-modes.mjs', 'rpc.mjs', 'popup.html', 'popup.mjs', 'popup.css')) {
    $files[$name] = Join-Path $extensionRoot $name
}
foreach ($path in @($manifest.background.service_worker, $manifest.action.default_popup)) {
    if (-not $files.Contains($path)) { throw "manifest 引用未列入发布清单：$path" }
}
$result = Write-PackageZip (Join-Path $outputRoot "OmniTrigger-Browser-Extension-$version.zip") $files
Write-Host "扩展已打包：$($result.FileName)，$($result.SizeBytes) 字节，$($result.EntryCount) 个文件。"
$result | Add-Member -NotePropertyName Version -NotePropertyValue $version -PassThru
