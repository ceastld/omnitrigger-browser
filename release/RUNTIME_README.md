# OmniTrigger Browser 连接器

Windows x64 开发预览版，提供本地到 Chrome 扩展的通用 API RPC。

## 从 OmniTrigger 安装

优先在 OmniTrigger 动作库的“浏览器连接器”入口安装。该入口下载并校验固定版本连接器，配置 Native Host 注册与本机连接；浏览器扩展需要在 Chrome 中另行安装。

连接器与扩展分别发布。扩展 ZIP 解压后可在 `chrome://extensions` 开发者模式中“加载已解压的扩展程序”；普通网页不能自动、静默安装 Chrome 扩展。Chrome Web Store 上架尚未配置，不把 GitHub ZIP 当成商店安装。

## 手动注册

将整个连接器 ZIP 解压到普通本地目录，保留许可和目录结构。扩展有固定公开身份，手动注册也可直接读取随包元数据，无需复制 ID：

```powershell
$id = (Get-Content -Raw .\connector.json | ConvertFrom-Json).extensionId
.\installer\install.ps1 -ExtensionId $id
& "$env:LOCALAPPDATA\OmniTriggerBrowser\omnitrigger-browser.exe" serve
```

发布包中的脚本自动识别本机程序，无需 Cargo；默认复制到 `%LOCALAPPDATA%\OmniTriggerBrowser`，也可通过 `-InstallDirectory` 指定普通本地目录。不要求管理员权限，不修改浏览器书签。若同名 Native Host 已由 OmniTrigger 或另一目录安装，脚本拒绝覆盖，应先在对应安装入口移除。也可先不填扩展 ID 安装文件，之后通过 CLI 的 `register --extension-id` 完成注册。

另开终端执行：

```powershell
.\omnitrigger-browser.exe profiles
.\omnitrigger-browser.exe call bookmarks.getTree '[]'
.\omnitrigger-browser.exe call bookmarks.search '[{"query":"Rust"}]'
```

默认 pipe 按当前用户 SID 命名。JS SDK 默认读取 `%LOCALAPPDATA%\OmniTriggerBrowser\connection.json`，自定义安装目录时可显式提供配置或 pipe。

## 移除

先停用扩展连接并关闭桥接服务，再运行 `installer\uninstall.ps1`，自定义安装目录时传入相同 `-InstallDirectory`。该脚本只移除属于此安装的注册及清单中列出的文件，不删除浏览器资料。

## 已知范围

当前支持已声明的 Promise / 同步 JSON API、并发与大结果分块。事件订阅、callback-only 和对象句柄尚未实现。超时、断线及取消不能撤销已进入 Chrome 的操作，不会自动重试。API 修改类调用会真实改变所选 profile。

程序未经代码签名；只支持 Windows x64。自有内容采用 LICENSE 中的 MIT 许可，第三方完整通知见 THIRD_PARTY_NOTICES.md 与 third-party 目录。
