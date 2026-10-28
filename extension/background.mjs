import { API_MODES } from './api-modes.mjs';
import { RpcSession, resolveChromeMethod } from './rpc.mjs';

const HOST = 'com.omnitrigger.browser';
const RETRY_ALARM = 'omnitrigger-browser-reconnect';
let nativePort;
let rpc;
let connecting;
let retryTimer;
let failures = 0;
let generation = 0;
let status = { state: 'disconnected', message: '正在准备连接。' };

async function publish(next) {
  status = { ...next, updated_at: Date.now() };
  await chrome.storage.session.set({ bridgeStatus: status });
}

function scheduleReconnect() {
  clearTimeout(retryTimer);
  const delay = Math.min(1000 * 2 ** Math.min(failures++, 5), 30000);
  retryTimer = setTimeout(() => void connectIfEnabled(), delay);
  // The alarm survives worker suspension; timers alone do not.
  void chrome.alarms.create(RETRY_ALARM, { delayInMinutes: 0.5 });
}

async function connectIfEnabled() {
  if (nativePort || connecting) return connecting;
  const attemptGeneration = generation;
  connecting = (async () => {
    const settings = await chrome.storage.local.get({ bridgeEnabled: true, browserInstanceId: '', browserName: 'Chrome' });
    if (attemptGeneration !== generation) return;
    if (!settings.bridgeEnabled) { await publish({ state: 'disabled', message: '连接已停用。' }); return; }
    if (!settings.browserInstanceId) {
      settings.browserInstanceId = crypto.randomUUID();
      await chrome.storage.local.set({ browserInstanceId: settings.browserInstanceId });
    }
    if (attemptGeneration !== generation) return;
    const sessionId = crypto.randomUUID();
    try {
      const port = chrome.runtime.connectNative(HOST);
      nativePort = port;
      rpc = new RpcSession({ chromeApi: chrome, sessionId, browserInstanceId: settings.browserInstanceId, send: message => port.postMessage(message) });
      const session = rpc;
      const handshakeTimer = setTimeout(() => {
        if (nativePort === port) port.disconnect();
      }, 10000);
      port.onMessage.addListener(message => {
        if (port !== nativePort) return;
        if (message?.v === 1 && message.type === 'hello') {
          if (message.ok) {
            clearTimeout(handshakeTimer);
            failures = 0;
            clearTimeout(retryTimer);
            void chrome.alarms.clear(RETRY_ALARM);
            void publish({ state: 'connected', message: '已连接本机桥接服务。', browser_instance_id: settings.browserInstanceId, session_id: sessionId });
          } else {
            void publish({ state: 'error', message: message.error?.message ?? '桥接服务拒绝连接。' });
            port.disconnect();
          }
          return;
        }
        void session.handle(message).catch(error => {
          console.error('Chrome API RPC:', error.message);
          port.disconnect();
        });
      });
      port.onDisconnect.addListener(() => {
        clearTimeout(handshakeTimer);
        const message = chrome.runtime.lastError?.message ?? 'Native Host 连接已关闭。';
        session.close();
        if (nativePort !== port) return;
        nativePort = undefined;
        rpc = undefined;
        void publish({ state: 'disconnected', message });
        scheduleReconnect();
      });
      // Install listeners before an asynchronous storage write: a missing host
      // can disconnect as soon as connectNative() returns.
      void publish({ state: 'connecting', message: '正在连接本机桥接服务。', browser_instance_id: settings.browserInstanceId });
      const methods = Object.keys(API_MODES).filter(method => {
        try { resolveChromeMethod(chrome, method); return true; } catch { return false; }
      });
      port.postMessage({ v: 1, type: 'hello', role: 'extension', browser_instance_id: settings.browserInstanceId, session_id: sessionId, name: settings.browserName,
        capabilities: { methods, api_modes: API_MODES, max_frame_bytes: 262144, max_result_bytes: 33554432, events: false } });
    } catch (error) {
      nativePort = undefined;
      rpc?.close();
      rpc = undefined;
      await publish({ state: 'disconnected', message: String(error?.message ?? error) });
      scheduleReconnect();
    }
  })();
  try { await connecting; } finally { connecting = undefined; }
}

async function setEnabled(enabled) {
  generation++;
  await chrome.storage.local.set({ bridgeEnabled: enabled });
  if (!enabled) {
    const oldPort = nativePort;
    nativePort = undefined;
    rpc?.close();
    rpc = undefined;
    oldPort?.disconnect();
    clearTimeout(retryTimer);
    await chrome.alarms.clear(RETRY_ALARM);
    await publish({ state: 'disabled', message: '连接已停用。' });
  } else {
    await connecting;
    await connectIfEnabled();
  }
}

// Register wake-up listeners synchronously, before any storage read.
chrome.runtime.onInstalled.addListener(() => void connectIfEnabled());
chrome.runtime.onStartup.addListener(() => void connectIfEnabled());
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === RETRY_ALARM) void connectIfEnabled(); });
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.tab) return false;
  (async () => {
    if (message?.type === 'bridge.status') return { status, settings: await chrome.storage.local.get({ bridgeEnabled: true, browserName: 'Chrome' }) };
    if (message?.type === 'bridge.enable' && typeof message.enabled === 'boolean') { await setEnabled(message.enabled); return { status }; }
    if (message?.type === 'bridge.rename' && typeof message.name === 'string' && message.name.trim() && message.name.length <= 80) {
      generation++;
      await chrome.storage.local.set({ browserName: message.name.trim() });
      const oldPort = nativePort;
      nativePort = undefined;
      rpc?.close();
      oldPort?.disconnect();
      await connecting;
      await connectIfEnabled();
      return { status };
    }
    throw new Error('不支持的扩展设置请求。');
  })().then(respond, error => respond({ error: String(error?.message ?? error) }));
  return true;
});
void connectIfEnabled();
