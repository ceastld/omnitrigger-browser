# OmniTrigger Browser

本地调用 Chrome API 的 Windows 开发原型。扩展执行真实 `chrome.*`，本地通过持久连接取得原始结果；首先打通书签读取，不依赖 OmniTrigger 动作 UI。

```javascript
import { connect } from './sdk-js/index.mjs';

const browser = await connect(); // 仅一个连接时自动选择；多 profile 时显式指定 profile ID。
try {
  const tree = await browser.chrome.bookmarks.getTree();
  const matches = await browser.chrome.bookmarks.search({ query: 'Rust' });
  console.log(tree.length, matches.length);
} finally {
  browser.close();
}
```

## 当前实现

- MV3 扩展、Native Messaging Host、Windows Named Pipe 桥接服务。
- 通用 `method + args` 调用和 JavaScript `chrome.*` Proxy；Rust 客户端与通用 CLI。
- 请求关联、多 profile 路由、结构化 Chrome 错误、有界并发、断线和超时处理。
- 256 KiB 单帧、最多 32 MiB 完整结果、逐块 ACK 背压，可传输大书签树。
- `bookmarks.*` Promise 方法及其他已验证的 Promise / 同步 API；实际支持目录见 [`extension/api-modes.mjs`](extension/api-modes.mjs)，运行时 `profiles` 返回可用方法。

目前没有事件订阅、callback-only 适配、对象句柄转发或 Chrome Web Store 上架。未适配的方法明确报错，不通过重复调用猜测返回模式。桥接不会绕过 Chrome 的权限、上下文或用户手势要求。

## 下载与插件安装

从 [GitHub Releases](https://github.com/ceastld/omnitrigger-browser/releases) 取得独立 Chrome 扩展 ZIP、Windows 连接器 ZIP、`release-manifest.json` 和校验和。连接器包含两个 EXE、SDK、注册脚本和许可，无需 Rust 或 Node 即可安装运行。

在 OmniTrigger 的动作库找到“浏览器连接器”，点击“安装”即可。程序自动完成下载、本机配置和启动；成功后显示“已安装”，无需填写路径或扩展 ID。连接器按需下载，不随主程序默认打包。

浏览器扩展仍在 Chrome 侧安装；公开发布包具有固定身份，不随解压目录改变。应用层和开发脚本通过同一 RPC 客户端使用这些能力，接口见 [SDK 说明](sdk-js/README.md)。

完整解压连接器 ZIP 后，也可运行 `installer/install.ps1` 独立安装；不填 ID 可先安装文件，之后通过 CLI 的 `register --extension-id` 注册。这一步不构建源码、不自动启动服务，已有其他安装时明确报冲突。CI、发行资产和本地打包命令见[发布说明](docs/RELEASING.md)。

## 从源码运行

需要 Windows、Rust 1.90 或更新的 MSVC 工具链、PowerShell 7、Chrome 120 或更新版本；JS SDK 和测试需要 Node.js 22 或更新版本。优先在独立的 Chrome profile 试用。扩展不需要 npm 安装或编译。

1. 构建本机程序：

   ```powershell
   cargo build --locked
   ```

2. 打开 Chrome 的 `chrome://extensions`，启用开发者模式，“加载已解压的扩展程序”选择本仓的 `extension` 文件夹，记录页面显示的 32 位扩展 ID。

3. 安装当前用户的 Native Host 注册，将下例 ID 替换为实际 ID：

   ```powershell
   .\installer\install.ps1 -ExtensionId '此处替换为实际扩展ID'
   ```

   脚本构建并复制程序到 `%LOCALAPPDATA%\OmniTriggerBrowser`，写入自身 HKCU 注册项与 `connection.json`。不要求管理员权限；更新时先关闭旧桥接服务和扩展连接。`-SkipBuild` 仅使用本仓 `target\debug` 已构建产物。

4. 保持桥接服务运行，再重新加载扩展或在扩展弹窗启用连接：

   ```powershell
   & "$env:LOCALAPPDATA\OmniTriggerBrowser\omnitrigger-browser.exe" serve
   ```

5. 在另一个终端调用：

   ```powershell
   .\target\debug\omnitrigger-browser.exe profiles
   .\target\debug\omnitrigger-browser.exe call bookmarks.getTree '[]'
   .\target\debug\omnitrigger-browser.exe call bookmarks.search '[{"query":"Rust"}]'
   ```

完整结果以 JSON 输出到 stdout，诊断和错误走 stderr；可通过 PowerShell 保存结果文件。多个 profile 同时连接时，使用 `--profile <browser_instance_id>`；省略时返回目标不明确，不猜测。`--pipe` 用于显式选择测试或开发服务，`--timeout-ms` 默认 10000，最高 60000。

JS SDK 也支持 `connect({ profile, pipe, configPath, timeoutMs })`，详见 [SDK 说明](sdk-js/README.md)。Rust 可通过本 crate 的 `client::BrowserClient` 连接；当前 Rust 客户端每个连接顺序调用，JS 客户端支持并发。

## 运行边界

本机服务默认按当前用户 SID 命名 pipe，DACL 限制为当前用户与 SYSTEM，并拒绝远程客户端。它是同一用户信任范围内的开发工具，不是本机代码沙盒；尚未隔离同一用户的多个 Windows 登录会话。Native Host 校验调用扩展 ID，安装器不覆盖其他位置的同名 host 注册。

桥接服务退出后需要重新启动；扩展会退避重连。每次重新连接产生新会话，正在等待的调用失败，不自动重放。已进入 Chrome 的操作不能由本地超时或取消回滚，断线后的修改结果可能未知。

读取书签需要 `bookmarks` 权限，首版扩展同时声明 `nativeMessaging`、`storage` 和 `alarms`；不注入网页，不需要所有站点访问权。示例中的 API 是真实调用，修改类 API 会实际改变所选 profile 数据。

卸载前关闭服务并停用扩展连接，再执行：

```powershell
.\installer\uninstall.ps1
```

卸载器只删除自身注册与指定安装文件，不删除 Chrome profile 或书签。

## 验证

```powershell
cargo fmt --check
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
node --test extension/tests/*.test.mjs tests/*.test.mjs
```

`tests/bridge.integration.test.mjs` 启动真实 Rust bridge 并模拟扩展对端；先运行 `cargo build --locked`，缺少 EXE 时该组会跳过。`tests/extension-sdk.integration.test.mjs` 验证实际扩展 dispatcher 与实际 SDK 的协议交互。两者均不等同真实 Chrome 验证。

本地已在隔离 Chrome 155.0.8059.86 完成真实验证：两条合成书签的整树读取、搜索、子目录、同步与 Promise API、6 个并发请求、760072 字节 Unicode 结果、Chrome 错误及 CLI 读取。同一路径重新加载开发扩展后，新 Native 会话可继续读取。实验 CDP 安装下调用 `runtime.reload()` 会使该测试安装变为 disabled，因此没有将这一条件写成自动恢复已通过；需要显式重新加载开发扩展。

协议、限制与已实现范围见 [PROTOCOL](protocol/PROTOCOL.md)。本项目自身采用 [MIT](LICENSE)，发行依赖通知见 [第三方通知](THIRD_PARTY_NOTICES.md)。发行包为 Windows x64 开发预览版，Chrome Web Store 自动上传尚未配置。
