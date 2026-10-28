#requires -Version 5.1
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$fixture = Join-Path $repoRoot ('.local\registration-test-' + [Guid]::NewGuid().ToString('N'))
$registry = 'HKCU:\Software\OmniTriggerBrowser\RegistrationTests\' + [Guid]::NewGuid().ToString('N')
$script = Join-Path $repoRoot 'installer\register-native-host.ps1'
$null = New-Item -ItemType Directory -Path $fixture -Force
[IO.File]::WriteAllText((Join-Path $fixture 'omnitrigger-browser.exe'), 'test fixture, not executable')
[IO.File]::WriteAllText((Join-Path $fixture 'omnitrigger-browser-host.exe'), 'test fixture, not executable')
$pipe = '\\.\pipe\omnitrigger-registration-fixture'
$id1 = 'a' * 32
$id2 = 'p' * 32
function Assert([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Run([string]$Mode, [string[]]$Ids = @(), [string]$PipeValue = $pipe) {
    $resultText = & $script -Mode $Mode -InstallDirectory $fixture -ExtensionId $Ids -Pipe $PipeValue -RegistryPathForTesting $registry
    $resultText | ConvertFrom-Json
}
try {
    $state = Run Configure
    Assert $state.ok '空 ID 准备配置失败'
    Assert (-not $state.state.registered) '空 ID 不应注册 host'
    Assert (-not (Test-Path -LiteralPath $registry)) '空 ID 创建了注册项'
    Assert ($state.state.extension_ids.Count -eq 0) '空 ID 没有保留为空数组'

    $state = Run Configure @($id1, $id2, $id1)
    Assert $state.ok ('两个扩展 ID 注册失败：' + ($state | ConvertTo-Json -Compress -Depth 8))
    Assert $state.state.registered 'host 未注册'
    Assert ($state.state.extension_ids.Count -eq 2) '扩展 ID 未去重'
    $manifest = Get-Content -LiteralPath $state.state.manifest_path -Raw | ConvertFrom-Json
    Assert ($manifest.allowed_origins.Count -eq 2) '清单 allowed_origins 不匹配'
    Assert ($manifest.path -eq (Join-Path $fixture 'omnitrigger-browser-host.exe')) '清单没有指向邻接 host'
    Assert ((Run Status).state.registered) '状态查询失败'

    $configBefore = [IO.File]::ReadAllText($state.state.config_path)
    $foreign = Join-Path $fixture 'foreign-install\host.json'
    Set-Item -LiteralPath $registry -Value $foreign
    $conflict = Run Configure @($id1)
    Assert (-not $conflict.ok -and $conflict.error.code -eq 'registration_conflict') '没有拒绝另一安装的注册项'
    Assert ((Get-Item -LiteralPath $registry).GetValue('') -eq $foreign) '覆盖了另一安装的注册项'
    Assert ([IO.File]::ReadAllText($state.state.config_path) -eq $configBefore) '注册冲突修改了配置'
    $conflict = Run Unregister
    Assert (-not $conflict.ok -and $conflict.error.code -eq 'registration_conflict') '卸载没有保护另一注册项'
    Assert ((Get-Item -LiteralPath $registry).GetValue('') -eq $foreign) '删除了另一安装的注册项'

    $prepare = Run Configure
    Assert $prepare.ok '另一安装存在时应仍可准备未注册配置'
    Assert (-not $prepare.state.registered -and $prepare.state.conflict -eq $foreign) '未保留另一安装状态'
    $invalid = Run Configure @('invalid')
    Assert (-not $invalid.ok -and $invalid.error.code -eq 'invalid_extension_id') '没有拒绝无效 ID'
    $invalid = Run Configure @($id1) 'invalid-pipe'
    Assert (-not $invalid.ok -and $invalid.error.code -eq 'invalid_pipe') '没有拒绝无效 pipe'

    Set-Item -LiteralPath $registry -Value $state.state.manifest_path
    $state = Run Configure @($id1)
    Assert $state.ok '重新配置自身注册失败'
    $state = Run Unregister
    Assert $state.ok '移除自身注册失败'
    Assert (-not (Test-Path -LiteralPath $registry)) '自身注册项未删除'
    Assert (-not (Test-Path -LiteralPath $state.state.manifest_path)) '自身清单未删除'
    Assert (Test-Path -LiteralPath $state.state.config_path) '取消注册不应删除连接配置'
    Write-Output '注册测试通过：空 ID、多个 ID、去重、邻接配置、冲突保护、无效输入及自身取消注册。'
} finally {
    if (Test-Path -LiteralPath $registry) { Remove-Item -LiteralPath $registry }
    # 仅清理本次创建的明确普通文件；不递归删除目录。
    foreach ($name in @('omnitrigger-browser.exe','omnitrigger-browser-host.exe','connection.json','com.omnitrigger.browser.json')) {
        $path = Join-Path $fixture $name
        if (Test-Path -LiteralPath $path -PathType Leaf) { Remove-Item -LiteralPath $path }
    }
    if (-not @(Get-ChildItem -LiteralPath $fixture -Force).Count) { Remove-Item -LiteralPath $fixture }
}
