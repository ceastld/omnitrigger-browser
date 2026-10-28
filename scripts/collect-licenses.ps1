#Requires -Version 7.0
[CmdletBinding()]
param(
    [ValidatePattern('^[a-zA-Z0-9_-]+$')]
    [string]$Target = 'x86_64-pc-windows-msvc',
    [string]$OutputDirectory,
    [switch]$Check
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $repoRoot 'third-party' }
$outputRoot = [IO.Path]::GetFullPath($OutputDirectory)
if (-not $outputRoot.StartsWith($repoRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw '许可输出必须位于当前仓库目录内。'
}

function Assert-LocalOrdinaryPath([string]$Path) {
    $full = [IO.Path]::GetFullPath($Path)
    if ($full -match '(?i)(^|[\\/])(OneDrive[^\\/]*|Dropbox|iCloud[^\\/]*)([\\/]|$)') {
        throw "跳过云盘路径，许可收集未完成：$full"
    }
    $current = $full
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -Force -LiteralPath $current
            # ReparsePoint, Offline, RecallOnOpen, RecallOnDataAccess.
            if (([int64]$item.Attributes -band (0x400 + 0x1000 + 0x40000 + 0x400000)) -ne 0) {
                throw "跳过链接或云端占位，许可收集未完成：$current"
            }
        }
        $parent = [IO.Path]::GetDirectoryName($current)
        if ($parent -eq $current) { break }
        $current = $parent
    }
}

function Read-LicenseBytes([string]$Path) {
    Assert-LocalOrdinaryPath $Path
    $file = Get-Item -Force -LiteralPath $Path
    if ($file.PSIsContainer -or $file.Length -eq 0 -or $file.Length -gt 2MB) {
        throw "许可文件为空、不是普通文件或超过 2 MiB：$Path"
    }
    return ,([IO.File]::ReadAllBytes($file.FullName))
}

function Hash-Bytes([byte[]]$Bytes) {
    return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Bytes)).ToLowerInvariant()
}

function Get-LicenseIds([string]$Text) {
    $found = [Collections.Generic.List[string]]::new()
    if ($Text -match '(?is)Permission is hereby granted, free of charge' -and $Text -match '(?is)THE SOFTWARE IS PROVIDED.*AS IS' -and $Text.Length -gt 800) { $found.Add('MIT') }
    if ($Text -match '(?is)Apache License.*Version 2\.0' -and $Text -match 'END OF TERMS AND CONDITIONS' -and $Text.Length -gt 9000) { $found.Add('Apache-2.0') }
    if ($Text -match '(?is)UNICODE.*LICENSE' -and $Text -match '(?is)Permission is hereby granted' -and $Text -match '(?is)THE DATA FILES AND SOFTWARE ARE PROVIDED' -and $Text.Length -gt 1000) { $found.Add('Unicode-3.0') }
    if ($Text -match '(?is)This is free and unencumbered software released into the public domain' -and $Text -match '(?is)THE SOFTWARE IS PROVIDED.*AS IS' -and $Text.Length -gt 900) { $found.Add('Unlicense') }
    return $found.ToArray()
}

Assert-LocalOrdinaryPath $repoRoot
Assert-LocalOrdinaryPath (Join-Path $repoRoot 'Cargo.lock')
Assert-LocalOrdinaryPath $outputRoot
$metadataText = & cargo metadata --offline --locked --format-version 1 --filter-platform $Target --manifest-path (Join-Path $repoRoot 'Cargo.toml')
if ($LASTEXITCODE -ne 0) { throw 'cargo metadata --locked 失败；没有生成许可输出。' }
$metadata = $metadataText | ConvertFrom-Json
$nodes = @{}
foreach ($node in $metadata.resolve.nodes) { $nodes[$node.id] = $node }
$reachable = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
$queue = [Collections.Generic.Queue[string]]::new()
foreach ($member in $metadata.workspace_members) { $queue.Enqueue($member) }
while ($queue.Count -gt 0) {
    $id = $queue.Dequeue()
    if (-not $reachable.Add($id)) { continue }
    foreach ($dependency in $nodes[$id].deps) {
        if (@($dependency.dep_kinds | Where-Object { $null -eq $_.kind -or $_.kind -eq 'build' }).Count -gt 0) {
            $queue.Enqueue($dependency.pkg)
        }
    }
}

$packages = @($metadata.packages | Where-Object { $reachable.Contains($_.id) -and $_.id -notin $metadata.workspace_members } | Sort-Object name, version)
$plan = [Collections.Generic.List[object]]::new()
$entries = [Collections.Generic.List[object]]::new()
foreach ($package in $packages) {
    if ($package.name -notmatch '^[a-zA-Z0-9_-]+$' -or $package.version -notmatch '^[a-zA-Z0-9.+_-]+$') { throw '包名或版本不能用作许可目录名。' }
    if (-not $package.license) { throw "缺少 SPDX 声明，需要人工核对：$($package.name)" }
    $declared = @([regex]::Matches($package.license, '[A-Za-z][A-Za-z0-9.+-]*') | ForEach-Object Value | Where-Object { $_ -notin @('AND', 'OR') } | Sort-Object -Unique)
    if (@($declared | Where-Object { $_ -notin @('MIT', 'Apache-2.0', 'Unicode-3.0', 'Unlicense') }).Count -gt 0) {
        throw "尚未支持的许可表达式，需要人工核对：$($package.name) $($package.license)"
    }
    $crateRoot = [IO.Path]::GetFullPath((Split-Path -Parent $package.manifest_path))
    Assert-LocalOrdinaryPath $crateRoot
    Assert-LocalOrdinaryPath $package.manifest_path
    # Only inspect the explicit crate root supplied by Cargo metadata. No home,
    # cargo-cache or source-tree recursive search is performed.
    $candidates = @(Get-ChildItem -Force -LiteralPath $crateRoot -File | Where-Object { $_.Name -match '(?i)^(LICENSE|LICENCE|COPYING|NOTICE|COPYRIGHT|UNLICENSE)($|[._-])' } | ForEach-Object FullName)
    if ($package.license_file) {
        $specified = [IO.Path]::GetFullPath((Join-Path $crateRoot $package.license_file))
        if (-not $specified.StartsWith($crateRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw "license_file 越出包目录：$($package.name)" }
        $candidates += $specified
    }
    $files = [Collections.Generic.List[object]]::new()
    $present = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($source in $candidates | Sort-Object -Unique) {
        $bytes = Read-LicenseBytes $source
        $text = [Text.UTF8Encoding]::new($false, $true).GetString($bytes)
        $licenseIds = @(Get-LicenseIds $text)
        foreach ($licenseId in $licenseIds) { [void]$present.Add($licenseId) }
        $relative = "$($package.name)-$($package.version)/$([IO.Path]::GetFileName($source))"
        $destination = Join-Path $outputRoot $relative
        Assert-LocalOrdinaryPath $destination
        $plan.Add([pscustomobject]@{ Path=$destination; Bytes=$bytes })
        $files.Add([ordered]@{ path=$relative; sha256=(Hash-Bytes $bytes); license_ids=$licenseIds })
    }
    $missing = @($declared | Where-Object { -not $present.Contains($_) })
    if ($missing.Count -gt 0) { throw "缺少完整许可正文（不能仅用链接代替）：$($package.name) $($package.version)：$($missing -join ', ')" }
    $entries.Add([ordered]@{
        name=$package.name; version=$package.version; license=$package.license
        source=$package.source; repository=$package.repository; authors=@($package.authors)
        files=$files.ToArray()
    })
}

$index = [ordered]@{
    format_version=1; target=$Target
    cargo_lock_sha256=(Hash-Bytes ([IO.File]::ReadAllBytes((Join-Path $repoRoot 'Cargo.lock'))))
    scope='normal-and-build-dependencies'; packages=$entries.ToArray()
}
# Git and CI use LF for this generated JSON; original license bytes stay untouched.
$indexText = (($index | ConvertTo-Json -Depth 15) -replace "\r\n?", "`n") + "`n"
$indexPath = Join-Path $outputRoot 'index.json'
Assert-LocalOrdinaryPath $indexPath
if ($Check) {
    foreach ($file in $plan) {
        if (-not (Test-Path -LiteralPath $file.Path) -or (Hash-Bytes ([IO.File]::ReadAllBytes($file.Path))) -ne (Hash-Bytes $file.Bytes)) {
            throw "许可副本缺失或被修改：$($file.Path)"
        }
    }
    if (-not (Test-Path -LiteralPath $indexPath) -or [IO.File]::ReadAllText($indexPath) -ne $indexText) { throw '许可 index.json 与 Cargo.lock 或元数据不一致，请重新收集。' }
    Write-Host "许可核验通过：$($entries.Count) 个 $Target 正常及构建依赖。"
    return
}

# All inputs have passed validation before writing. Existing extra files are
# never deleted by this collector; distribution must use index.json's file list.
foreach ($file in $plan) {
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($file.Path))
    [IO.File]::WriteAllBytes($file.Path, $file.Bytes)
}
[void][IO.Directory]::CreateDirectory($outputRoot)
[IO.File]::WriteAllText($indexPath, $indexText, [Text.UTF8Encoding]::new($false))
Write-Host "已收集 $($entries.Count) 个 $Target 正常及构建依赖的许可：$outputRoot"
