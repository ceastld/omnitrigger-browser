#requires -Version 5.1
[CmdletBinding()]
param(
    [ValidateSet('Configure', 'Status', 'Unregister')][string]$Mode,
    [string]$InstallDirectory,
    [string[]]$ExtensionId = @(),
    [string]$Pipe,
    [string]$RegistryPathForTesting
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$utf8 = New-Object System.Text.UTF8Encoding($false)
$errorCode = 'registration_failed'

function Fail([string]$Code, [string]$Message) { $script:errorCode = $Code; throw $Message }
function Assert-OrdinaryPath([string]$Path) {
    $current = [IO.Path]::GetFullPath($Path)
    if ($current -match '(?i)(^|[\\/])(OneDrive[^\\/]*|Dropbox|iCloud[^\\/]*)([\\/]|$)') { Fail 'invalid_path' '安装路径不能位于云盘同步目录。' }
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force
            if (([int64]$item.Attributes -band (0x400 + 0x1000 + 0x40000 + 0x400000)) -ne 0) { Fail 'invalid_path' '安装路径不能包含链接、联接点或云端占位文件。' }
        }
        $parent = [IO.Path]::GetDirectoryName($current)
        if ($parent -eq $current) { break }
        $current = $parent
    }
}
function Read-JsonFile([string]$Path) {
    Assert-OrdinaryPath $Path
    $item = Get-Item -LiteralPath $Path
    if ($item.PSIsContainer -or $item.Length -gt 65536) { Fail 'invalid_config' '配置文件无效或超过 64 KiB。' }
    [IO.File]::ReadAllText($Path, $utf8) | ConvertFrom-Json
}
function Atomic-Text([string]$Path, [string]$Text) {
    Assert-OrdinaryPath $Path
    $temporary = $Path + '.tmp-' + [Guid]::NewGuid().ToString('N')
    $backup = $Path + '.bak-' + [Guid]::NewGuid().ToString('N')
    [IO.File]::WriteAllText($temporary, $Text, $utf8)
    try {
        if (Test-Path -LiteralPath $Path) { [IO.File]::Replace($temporary, $Path, $backup); Remove-Item -LiteralPath $backup }
        else { [IO.File]::Move($temporary, $Path) }
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
}
function Registered-Manifest {
    if (Test-Path -LiteralPath $registryPath) { return [string](Get-Item -LiteralPath $registryPath).GetValue('') }
    return $null
}
function Get-State {
    $ids = @(); $configuredPipe = $null
    if (Test-Path -LiteralPath $configPath) {
        $config = Read-JsonFile $configPath
        if ($config.pipe -isnot [string] -or -not $config.pipe) { Fail 'invalid_config' 'connection.json 缺少 pipe。' }
        $configuredPipe = [string]$config.pipe
        $ids = @($config.extension_ids)
        foreach ($id in $ids) { if ($id -isnot [string] -or $id -cnotmatch '^[a-p]{32}$') { Fail 'invalid_config' 'connection.json 的扩展 ID 无效。' } }
    }
    $registeredPath = Registered-Manifest
    $ours = $registeredPath -and [StringComparer]::OrdinalIgnoreCase.Equals($registeredPath, $manifestPath)
    [ordered]@{
        installed = ((Test-Path -LiteralPath $hostPath -PathType Leaf) -and (Test-Path -LiteralPath $cliPath -PathType Leaf))
        install_directory = $installRoot
        config_path = $configPath
        manifest_path = $manifestPath
        host_path = $hostPath
        pipe = $configuredPipe
        extension_ids = @($ids)
        registered = [bool]($ours -and (Test-Path -LiteralPath $manifestPath -PathType Leaf))
        conflict = $(if ($registeredPath -and -not $ours) { $registeredPath } else { $null })
    }
}

try {
    if (-not $Mode) { $Mode = $env:OMNITRIGGER_REGISTRATION_MODE }
    if (-not $InstallDirectory) { $InstallDirectory = $env:OMNITRIGGER_REGISTRATION_DIRECTORY }
    if (-not $Pipe) { $Pipe = $env:OMNITRIGGER_REGISTRATION_PIPE }
    if ($Mode -notin @('Configure','Status','Unregister') -or -not $InstallDirectory) { Fail 'invalid_request' '缺少注册操作或安装目录。' }
    if ($Mode -eq 'Configure') {
        if ($env:OMNITRIGGER_REGISTRATION_IDS -and -not $PSBoundParameters.ContainsKey('ExtensionId')) {
            $parsedIds = $env:OMNITRIGGER_REGISTRATION_IDS | ConvertFrom-Json
            $ExtensionId = @()
            if ($null -ne $parsedIds) { foreach ($parsedId in $parsedIds) { $ExtensionId += [string]$parsedId } }
        }
        if ($ExtensionId.Count -gt 32) { Fail 'invalid_extension_id' '扩展 ID 数量不能超过 32。' }
        foreach ($id in $ExtensionId) { if ($id -cnotmatch '^[a-p]{32}$') { Fail 'invalid_extension_id' '扩展 ID 必须为 32 位小写 a 到 p 字符。' } }
        $ExtensionId = @($ExtensionId | Select-Object -Unique)
    }
    $installRoot = [IO.Path]::GetFullPath($InstallDirectory)
    Assert-OrdinaryPath $installRoot
    $configPath = Join-Path $installRoot 'connection.json'
    $manifestPath = Join-Path $installRoot 'com.omnitrigger.browser.json'
    $hostPath = Join-Path $installRoot 'omnitrigger-browser-host.exe'
    $cliPath = Join-Path $installRoot 'omnitrigger-browser.exe'
    $registryPath = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.omnitrigger.browser'
    if ($RegistryPathForTesting) {
        if ($RegistryPathForTesting -notmatch '^HKCU:\\Software\\OmniTriggerBrowser\\RegistrationTests\\[a-f0-9]{32}$') { Fail 'invalid_request' '测试注册项必须在隔离测试命名空间内。' }
        $registryPath = $RegistryPathForTesting
    }
    $registeredPath = Registered-Manifest
    $ours = $registeredPath -and [StringComparer]::OrdinalIgnoreCase.Equals($registeredPath, $manifestPath)
    if ($Mode -eq 'Configure') {
        if (-not (Test-Path -LiteralPath $hostPath -PathType Leaf) -or -not (Test-Path -LiteralPath $cliPath -PathType Leaf)) { Fail 'missing_executable' '连接器目录缺少 CLI 或 Native Host。' }
        Assert-OrdinaryPath $hostPath; Assert-OrdinaryPath $cliPath
        if (-not $Pipe -or $Pipe -notmatch '^\\\\\.\\pipe\\[A-Za-z0-9_.-]{1,200}$') { Fail 'invalid_pipe' '本机 pipe 地址无效。' }
        if ($ExtensionId.Count -and $registeredPath -and -not $ours) { Fail 'registration_conflict' "Chrome Native Host 已注册到另一安装：$registeredPath" }
        $oldConfig = $(if (Test-Path -LiteralPath $configPath) { Assert-OrdinaryPath $configPath; [IO.File]::ReadAllText($configPath, $utf8) } else { $null })
        $oldManifest = $(if (Test-Path -LiteralPath $manifestPath) { Assert-OrdinaryPath $manifestPath; [IO.File]::ReadAllText($manifestPath, $utf8) } else { $null })
        try {
            Atomic-Text $configPath ([ordered]@{ pipe = $Pipe; extension_ids = @($ExtensionId) } | ConvertTo-Json -Depth 5)
            if ($ExtensionId.Count) {
                Atomic-Text $manifestPath ([ordered]@{
                    name = 'com.omnitrigger.browser'; description = 'OmniTrigger Browser Native Messaging Host'; path = $hostPath; type = 'stdio'
                    allowed_origins = @($ExtensionId | ForEach-Object { "chrome-extension://$_/" })
                } | ConvertTo-Json -Depth 5)
                $null = New-Item -Path $registryPath -Force
                Set-Item -LiteralPath $registryPath -Value $manifestPath
            } elseif ($ours) {
                Remove-Item -LiteralPath $registryPath
                if (Test-Path -LiteralPath $manifestPath) { Remove-Item -LiteralPath $manifestPath }
            }
        } catch {
            $failure = $_
            if ($null -ne $oldConfig) { Atomic-Text $configPath $oldConfig }
            elseif (Test-Path -LiteralPath $configPath) { Remove-Item -LiteralPath $configPath }
            if ($null -ne $oldManifest) { Atomic-Text $manifestPath $oldManifest }
            elseif (Test-Path -LiteralPath $manifestPath) { Remove-Item -LiteralPath $manifestPath }
            throw $failure
        }
    } elseif ($Mode -eq 'Unregister') {
        if ($registeredPath -and -not $ours) { Fail 'registration_conflict' "Chrome Native Host 属于另一安装，未删除：$registeredPath" }
        if ($ours) { Remove-Item -LiteralPath $registryPath }
        if (Test-Path -LiteralPath $manifestPath) { Assert-OrdinaryPath $manifestPath; Remove-Item -LiteralPath $manifestPath }
    }
    [ordered]@{ ok = $true; state = (Get-State) } | ConvertTo-Json -Compress -Depth 12
    exit 0
} catch {
    [ordered]@{ ok = $false; error = [ordered]@{ code = $errorCode; message = $_.Exception.Message } } | ConvertTo-Json -Compress -Depth 5
    exit 1
}
