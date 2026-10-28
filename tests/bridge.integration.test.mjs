import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { connect } from '../sdk-js/index.mjs';
import { Peer, testPipe, result, sendChunks } from './helpers.mjs';

const binary = process.env.OMNITRIGGER_BROWSER_BIN ?? fileURLToPath(new URL(`../target/debug/omnitrigger-browser${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url));
const skip = existsSync(binary) ? false : '先运行 cargo build 构建真实 bridge 可执行文件。';

async function startBridge(t) {
  const pipe = testPipe('bridge');
  const child = spawn(binary, ['serve', '--pipe', pipe], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', bytes => { output = (output + bytes).slice(-16_384); });
  child.stderr.on('data', bytes => { output = (output + bytes).slice(-16_384); });
  let processError;
  child.on('error', error => { processError = error; });
  const exit = new Promise(resolve => child.once('exit', resolve));
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await Promise.race([exit, delay(2000)]);
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (processError) throw processError;
    if (child.exitCode !== null) throw new Error(`bridge 已退出：${output}`);
    try {
      const client = await connect({ pipe, connectTimeoutMs: 100 });
      client.close();
      return pipe;
    } catch { await delay(30); }
  }
  throw new Error(`bridge 未就绪：${output}`);
}

async function attachExtension(t, pipe, name, handler) {
  const socket = net.createConnection(pipe);
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  const peer = new Peer(socket, handler);
  t.after(() => peer.close());
  const ack = peer.next(message => message.type === 'hello');
  peer.send({
    v: 1, type: 'hello', role: 'extension', browser_instance_id: name, session_id: `${name}-session`,
    name, capabilities: { call: true, chunks: true },
  });
  assert.equal((await ack).ok, true);
  return peer;
}

async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await delay(10);
  }
  assert.fail('未在期限内观察到预期状态。');
}

test('real Rust bridge routes selected profiles and preserves concurrent request identities', { skip }, async t => {
  const pipe = await startBridge(t);
  const client = await connect({ pipe });
  t.after(() => client.close());
  assert.deepEqual(await client.profiles(), []);
  await assert.rejects(client.chrome.bookmarks.getTree(), error => error.code === 'not_connected');
  const seen = [];
  await attachExtension(t, pipe, 'work', async (message, peer) => {
    if (message.type !== 'call') return;
    seen.push(message);
    if (message.method === 'bookmarks.getTree') await delay(30);
    peer.send(result(message, { profile: 'work', method: message.method, args: message.args }, 'work-session'));
  });
  await attachExtension(t, pipe, 'personal', (message, peer) => {
    if (message.type === 'call') peer.send(result(message, { profile: 'personal' }, 'personal-session'));
  });
  assert.equal((await client.profiles()).length, 2);
  await assert.rejects(client.chrome.bookmarks.getTree(), error => error.code === 'target_ambiguous');
  const [tree, matches] = await Promise.all([
    client.call('bookmarks.getTree', [], { profile: 'work' }),
    client.call('bookmarks.search', [{ query: 'Rust' }], { profile: 'work' }),
  ]);
  assert.equal(tree.method, 'bookmarks.getTree');
  assert.deepEqual(matches.args, [{ query: 'Rust' }]);
  assert.equal(tree.profile, 'work');
  assert.notEqual(seen[0].id, seen[1].id);
  assert.equal(seen[0].session_id, 'work-session');
  assert.equal((await client.call('bookmarks.getTree', [], { profile: 'personal' })).profile, 'personal');
});

test('real Rust bridge forwards a large UTF-8 result with client ACK backpressure', { skip }, async t => {
  const pipe = await startBridge(t);
  const tree = [{ id: '0', title: '根', children: Array.from({ length: 8000 }, (_, index) => ({ id: String(index + 1), title: '示例书签🦀'.repeat(15), url: `https://example.com/${index}` })) }];
  await attachExtension(t, pipe, 'work', (message, peer) => {
    if (message.type === 'call') return sendChunks(peer, message, tree, 'work-session');
  });
  const client = await connect({ pipe });
  t.after(() => client.close());
  assert.deepEqual(await client.chrome.bookmarks.getTree(), tree);
});

test('real Rust bridge reports timeout and native peer disconnect without replay', { skip }, async t => {
  const pipe = await startBridge(t);
  let calls = 0;
  let cancellation;
  const extension = await attachExtension(t, pipe, 'work', (message, peer) => {
    if (message.type === 'call') calls++;
    if (message.type === 'cancel') cancellation = message.id;
    if (message.type === 'call' && message.args[0] === 'disconnect') peer.close();
  });
  const client = await connect({ pipe });
  t.after(() => client.close());
  await assert.rejects(client.call('bookmarks.search', ['slow'], { timeoutMs: 30 }), error => ['timeout', 'result_unknown'].includes(error.code));
  for (let attempt = 0; attempt < 20 && !cancellation; attempt++) await delay(10);
  assert.equal(typeof cancellation, 'string');
  await assert.rejects(client.call('bookmarks.search', ['disconnect']), error => ['result_unknown', 'disconnected'].includes(error.code));
  assert.equal(calls, 2);
  extension.close();
});

test('real Rust bridge cancels and releases all 8 slots on explicit cancellation or client disconnect', { skip }, async t => {
  const pipe = await startBridge(t);
  const calls = [];
  const cancellations = [];
  await attachExtension(t, pipe, 'work', (message, peer) => {
    if (message.type === 'cancel') cancellations.push(message.id);
    if (message.type !== 'call') return;
    calls.push(message);
    if (message.args[0] === 'quick') peer.send(result(message, 'ok', 'work-session'));
  });
  const client = await connect({ pipe });
  t.after(() => client.close());
  const controllers = Array.from({ length: 8 }, () => new AbortController());
  const firstWave = Promise.allSettled(controllers.map(controller => client.call('bookmarks.search', ['hold'], { signal: controller.signal })));
  await waitUntil(() => calls.length === 8);
  for (const controller of controllers) controller.abort();
  assert.ok((await firstWave).every(value => value.status === 'rejected' && value.reason.code === 'cancelled'));
  await waitUntil(() => cancellations.length === 8);
  assert.equal(await client.call('bookmarks.search', ['quick']), 'ok');

  const secondWave = Promise.allSettled(Array.from({ length: 8 }, () => client.call('bookmarks.search', ['hold'])));
  await waitUntil(() => calls.length === 17);
  client.close();
  assert.ok((await secondWave).every(value => value.status === 'rejected'));
  await waitUntil(() => cancellations.length === 16);
  const nextClient = await connect({ pipe });
  t.after(() => nextClient.close());
  assert.equal(await nextClient.call('bookmarks.search', ['quick']), 'ok');
});

test('real Rust bridge rejects in-flight duplicate IDs and ignores old remote results after ID reuse', { skip }, async t => {
  const pipe = await startBridge(t);
  const calls = [];
  const extension = await attachExtension(t, pipe, 'work', message => {
    if (message.type === 'call') calls.push(message);
  });
  const socket = net.createConnection(pipe);
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  const client = new Peer(socket);
  t.after(() => client.close());
  client.send({ v: 1, type: 'hello', role: 'client' });
  assert.equal((await client.next()).ok, true);
  const request = { v: 1, type: 'call', id: 'same-client-id', method: 'bookmarks.getTree', args: [], timeout_ms: 3000 };
  client.send(request);
  await waitUntil(() => calls.length === 1);
  client.send(request);
  assert.equal((await client.next()).error.code, 'busy');
  assert.equal(calls.length, 1);
  extension.send(result(calls[0], 'first', 'work-session'));
  assert.equal((await client.next()).value, 'first');
  client.send(request);
  await waitUntil(() => calls.length === 2);
  assert.notEqual(calls[0].id, calls[1].id);
  extension.send(result(calls[0], 'stale', 'work-session'));
  extension.send(result(calls[1], 'second', 'work-session'));
  assert.equal((await client.next()).value, 'second');
});
