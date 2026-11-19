// 只验证后台连接状态；真实Chrome本端Port.disconnect不回调同端onDisconnect。
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../extension/background.mjs', import.meta.url), 'utf8');
class Event { listeners = []; addListener(fn) { this.listeners.push(fn); } emit(...args) { for (const fn of this.listeners) fn(...args); } }
async function fixture() {
  const timers = new Map(), states = [], ports = [], alarms = [], sessions = [];
  let now = 0, counter = 0, sequence = 0;
  class RpcSession {
    constructor() { this.closes = 0; sessions.push(this); }
    close() { this.closes++; }
    async handle() { assert.fail('握手状态测试不得派发业务'); }
  }
  const runtime = { id: 'amgcemaohhmiopijabpaooapbkfokkjb', onStartup: new Event(), onInstalled: new Event(), onMessage: new Event(),
    connectNative(host) {
      assert.equal(host, 'com.omnitrigger.browser');
      const port = { onMessage: new Event(), onDisconnect: new Event(), messages: [], disconnected: false,
        postMessage(message) { this.messages.push(structuredClone(message)); },
        disconnect() { this.disconnected = true; this.localDisconnects = (this.localDisconnects ?? 0) + 1; },
      }; ports.push(port); return port;
    },
  };
  const chrome = { runtime,
    storage: { local: { get: async defaults => ({ ...defaults, browserInstanceId: 'owned-profile' }), set: async () => {} },
      session: { set: async value => states.push(structuredClone(value.bridgeStatus)) } },
    alarms: { onAlarm: new Event(), create: async (name, details) => alarms.push({ name, delayInMinutes: details.delayInMinutes }), clear: async () => true } };
  const context = vm.createContext({ chrome, API_MODES: {}, RpcSession, resolveChromeMethod() { assert.fail('没有业务方法'); },
    crypto: { randomUUID: () => `session-${++sequence}` }, Date: class extends Date { static now() { return now; } }, console,
    setTimeout(callback, ms) { const id = ++counter; timers.set(id, { callback, ms, due: now + ms }); return id; }, clearTimeout(id) { timers.delete(id); },
  });
  vm.runInContext(source.replace(/^import .*;\r?\n/gmu, '') + '\nglobalThis.inspect=()=>({nativePort:!!nativePort,rpc:!!rpc,connecting:!!connecting,status});', context);
  const flush = async () => { for (let n = 0; n < 30; n++) await Promise.resolve(); }; await flush();
  return { states, ports, alarms, sessions, timers, inspect: () => context.inspect(),
    async fire(ms) { const entry = [...timers].find(([, value]) => value.ms === ms); assert.ok(entry, `缺少${ms}ms计时器`); timers.delete(entry[0]); now = entry[1].due; entry[1].callback(); await flush(); },
    async hello(index = ports.length - 1) { ports[index].onMessage.emit({ v: 1, type: 'hello', ok: true }); await flush(); },
    async remote(index = ports.length - 1) { ports[index].onDisconnect.emit(); await flush(); },
  };
}
test('握手超时主动清理本端状态，沿原1000ms和alarm退避重连', async () => {
  const h = await fixture(); assert.equal(h.ports[0].messages[0].type, 'hello'); await h.fire(10000);
  assert.equal(h.ports[0].localDisconnects, 1); assert.equal(h.inspect().nativePort, false);
  assert.equal(h.inspect().rpc, false); assert.equal(h.inspect().status.state, 'disconnected');
  assert.equal(h.sessions[0].closes, 1); assert.equal(h.alarms.length, 1); assert.equal(h.alarms[0].delayInMinutes, 0.5);
  await h.fire(1000); assert.equal(h.ports.length, 2);
});
test('超时后新连接成功，旧端口迟到hello或disconnect不污染新session', async () => {
  const h = await fixture(); await h.fire(10000); await h.fire(1000); await h.hello();
  assert.equal(h.inspect().status.state, 'connected'); const session = h.inspect().status.session_id;
  await h.hello(0); await h.remote(0);
  assert.equal(h.inspect().status.state, 'connected'); assert.equal(h.inspect().status.session_id, session);
  assert.equal(h.ports[1].disconnected, false); assert.equal(h.sessions[0].closes, 1); assert.equal(h.alarms.length, 1);
});
test('及时hello保持成功契约且取消握手计时器，不关闭或安排重连', async () => {
  const h = await fixture(); await h.hello(); assert.equal(h.inspect().status.state, 'connected');
  assert.equal(h.ports[0].disconnected, false); assert.equal(h.alarms.length, 0); assert.equal(h.sessions[0].closes, 0);
  assert.ok(![...h.timers.values()].some(timer => timer.ms === 10000));
});
test('对端断连仍清理并退避，不调用本端重复disconnect', async () => {
  const h = await fixture(); await h.remote(); assert.equal(h.inspect().nativePort, false);
  assert.equal(h.inspect().status.state, 'disconnected'); assert.equal(h.alarms.length, 1);
  assert.equal(h.ports[0].localDisconnects, undefined); assert.equal(h.sessions[0].closes, 1);
});
