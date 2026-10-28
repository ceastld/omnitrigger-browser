# 第三方通知

OmniTrigger Browser 自有代码与资源采用 [MIT 许可证](LICENSE)。第三方 Rust 依赖按各自许可证使用，完整原始许可、版权声明与附带通知保存在 [third-party](third-party/)；机器可读目录为 [index.json](third-party/index.json)。

当前通知对应 `Cargo.lock` 中 `x86_64-pc-windows-msvc` 的正常及构建依赖，包括编译期宏依赖。收集两种可选许可证的完整正文，不以本项目 MIT 许可证替代第三方许可；`unicode-ident` 另外保留 Unicode 许可。清单中的版本、许可表达式、作者、上游仓库、文件名及 SHA-256 均取自本次锁定依赖及原始文件，不包含本机 Cargo 缓存路径。

## 重新收集和核验

需要 PowerShell 7 和锁定依赖可用的 Rust 工具链，在仓库根目录运行：

```powershell
.\scripts\collect-licenses.ps1
.\scripts\collect-licenses.ps1 -Check
```

脚本通过 `cargo metadata --offline --locked --filter-platform x86_64-pc-windows-msvc` 定位依赖，并仅检查各包明确目录的许可、COPYING、NOTICE、COPYRIGHT 和清单指定的 `license_file`，不会递归扫描用户目录。先构建或取得锁定依赖，收集阶段不联网。遇到云盘、链接、云端占位文件、缺少完整正文或未知许可表达式时失败，不使用下载替代或静默忽略。

变更依赖后必须重新收集并核验。分发二进制时同时附带本文件、项目 LICENSE、`third-party/index.json` 和清单引用的全部许可文件；打包应使用清单中的文件列表，避免把历史遗留文件当作当前依赖。该收集器不会删除输出目录中的额外文件。

## 外部运行环境

Node.js 和 Chrome 由用户单独安装，本项目开发原型没有打包、重新分发它们的安装包、二进制或许可资源。Native Messaging Host 与 CLI 的 Rust 依赖使用上述通知；扩展和 JS SDK 当前使用浏览器或 Node.js 内置接口，没有安装 npm 运行时依赖。

目前仅进行本地开发与验证，尚未公开发布发行包。正式发行时仍须核对实际打包产物、依赖和相应通知。
