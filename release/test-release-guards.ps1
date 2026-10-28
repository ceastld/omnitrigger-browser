#requires -Version 7.0
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$source = [IO.File]::ReadAllText((Join-Path $root '.github/workflows/release.yml'))
$start = $source.IndexOf('          function Read-GitHubApi(')
$end = $source.IndexOf('          $manifest = ', $start)
if ($start -lt 0 -or $end -le $start) { throw '没有找到发布工作流中的保护函数。' }
$definitions = ($source.Substring($start, $end - $start) -split '\r?\n' | ForEach-Object { $_ -replace '^ {10}', '' }) -join "`n"
. ([scriptblock]::Create($definitions))
$responses = [Collections.Generic.Queue[object]]::new()
function gh {
    if ($args.Count -ne 3 -or $args[0] -ne 'api' -or $args[2] -ne '--include' -or $script:responses.Count -eq 0) { throw '测试拒绝任何真实 GitHub 操作。' }
    $response = $script:responses.Dequeue()
    $global:LASTEXITCODE = $response.ExitCode
    $response.Raw
}
function Enqueue([int]$Status, [object]$Body, [int]$ExitCode = 0) {
    $script:responses.Enqueue([pscustomobject]@{
        ExitCode = $ExitCode
        Raw = "HTTP/2.0 $Status Test`nContent-Type: application/json`n`n$($Body | ConvertTo-Json -Depth 10 -Compress)"
    })
}
function Throws([scriptblock]$Action, [string]$Expected) {
    try { & $Action } catch {
        if ($_.Exception.Message -notlike "*$Expected*") { throw "错误内容不符：$($_.Exception.Message)" }
        return
    }
    throw "未按预期拒绝：$Expected"
}
$saved = @{}
foreach ($name in @('EXPECTED_COMMIT', 'RELEASE_TAG', 'GH_REPO')) { $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
try {
    Enqueue 200 @{ value = 'normal' }
    if ((Read-GitHubApi 'test/normal').Body.value -ne 'normal') { throw 'HTTP 200 正文解析失败。' }
    Enqueue 404 @{ message = 'Not found' } 1
    if ((Read-GitHubApi 'test/missing').Status -ne 404) { throw '没有识别明确的 404。' }
    Enqueue 401 @{ message = 'Bad credentials' } 1
    Throws { Read-GitHubApi 'test/unauthorized' } 'HTTP 401'
    Enqueue 403 @{ message = 'Forbidden' } 1
    Throws { Read-GitHubApi 'test/forbidden' } 'HTTP 403'
    $responses.Enqueue([pscustomobject]@{ ExitCode = 1; Raw = 'connection reset' })
    Throws { Read-GitHubApi 'test/network' } 'HTTP 状态'

    $env:EXPECTED_COMMIT = 'a' * 40
    $env:RELEASE_TAG = 'v0.1.0'
    $env:GH_REPO = 'example/fixture'
    Enqueue 200 @{ object = @{ type = 'commit'; sha = $env:EXPECTED_COMMIT } }
    Assert-TagCommit
    Enqueue 200 @{ object = @{ type = 'tag'; sha = ('b' * 40) } }
    Enqueue 200 @{ object = @{ type = 'commit'; sha = $env:EXPECTED_COMMIT } }
    Assert-TagCommit
    Enqueue 200 @{ object = @{ type = 'commit'; sha = ('c' * 40) } }
    Throws { Assert-TagCommit } '标签已移动'
    Enqueue 404 @{ message = 'Not found' } 1
    Throws { Assert-TagCommit } '标签已不存在'
    Enqueue 404 @{ message = 'Not found' } 1
    Enqueue 200 @()
    Assert-NoRelease
    Enqueue 200 @{ tag_name = 'v0.1.0' }
    Throws { Assert-NoRelease } 'Release 已存在'
    Enqueue 404 @{ message = 'Not found' } 1
    Enqueue 200 @(@{ tag_name = 'v0.1.0'; draft = $true })
    Throws { Assert-NoRelease } '草稿已存在'
    Enqueue 404 @{ message = 'Not found' } 1
    Enqueue 403 @{ message = 'Forbidden' } 1
    Throws { Assert-NoRelease } 'HTTP 403'
    if ($responses.Count) { throw '保护测试没有消费全部模拟响应。' }
    Write-Output '发布保护测试通过：200/404、认证/权限/网络错误、轻量/注释标签、标签移动及删除、已发布/草稿查重。'
} finally {
    foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') }
}
