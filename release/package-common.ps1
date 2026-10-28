#requires -Version 7.0
Set-StrictMode -Version Latest

function Assert-LocalPackagePath([string]$Path) {
    $resolved = [IO.Path]::GetFullPath($Path)
    if ($resolved -match '(?i)(^|[\\/])(OneDrive[^\\/]*|Dropbox|iCloud[^\\/]*)([\\/]|$)') {
        throw "拒绝打包云盘路径：$resolved"
    }
    for ($candidate = $resolved; $candidate; $candidate = [IO.Path]::GetDirectoryName($candidate)) {
        if (Test-Path -LiteralPath $candidate) {
            $item = Get-Item -Force -LiteralPath $candidate
            if (([int64]$item.Attributes -band (0x400 -bor 0x1000 -bor 0x40000 -bor 0x400000)) -ne 0) {
                throw "拒绝链接或云端占位：$candidate"
            }
        }
        $parent = [IO.Path]::GetDirectoryName($candidate)
        if ($parent -eq $candidate) { break }
    }
    return $resolved
}

function Get-ReleaseVersion([string]$Root) {
    $metadata = & cargo metadata --locked --no-deps --format-version 1 --manifest-path (Join-Path $Root 'Cargo.toml') | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0) { throw '无法读取锁定的 Cargo 包版本。' }
    $packages = @($metadata.packages | Where-Object name -eq 'omnitrigger-browser')
    if ($packages.Count -ne 1 -or $packages[0].version -notmatch '^\d+\.\d+\.\d+$') { throw '发行版本必须是 Chrome 可使用的三段数字版本。' }
    return [string]$packages[0].version
}

function Get-ReleaseExtensionIdentity([string]$Root) {
    $script = Assert-LocalPackagePath (Join-Path $Root 'scripts/extension-identity.mjs')
    $identity = & node $script | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or $identity.schemaVersion -ne 1 -or $identity.extensionId -notmatch '^[a-p]{32}$' -or $identity.publicKeySha256 -notmatch '^[a-f0-9]{64}$') {
        throw '扩展公开 key 与固定身份校验失败。'
    }
    return $identity
}

function Write-PackageZip([string]$Path, [System.Collections.IDictionary]$Files) {
    $zipPath = Assert-LocalPackagePath $Path
    $null = [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($zipPath))
    $expected = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($name in $Files.Keys) {
        if ($name -match '(^/|\\|(^|/)\.\.?(/|$)|:)' -or -not $expected.Add($name)) { throw "非法 ZIP 项：$name" }
        $source = Assert-LocalPackagePath $Files[$name]
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "缺少打包输入：$source" }
    }
    $file = [IO.File]::Open($zipPath, [IO.FileMode]::Create, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    try {
        $zip = [IO.Compression.ZipArchive]::new($file, [IO.Compression.ZipArchiveMode]::Create, $true)
        try {
            foreach ($name in @($Files.Keys | Sort-Object -CaseSensitive)) {
                $entry = $zip.CreateEntry($name, [IO.Compression.CompressionLevel]::Optimal)
                $entry.LastWriteTime = [DateTimeOffset]::new(2000, 1, 1, 0, 0, 0, [TimeSpan]::Zero)
                $output = $entry.Open()
                $sourceStream = [IO.File]::OpenRead($Files[$name])
                try { $sourceStream.CopyTo($output) } finally { $sourceStream.Dispose(); $output.Dispose() }
            }
        } finally { $zip.Dispose() }
    } finally { $file.Dispose() }
    # Verify the archive's inventory and each decompressed file against this build's source.
    $archive = [IO.Compression.ZipFile]::OpenRead($zipPath)
    try {
        if ($archive.Entries.Count -ne $Files.Count) { throw '打包后条目数不一致。' }
        foreach ($entry in $archive.Entries) {
            if (-not $expected.Remove($entry.FullName)) { throw "打包后出现未知或重复条目：$($entry.FullName)" }
            $sourceHash = (Get-FileHash -LiteralPath $Files[$entry.FullName] -Algorithm SHA256).Hash
            $stream = $entry.Open()
            try { $hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($stream)) } finally { $stream.Dispose() }
            if ($sourceHash -ne $hash) { throw "打包后内容校验失败：$($entry.FullName)" }
        }
        if ($expected.Count) { throw '打包后缺少输入条目。' }
    } finally { $archive.Dispose() }
    return [pscustomobject]@{
        Path = $zipPath
        FileName = [IO.Path]::GetFileName($zipPath)
        Sha256 = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
        SizeBytes = (Get-Item -LiteralPath $zipPath).Length
        EntryCount = $Files.Count
    }
}
