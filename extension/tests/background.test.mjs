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
