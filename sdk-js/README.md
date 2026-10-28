# JavaScript 客户端

原生 Node.js ESM 客户端，无 npm 依赖。通过本机 IPC 把方法路径和参数发送给 Chrome 扩展；这不是浏览器环境中的 `chrome` 对象。

```javascript
import { connect } from './sdk-js/index.mjs';

const browser = await connect();
try {
  console.log(await browser.profiles());
  const tree = await browser.chrome.bookmarks.getTree();
  const matches = await browser.chrome.bookmarks.search({ query: 'Rust' });
  console.log(tree, matches);
} finally {
  browser.close();
}
```

默认读取 `%LOCALAPPDATA%\OmniTriggerBrowser\connection.json` 的 `pipe`。也可通过 `connect({ pipe, profile })`、`configPath` 或 `OMNITRIGGER_BROWSER_PIPE` 指定连接；`profile` 是 `profiles()` 返回的 `browser_instance_id`，没有指定时仅在恰好一个已连接 profile 时自动选择。

`call(method, args = [], { timeoutMs, signal, profile })` 返回 Promise；错误对象含 `code`、`method` 与 `effectState`。超时或取消仅停止等待，不撤销已经进入 Chrome 的操作，也不自动重试。超时范围为 1..60000 毫秒，默认 10000；单客户端最多 8 个并发调用。

超过单帧的结果会按协议自动重组并确认分块，业务仍取得完整 JSON。单结果上限 32 MiB，连接重组预算 64 MiB，不静默截断。`undefined` 与 `null` 保持区别。传入函数、循环引用、非 JSON 对象会明确报错；事件和 Port 等特殊类型尚未适配。

本仓测试使用模拟 IPC 和模拟扩展，不能替代真实 Chrome 验证：

```powershell
node --test tests/sdk.test.mjs
cargo build
node --test tests/bridge.integration.test.mjs
```

集成测试默认使用 `target/debug/omnitrigger-browser.exe`（Windows）；可用 `OMNITRIGGER_BROWSER_BIN` 指定本次构建的 CLI。它启动隔离 bridge，使用模拟扩展验证路由、并发、大结果、超时和断线。
