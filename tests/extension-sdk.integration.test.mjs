import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { connect } from '../sdk-js/index.mjs';
import { RpcSession } from '../extension/rpc.mjs';
import { mockServer } from './helpers.mjs';

async function directExtension(t, chromeApi) {
  const sessions = new Map();
  const server = await mockServer(t, (message, peer) => {
    let session = sessions.get(peer);
    if (!session) {
      session = new RpcSession({
        chromeApi, sessionId: 'extension-session', browserInstanceId: 'work', send: value => peer.send(value),
      });
      sessions.set(peer, session);
      peer.socket.once('close', () => session.close());
    }
    return session.handle({ ...message, session_id: 'extension-session', browser_instance_id: 'work' });
  });
  return { ...server, sessions };
}

test('actual SDK and extension dispatcher round-trip getTree and parameterized search', async t => {
  const tree = [{ id: '0', title: '', children: [{ id: '1', title: 'Rust', url: 'https://www.rust-lang.org/' }] }];
  const bookmarks = {
    async getTree() { assert.equal(this, bookmarks); return tree; },
    async search(query) { return tree[0].children.filter(node => node.title.includes(query.query)); },
  };
  const { pipe } = await directExtension(t, { bookmarks });
  const client = await connect({ pipe, profile: 'work' });
  t.after(() => client.close());
  assert.deepEqual(await client.chrome.bookmarks.getTree(), tree);
  assert.deepEqual(await client.chrome.bookmarks.search({ query: 'Rust' }), tree[0].children);
});

test('actual extension chunks a multi-MiB Unicode tree and actual SDK acknowledges every chunk', async t => {
  const tree = [{ id: '0', title: '根', children: Array.from({ length: 7000 }, (_, index) => ({ id: String(index + 1), title: '书签🦀'.repeat(20), url: `https://example.com/${index}` })) }];
  const { pipe } = await directExtension(t, { bookmarks: { getTree: async () => tree } });
  const client = await connect({ pipe });
  t.after(() => client.close());
  assert.deepEqual(await client.chrome.bookmarks.getTree(), tree);
});

test('actual dispatcher errors and cancellation survive SDK transport', async t => {
  const { pipe, sessions } = await directExtension(t, {
    bookmarks: {
      getTree: async () => { throw new Error('Chrome bookmark failure'); },
      search: async () => new Promise(() => {}),
    },
  });
  const client = await connect({ pipe });
  t.after(() => client.close());
  await assert.rejects(client.chrome.bookmarks.getTree(), error => error.code === 'chrome_error' && error.message === 'Chrome bookmark failure');
  await assert.rejects(client.call('bookmarks.search', [{ query: 'Rust' }], { timeoutMs: 20 }), error => ['timeout', 'result_unknown'].includes(error.code));
  for (let attempt = 0; attempt < 20 && [...sessions.values()].some(session => session.active.size); attempt++) await delay(5);
  assert.ok([...sessions.values()].every(session => session.active.size === 0));
});
