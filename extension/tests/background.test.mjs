import test from 'node:test';
import assert from 'node:assert/strict';

class Event {
  constructor() { this.listeners = []; }
  addListener(listener) { this.listeners.push(listener); }
  emit(...args) { for (const listener of this.listeners) listener(...args); }
}

test('worker bootstrap attaches disconnect listeners before storage writes and can stop/reconnect', async () => {
  const stored = {};
  const ports = [];
  const observations = [];
  const runtime = { id: 'extension-test', onInstalled: new Event(), onStartup: new Event(), onMessage: new Event(),
    connectNative(host) {
      assert.equal(host, 'com.omnitrigger.browser');
      const port = { onMessage: new Event(), onDisconnect: new Event(), messages: [],
        postMessage(message) {
          this.messages.push(message);
          if (message.type === 'hello') queueMicrotask(() => this.onMessage.emit({ v: 1, type: 'hello', ok: true }));
        },
        disconnect() { this.disconnected = true; this.onDisconnect.emit(); },
      };
      ports.push(port);
      return port;
    },
  };
  globalThis.chrome = {
    runtime, bookmarks: { getTree: async () => [] },
    storage: {
      local: { async get(defaults) { return { ...defaults, ...stored }; }, async set(values) { Object.assign(stored, values); } },
      session: { async set(value) {
        const current = ports.at(-1);
        if (value.bridgeStatus.state === 'connecting') observations.push([current.onMessage.listeners.length, current.onDisconnect.listeners.length]);
      } },
    },
    alarms: { onAlarm: new Event(), create: async () => {}, clear: async () => true },
  };
  await import(`../background.mjs?test=${Date.now()}`);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ports.length, 1);
  assert.deepEqual(observations, [[1, 1]]);
  const hello = ports[0].messages[0];
  assert.equal(hello.role, 'extension');
  assert.equal(hello.browser_instance_id, stored.browserInstanceId);
  assert.ok(hello.capabilities.methods.includes('bookmarks.getTree'));
  assert.equal(hello.capabilities.methods.includes('history.search'), false);

  function settings(message) {
    return new Promise(resolve => runtime.onMessage.listeners[0](message, { id: runtime.id }, resolve));
  }
  await settings({ type: 'bridge.enable', enabled: false });
  assert.equal(stored.bridgeEnabled, false);
  assert.equal(ports[0].disconnected, true);
  await settings({ type: 'bridge.enable', enabled: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ports.length, 2);
  assert.notEqual(ports[0].messages[0].session_id, ports[1].messages[0].session_id);
  assert.equal(ports[0].messages[0].browser_instance_id, ports[1].messages[0].browser_instance_id);
  await settings({ type: 'bridge.enable', enabled: false });
  delete globalThis.chrome;
});

let attempt = 0;
async function workerWithoutHandshake(t, options = {}) {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers = new Set();
  globalThis.setTimeout = (callback, delay) => {
    const timer = { callback, delay };
    timers.add(timer);
    return timer;
  };
  globalThis.clearTimeout = timer => timers.delete(timer);
  const stored = { ...options.stored };
  const ports = [];
  const states = [];
  const alarms = [];
  const runtime = {
    id: 'lifecycle-regression', onInstalled: new Event(), onStartup: new Event(), onMessage: new Event(),
    connectNative() {
      const port = { onMessage: new Event(), onDisconnect: new Event(), messages: [],
        postMessage(message) {
          if (options.postError) throw options.postError;
          this.messages.push(message);
        },
        disconnect() { this.disconnected = true; },
      };
      ports.push(port);
      return port;
    },
  };
  globalThis.chrome = {
    runtime, bookmarks: { getTree: async () => [] },
    storage: {
      local: { get: async defaults => ({ ...defaults, ...stored }), set: async values => Object.assign(stored, values) },
      session: { set: async value => states.push(value.bridgeStatus) },
    },
    alarms: { onAlarm: new Event(), create: async (name, details) => alarms.push([name, details]), clear: async () => true },
  };
  const settings = message => new Promise(resolve => runtime.onMessage.listeners[0](message, { id: runtime.id }, resolve));
  t.after(async () => {
    try { if (runtime.onMessage.listeners.length) await settings({ type: 'bridge.enable', enabled: false }); }
    finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
      delete globalThis.chrome;
    }
  });
  const flush = () => new Promise(resolve => setImmediate(resolve));
  await import(`../background.mjs?lifecycle-regression=${++attempt}`);
  await flush();
  return { ports, states, alarms, runtime, flush, timers,
    async fire(delay) {
      const timer = [...timers].find(timer => timer.delay === delay);
      assert.ok(timer, `Expected a ${delay} ms timer`);
      timers.delete(timer);
      timer.callback();
      await flush();
    },
  };
}

test('handshake timeout retries even though local disconnect has no onDisconnect event', async t => {
  const h = await workerWithoutHandshake(t);
  const first = h.ports[0];
  await h.fire(10000);
  assert.equal(first.disconnected, true);
  assert.equal(h.states.at(-1).state, 'disconnected');
  assert.match(h.states.at(-1).message, /握手超时/);
  assert.equal(h.alarms.at(-1)[0], 'omnitrigger-browser-reconnect');
  await h.fire(1000);
  assert.equal(h.ports.length, 2);
  const second = h.ports[1];
  assert.notEqual(second.messages[0].session_id, first.messages[0].session_id);
  assert.equal(second.messages[0].browser_instance_id, first.messages[0].browser_instance_id);
  second.onMessage.emit({ v: 1, type: 'hello', ok: true });
  await h.flush();
  assert.equal(h.states.at(-1).state, 'connected');
  first.onDisconnect.emit(); // A stale remote event cannot close the newer session.
  await h.flush();
  assert.equal(h.states.at(-1).state, 'connected');
  assert.equal(second.disconnected, undefined);
});

test('rejected hello cleans the locally closed port and permits a fresh attempt', async t => {
  const h = await workerWithoutHandshake(t);
  h.ports[0].onMessage.emit({ v: 1, type: 'hello', ok: false, error: { message: '测试拒绝连接' } });
  await h.flush();
  assert.equal(h.ports[0].disconnected, true);
  assert.equal(h.states.at(-1).state, 'error');
  assert.equal(h.states.at(-1).message, '测试拒绝连接');
  await h.fire(1000);
  assert.equal(h.ports.length, 2);
});

test('remote disconnect still clears the port and schedules a retry once', async t => {
  const h = await workerWithoutHandshake(t);
  h.runtime.lastError = { message: '测试远端断线' };
  h.ports[0].onDisconnect.emit();
  delete h.runtime.lastError;
  await h.flush();
  assert.equal(h.states.at(-1).message, '测试远端断线');
  assert.equal(h.alarms.length, 1);
  await h.fire(1000);
  assert.equal(h.ports.length, 2);
});

test('a synchronous hello send failure closes the native port and cancels its handshake timer', async t => {
  const h = await workerWithoutHandshake(t, { postError: new Error('测试握手发送失败') });
  assert.equal(h.ports.length, 1);
  assert.equal(h.ports[0].disconnected, true);
  assert.equal(h.states.at(-1).message, '测试握手发送失败');
  assert.equal([...h.timers].some(timer => timer.delay === 10000), false);
  assert.equal(h.alarms.length, 1);
});
