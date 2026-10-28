#requires -Version 5.1
[CmdletBinding()]
param([string]$BinaryPath)
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
if (-not $BinaryPath) { $BinaryPath = Join-Path $repoRoot 'target\debug\omnitrigger-browser.exe' }
$BinaryPath = [IO.Path]::GetFullPath($BinaryPath)
$fixture = Join-Path $repoRoot ('.local\registration cli test ' + [Guid]::NewGuid().ToString('N'))
$registry = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.omnitrigger.browser'
$registeredBefore = $(if (Test-Path -LiteralPath $registry) { [string](Get-Item -LiteralPath $registry).GetValue('') } else { $null })
$pipe = '\\.\pipe\omnitrigger-registration-cli-fixture'
$null = New-Item -ItemType Directory -Path $fixture -Force
[IO.File]::WriteAllText((Join-Path $fixture 'omnitrigger-browser.exe'), 'test fixture, not executable')
[IO.File]::WriteAllText((Join-Path $fixture 'omnitrigger-browser-host.exe'), 'test fixture, not executable')
function Assert([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Invoke-ConnectorCli([string[]]$Arguments) {
    $process = New-Object Diagnostics.Process
    $process.StartInfo.FileName = $BinaryPath
    $process.StartInfo.Arguments = (@($Arguments | ForEach-Object { '"' + $_.Replace('"','\"') + '"' }) -join ' ')
    $process.StartInfo.UseShellExecute = $false
    $process.StartInfo.CreateNoWindow = $true
    $process.StartInfo.RedirectStandardOutput = $true
    $process.StartInfo.RedirectStandardError = $true
    $process.StartInfo.StandardOutputEncoding = New-Object Text.UTF8Encoding($false)
    $process.StartInfo.StandardErrorEncoding = New-Object Text.UTF8Encoding($false)
    $null = $process.Start()
    $output = $process.StandardOutput.ReadToEndAsync()
    $errorOutput = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit(60000)) { $process.Kill(); throw '注册 CLI 测试超时。' }
    $stdout = $output.GetAwaiter().GetResult()
    $stderr = $errorOutput.GetAwaiter().GetResult()
    $code = $process.ExitCode
    $process.Dispose()
    [PSCustomObject]@{ code = $code; value = $(if ($code -eq 0) { $stdout | ConvertFrom-Json } else { $stderr | ConvertFrom-Json }) }
}
try {
    $empty = Join-Path $fixture 'not-created'
    $result = Invoke-ConnectorCli @('registration-status','--install-dir',$empty)
    Assert ($result.code -eq 0 -and -not $result.value.installed -and -not $result.value.registered) '新目录真 CLI status 失败。'
    Assert ($result.value.extension_ids.Count -eq 0) '新目录真 CLI status 没有保留空数组。'

    $result = Invoke-ConnectorCli @('configure','--install-dir',$fixture,'--pipe',$pipe)
    Assert ($result.code -eq 0 -and $result.value.installed -and -not $result.value.registered) '空 ID 真 CLI configure 失败。'
    Assert ($result.value.extension_ids.Count -eq 0 -and $result.value.pipe -eq $pipe) '空 ID/独立 pipe 配置不匹配。'
    $configPath = Join-Path $fixture 'connection.json'
    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    Assert (@($config.extension_ids).Count -eq 0 -and $config.pipe -eq $pipe) '邻接连接配置未写入正确内容。'
    $result = Invoke-ConnectorCli @('registration-status','--install-dir',$fixture)
    Assert ($result.code -eq 0 -and $result.value.extension_ids.Count -eq 0) '已准备空 ID 配置的真 CLI status 失败。'

    $before = [IO.File]::ReadAllText($configPath)
    $result = Invoke-ConnectorCli @('register','--install-dir',$fixture,'--extension-id','invalid','--pipe',$pipe)
    Assert ($result.code -ne 0 -and $result.value.error.code -eq 'invalid_extension_id') '真 CLI 未返回结构化无效 ID 错误。'
    Assert ([IO.File]::ReadAllText($configPath) -eq $before) '无效 ID 修改了已有配置。'
    $registeredAfter = $(if (Test-Path -LiteralPath $registry) { [string](Get-Item -LiteralPath $registry).GetValue('') } else { $null })
    Assert ($registeredBefore -ceq $registeredAfter) '真 CLI 空 ID 测试修改了实际 Chrome 注册。'
    Write-Output '真 CLI 注册测试通过：新目录 status、空 ID configure、邻接配置、独立 pipe、结构化错误及不改变现有注册。'
} finally {
    foreach ($name in @('omnitrigger-browser.exe','omnitrigger-browser-host.exe','connection.json','com.omnitrigger.browser.json')) {
        $path = Join-Path $fixture $name
        if (Test-Path -LiteralPath $path -PathType Leaf) { Remove-Item -LiteralPath $path }
    }
    if (-not @(Get-ChildItem -LiteralPath $fixture -Force).Count) { Remove-Item -LiteralPath $fixture }
}
