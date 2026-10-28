import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { connect } from '../sdk-js/index.mjs';
import { FrameDecoder, encodeFrame, MAX_FRAME_BYTES } from '../sdk-js/protocol.mjs';
import { mockServer, result, sendChunks } from './helpers.mjs';

test('Proxy forwards Chrome method and args, concurrent replies retain identity', async t => {
  const calls = [];
  const { pipe } = await mockServer(t, async (message, peer) => {
    calls.push(message);
    if (message.method === 'bookmarks.getTree') {
      await delay(30);
      peer.send(result(message, [{ id: '0', title: '书签', children: [] }]));
    } else if (message.method === 'bookmarks.search') peer.send(result(message, [{ id: '1', title: message.args[0].query }]));
    else if (message.type === 'profiles') peer.send(result(message, [{ browser_instance_id: 'work' }]));
  });
  const client = await connect({ pipe, profile: 'work' });
  t.after(() => client.close());
  assert.equal(client.chrome.then, undefined);
  assert.equal(await Promise.resolve(client.chrome), client.chrome);
  const [tree, matches] = await Promise.all([
    client.chrome.bookmarks.getTree(), client.chrome.bookmarks.search({ query: 'Rust' }),
  ]);
  assert.equal(tree[0].title, '书签');
  assert.equal(matches[0].title, 'Rust');
  assert.deepEqual(calls[0].args, []);
  assert.equal(calls[0].browser_instance_id, 'work');
  assert.notEqual(calls[0].id, calls[1].id);
  assert.equal((await client.profiles())[0].browser_instance_id, 'work');
});

test('Chrome errors, null and undefined retain distinct semantics', async t => {
  const { pipe } = await mockServer(t, (message, peer) => {
    if (message.args[0] === 'error') peer.send({ v: 1, type: 'result', id: message.id, ok: false, error: { code: 'chrome_error', message: 'Cannot find bookmark', effect_state: 'unknown' } });
    else peer.send(result(message, message.args[0] === 'null' ? null : undefined));
  });
  const client = await connect({ pipe });
  t.after(() => client.close());
  assert.equal(await client.call('bookmarks.get', ['null']), null);
  assert.equal(await client.call('bookmarks.get', ['undefined']), undefined);
  await assert.rejects(client.call('bookmarks.get', ['error']), error => error.code === 'chrome_error' && error.effectState === 'unknown' && error.method === 'bookmarks.get');
});

test('multi-MiB UTF-8 tree is reassembled exactly with per-chunk ACK', async t => {
  const tree = [{ id: '0', title: '根', children: Array.from({ length: 5500 }, (_, index) => ({ id: String(index + 1), title: '书签🦀'.repeat(20), url: `https://example.com/${index}` })) }];
  const { pipe } = await mockServer(t, (message, peer) => {
    if (message.type === 'call') return sendChunks(peer, message, tree);
  });
  const client = await connect({ pipe });
  t.after(() => client.close());
  const output = await client.chrome.bookmarks.getTree();
  assert.deepEqual(output, tree);
});

test('timeout sends cancel, late results do not contaminate a later call', async t => {
  let cancelled;
  const { pipe } = await mockServer(t, async (message, peer) => {
    if (message.type === 'cancel') { cancelled = message.id; return; }
    if (message.args[0] === 'slow') await delay(50);
    peer.send(result(message, message.args[0]));
  });
  const client = await connect({ pipe });
  t.after(() => client.close());
  await assert.rejects(client.call('bookmarks.search', ['slow'], { timeoutMs: 10 }), error => error.code === 'timeout' && error.effectState === 'unknown');
  assert.equal(await client.call('bookmarks.search', ['fast']), 'fast');
  await delay(60);
  assert.equal(typeof cancelled, 'string');
  assert.equal(await client.call('bookmarks.search', ['later']), 'later');
});

test('AbortSignal cancels only waiting and does not retry', async t => {
  let calls = 0;
  const { pipe } = await mockServer(t, message => { if (message.type === 'call') calls++; });
  const client = await connect({ pipe });
  t.after(() => client.close());
  const controller = new AbortController();
  const pending = client.call('bookmarks.search', ['x'], { signal: controller.signal });
  await delay(10);
  controller.abort();
  await assert.rejects(pending, error => error.code === 'cancelled');
  assert.equal(calls, 1);
});

test('disconnect rejects pending calls and subsequent calls', async t => {
  const { pipe } = await mockServer(t, (_message, peer) => peer.close());
  const client = await connect({ pipe });
  await assert.rejects(client.chrome.bookmarks.getTree(), error => error.code === 'disconnected');
  await assert.rejects(client.chrome.bookmarks.getTree(), error => error.code === 'disconnected');
});

test('invalid JSON input and more than 8 simultaneous calls fail locally', async t => {
  const { pipe } = await mockServer(t, () => {});
  const client = await connect({ pipe });
  t.after(() => client.close());
  const loop = {}; loop.loop = loop;
  for (const args of [[undefined], [() => {}], [Infinity], [loop], [new Date()]]) {
    await assert.rejects(client.call('bookmarks.search', args), error => error.code === 'invalid_request');
  }
  await assert.rejects(client.call('__proto__.x', []), error => error.code === 'invalid_request');
  const requests = Array.from({ length: 8 }, () => client.call('bookmarks.search', [], { timeoutMs: 1000 }));
  const settled = Promise.allSettled(requests);
  await assert.rejects(client.call('bookmarks.search', []), error => error.code === 'busy');
  client.close();
  assert.equal((await settled).length, 8);
});

test('invalid chunk sequence and changed session fail closed', async t => {
  for (const invalid of ['sequence', 'session']) {
    const { pipe } = await mockServer(t, (message, peer) => {
      if (message.type !== 'call') return;
      peer.send({ v: 1, type: 'result.begin', id: message.id, session_id: 'a', total_bytes: 2, chunk_count: 1 });
      peer.send({ v: 1, type: 'result.chunk', id: message.id, session_id: invalid === 'session' ? 'b' : 'a', index: invalid === 'sequence' ? 1 : 0, data: Buffer.from('[]').toString('base64') });
    });
    const client = await connect({ pipe });
    await assert.rejects(client.chrome.bookmarks.getTree(), error => error.code === 'protocol_error');
  }
});

test('frame decoder checks lengths, invalid UTF-8 and split headers', () => {
  const value = { v: 1, type: 'result', value: '书签🦀' };
  const frame = encodeFrame(value);
  const seen = [];
  const decoder = new FrameDecoder(item => seen.push(item));
  for (const byte of frame) decoder.push(Buffer.from([byte]));
  decoder.finish();
  assert.deepEqual(seen, [value]);
  const oversized = Buffer.alloc(4); oversized.writeUInt32LE(MAX_FRAME_BYTES + 1);
  assert.throws(() => new FrameDecoder(() => {}).push(oversized), /长度/);
  assert.throws(() => new FrameDecoder(() => {}).push(Buffer.from([1, 0, 0, 0, 0xff])), /UTF-8/);
  const incomplete = new FrameDecoder(() => {}); incomplete.push(frame.subarray(0, 5));
  assert.throws(() => incomplete.finish(), /完成前/);
});
