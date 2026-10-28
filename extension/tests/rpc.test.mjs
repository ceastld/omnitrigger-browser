import test from 'node:test';
import assert from 'node:assert/strict';
import { RpcSession, resolveChromeMethod, serializeJson, MAX_FRAME_BYTES } from '../rpc.mjs';

const sessionId = 'session-test';
function harness(chromeApi, onSend) {
  const messages = [];
  const session = new RpcSession({ chromeApi, sessionId, browserInstanceId: 'profile-test', send(message) { messages.push(message); onSend?.(message, session); } });
  const call = (method, args = [], extra = {}) => session.handle({ v: 1, type: 'call', id: 'test:1', session_id: sessionId, method, args, ...extra });
  return { session, messages, call };
}

test('getTree and search preserve owner, argument array and original result', async () => {
  const tree = [{ id: '0', title: '', children: [{ id: '1', title: '中文', url: 'https://example.test/' }] }];
  const bookmarks = { async getTree() { assert.equal(this, bookmarks); return tree; }, async search(query) { assert.deepEqual(query, { query: 'Rust' }); return [tree[0].children[0]]; } };
  const h = harness({ bookmarks });
  await h.call('bookmarks.getTree');
  assert.deepEqual(h.messages[0].value, tree);
  await h.call('bookmarks.search', [{ query: 'Rust' }]);
  assert.equal(h.messages[1].value[0].title, '中文');
});

test('synchronous JSON and undefined are distinct from null', async () => {
  const h = harness({ runtime: { getManifest: () => ({ version: '0.1.0' }) }, bookmarks: { remove: async () => undefined, getTree: async () => null } });
  await h.call('runtime.getManifest');
  assert.equal(h.messages[0].value.version, '0.1.0');
  await h.call('bookmarks.remove', ['1']);
  assert.equal(h.messages[1].has_value, false);
  assert.equal(Object.hasOwn(h.messages[1], 'value'), false);
  await h.call('bookmarks.getTree');
  assert.equal(h.messages[2].has_value, true);
  assert.equal(h.messages[2].value, null);
});

test('Chrome errors and incompatible callback modes never repeat invocation', async () => {
  let count = 0;
  const h = harness({ bookmarks: { getTree() { count++; return undefined; }, search() { throw new Error('Permission denied'); } } });
  await h.call('bookmarks.getTree');
  assert.equal(count, 1);
  assert.equal(h.messages[0].error.code, 'unsupported_api');
  assert.equal(h.messages[0].error.effect_state, 'unknown');
  await h.call('bookmarks.search', ['x']);
  assert.equal(h.messages[1].error.code, 'chrome_error');
  assert.equal(h.messages[1].error.message, 'Permission denied');
});

test('rejects inherited methods, malformed paths and unsupported event/Port adapters before calling', async () => {
  const inherited = Object.create({ getTree: async () => [] });
  assert.throws(() => resolveChromeMethod({ bookmarks: inherited }, 'bookmarks.getTree'), { code: 'api_unavailable' });
  for (const method of ['bookmarks.__proto__.x', 'runtime.constructor', 'chrome.bookmarks.getTree', 'bookmarks[0].x']) {
    assert.throws(() => resolveChromeMethod({}, method));
  }
  let called = false;
  const h = harness({ runtime: { connect() { called = true; } } });
  await h.call('runtime.connect');
  assert.equal(h.messages[0].error.code, 'unsupported_api');
  assert.equal(called, false);
});

test('large Unicode tree is chunked, ACK-controlled and reconstructed byte-for-byte', async () => {
  const tree = [{ id: '0', title: '中文🙂'.repeat(60000), children: [] }];
  let chunkCount = 0;
  const h = harness({ bookmarks: { getTree: async () => tree } }, (message, session) => {
    assert.ok(Buffer.byteLength(JSON.stringify(message)) <= MAX_FRAME_BYTES);
    if (message.type === 'result.chunk') {
      chunkCount++;
      queueMicrotask(() => void session.handle({ v: 1, type: 'result.ack', id: message.id, index: message.index }));
    }
  });
  await h.call('bookmarks.getTree');
  assert.ok(chunkCount > 2);
  assert.equal(h.messages[0].type, 'result.begin');
  assert.equal(h.messages.at(-1).type, 'result.end');
  const bytes = Buffer.concat(h.messages.filter(m => m.type === 'result.chunk').map(m => Buffer.from(m.data, 'base64')));
  assert.equal(bytes.length, h.messages[0].total_bytes);
  assert.deepEqual(JSON.parse(bytes.toString('utf8')), tree);
});

test('missing ACK times out after one chunk and cancellation stops transfer', async () => {
  const tree = [{ title: 'x'.repeat(500000) }];
  const h = harness({ bookmarks: { getTree: async () => tree } });
  await h.call('bookmarks.getTree', [], { timeout_ms: 20 });
  assert.equal(h.messages.filter(m => m.type === 'result.chunk').length, 1);
  assert.equal(h.messages.at(-1).error.code, 'timeout');
  assert.equal(h.messages.at(-1).error.effect_state, 'unknown');
  const c = harness({ bookmarks: { getTree: async () => tree } }, (message, session) => {
    if (message.type === 'result.chunk') queueMicrotask(() => void session.handle({ v: 1, type: 'cancel', id: message.id }));
  });
  await c.call('bookmarks.getTree');
  assert.equal(c.messages.at(-1).error.code, 'cancelled');
  assert.equal(c.messages.some(m => m.type === 'result.end'), false);
});

test('stale sessions and invalid arguments do not call Chrome', async () => {
  let count = 0;
  const h = harness({ bookmarks: { getTree: async () => { count++; return []; } } });
  await h.call('bookmarks.getTree', [], { session_id: 'old' });
  await h.call('bookmarks.getTree', {}, {});
  assert.equal(count, 0);
  assert.equal(h.messages.length, 2);
  assert.ok(h.messages.every(m => m.error.code === 'invalid_request'));
});

test('disconnection abandons pending API without a late response', async () => {
  let finish;
  const h = harness({ bookmarks: { getTree: () => new Promise(resolve => { finish = resolve; }) } });
  const pending = h.call('bookmarks.getTree');
  h.session.close();
  await pending;
  finish([]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.messages.length, 0);
  assert.equal(h.session.active.size, 0);
});

test('non-JSON output does not silently change values', () => {
  for (const value of [NaN, new Date(), { missing: undefined }, { bigint: 1n }]) assert.throws(() => serializeJson(value), { code: 'unsupported_serialization' });
  const cycle = {}; cycle.self = cycle;
  assert.throws(() => serializeJson(cycle), { code: 'unsupported_serialization' });
});

test('bounded concurrency rejects the ninth call without executing it', async () => {
  let count = 0;
  const h = harness({ bookmarks: { getTree: () => { count++; return new Promise(() => {}); } } });
  const pending = Array.from({ length: 8 }, (_, index) => h.call('bookmarks.getTree', [], { id: `pending:${index}` }));
  await h.call('bookmarks.getTree', [], { id: 'overflow' });
  assert.equal(count, 8);
  assert.equal(h.messages[0].error.code, 'busy');
  h.session.close();
  await Promise.all(pending);
  assert.equal(h.session.active.size, 0);
});

test('oversized request is rejected before reaching Chrome', async () => {
  let called = false;
  const h = harness({ bookmarks: { search: async () => { called = true; return []; } } });
  await h.call('bookmarks.search', ['x'.repeat(MAX_FRAME_BYTES)]);
  assert.equal(called, false);
  assert.equal(h.messages[0].error.code, 'invalid_request');
});
