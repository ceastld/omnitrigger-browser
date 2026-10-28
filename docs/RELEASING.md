# 扩展与连接器发布

扩展和 Windows 本机连接器分别打包，由同一版本标签发布到 GitHub Releases。OmniTrigger 按插件安装连接器，不需要把本机桥接程序编进主程序。Chrome 扩展由浏览器单独安装；本流程生成可解压加载及后续商店上传的 ZIP，没有配置 Chrome Web Store 自动上传。

## 检查和产物

`.github/workflows/ci.yml` 在分支推送与 PR 上运行 Windows 检查，发布流程也复用它：

- Rust 1.90.0 的格式、测试、Clippy 和真实桥接服务构建。
- Node.js 22 的扩展、SDK 与跨进程 bridge 测试；缺少真实 EXE 或测试出现 skipped 项会失败。
- 锁定的 Windows 正常/构建依赖许可核验与扩展打包检查。

`.github/workflows/release.yml` 的手动运行只生成 Actions artifact，不创建 Release。推送 `v<版本>` 标签会在检查后构建 Release 程序，上传四份发行资产：

| 文件 | 内容 |
| --- | --- |
| `OmniTrigger-Browser-Extension-<版本>.zip` | ZIP 根包含扩展 manifest 和运行资源；不含测试、SDK、Native Host 或本机配置。 |
| `OmniTrigger-Browser-Connector-<版本>-windows-x86_64.zip` | 两个 Windows EXE、SDK、无需 Cargo 的安装注册脚本、连接器元数据与完整许可。 |
| `release-manifest.json` | schema/协议/版本、固定版本下载 URL、大小与 SHA-256。 |
| `SHA256SUMS.txt` | 两个 ZIP 与发行清单的 SHA-256。 |

发布作业先创建预发布草稿，上传后再下载资产并校验字节，全部一致才公开为预览版，不设为 Latest。同一版本已有 Release（含草稿）时拒绝覆盖；只有明确 HTTP 404 才按不存在处理，认证、权限与网络错误均停止。创建草稿和公开前分别通过 GitHub REST 解析轻量或带注释标签，确认其最终提交仍与打包作业的真实 HEAD 一致，避免构建途中移动标签后错发资产。

检查和打包只需 `contents: read`；只有标签发布作业有 `contents: write`。第三方 Actions 固定到已核对的提交 SHA。

## 本地打包

需要 PowerShell 7、Node.js 22、Windows x64 MSVC Rust 工具链和锁定依赖，运行：

```powershell
.\scripts\package-extension.ps1
.\scripts\package-windows.ps1 -Repository ceastld/omnitrigger-browser
```

Windows 脚本通过 Cargo 本次构建回执定位 EXE，不假定 `target` 目录位置。程序使用独立 Release 配置缩小体积；每个 ZIP 在写入后核验条目与解压后字节哈希。包内第三方文件严格取自锁文件对应的 `third-party/index.json`，不把旧目录额外文件带入发行包。发布流程还会解包连接器，用仅含系统目录的 PATH 验证无需 Cargo/Node 的安装、SDK/许可完整性及未提供扩展 ID 时不抢占注册。

产物默认位于 `dist`。脚本输出两个 ZIP 的精确字节数和两个 EXE 的未压缩大小，可用这组实际数值决定主程序是否需要内置；按需插件安装不受该决定影响。不会分发 PDB、测试数据、开发 profile、密钥或真实浏览记录。

## 插件下载契约

清单遵循 `release/release-manifest.schema.json`，固定地址示例为：

```text
https://github.com/ceastld/omnitrigger-browser/releases/download/v0.1.0/release-manifest.json
```

`artifacts.connector` 与 `artifacts.extension` 分别提供 `fileName`、`url`、`sizeBytes` 和小写 `sha256`；连接器另有 `target: x86_64-pc-windows-msvc`。顶层 `extensionId` 来自已校验的固定公开身份，供 OmniTrigger 一键安装时自动注册，无需用户输入 ID。下载方先核对清单的版本、协议和仓库，再校验 ZIP 的完整大小与哈希，不能把 latest 或变动 URL 当作固定版本。schema 主版本未知时拒绝安装。

连接器 ZIP 根的 `connector.json` 提供 `schemaVersion`、`protocolVersion`、`version`、`extensionId`、`target`、`hostName` 及固定相对 `entrypoints`。`entrypoints.cli` 为 `omnitrigger-browser.exe`，`entrypoints.nativeHost` 为 `omnitrigger-browser-host.exe`。ZIP 路径均为相对路径，无外层版本目录。OmniTrigger 可自行注册经过校验的程序，无需执行下载包中的安装脚本。

扩展 `manifest.json` 内固定公开 `key`，其派生 ID 在 `extension/identity.json` 中记录；不同解压路径仍使用同一扩展 ID。打包前运行 `scripts/extension-identity.mjs` 验证公开 key、ID 和哈希，随后自动写入两个发行清单；CI 测试覆盖派生算法与身份不匹配。公开 key 不含私钥。改变它会改变扩展身份，不能作为普通更新随意替换。

私有仓库的 Release 不提供匿名下载；若连接器面向普通 OmniTrigger 用户，发行资产必须对目标用户可访问。访问令牌不嵌入程序或清单。公开范围、提交、推送和标签创建仍由维护者授权后执行。

## 创建正式版本

1. 同步 `Cargo.toml`、`Cargo.lock`、扩展 `manifest.json` 和 SDK 包版本，保持三段数字版本一致。
2. 运行检查与本地打包，核对真实 API、安装/卸载、许可、产物体积和最终差异。源码与历史不得包含本机 `.local`、凭据或构建产物。
3. 检查、审核并推送要发布的提交，再创建与包版本完全相同的 `v<版本>` 标签。错误版本不移动或重用已公开标签。
4. 确认 Actions 成功、Release 为预览版、四份资产大小/哈希正确、插件下载入口对目标用户可访问。

Chrome Web Store 后续可在独立上传流程配置扩展 ID 和商店授权凭据；当前既不保存这些凭据，也不声称 GitHub ZIP 已通过商店审核。
