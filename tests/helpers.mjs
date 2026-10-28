import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FrameDecoder, encodeFrame, MAX_CHUNK_BYTES } from '../sdk-js/protocol.mjs';

export function testPipe(label = 'sdk') {
  const name = `omnitrigger-test-${label}-${process.pid}-${randomUUID()}`;
  return process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : join(tmpdir(), `${name}.sock`);
}

export class Peer {
  constructor(socket, handler) {
    this.socket = socket;
    this.queue = [];
    this.waiters = [];
    this.failure = undefined;
    const decoder = new FrameDecoder(message => {
      const index = this.waiters.findIndex(waiter => waiter.predicate(message));
      if (index >= 0) {
        const [waiter] = this.waiters.splice(index, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      } else if (handler) {
        Promise.resolve(handler(message, this)).catch(error => this.fail(error));
      } else this.queue.push(message);
    });
    socket.on('data', bytes => {
      try { decoder.push(bytes); }
      catch (error) { this.fail(error); }
    });
    socket.on('error', error => this.fail(error));
    socket.on('close', () => this.fail(new Error('peer disconnected')));
  }

  send(message) { this.socket.write(encodeFrame(message)); }

  next(predicate = () => true, timeoutMs = 5000) {
    const index = this.queue.findIndex(predicate);
    if (index >= 0) return Promise.resolve(this.queue.splice(index, 1)[0]);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject };
      waiter.timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new Error('peer response timeout'));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  fail(error) {
    if (this.failure) return;
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.socket.destroy();
  }

  close() { this.socket.destroy(); }
}

export async function mockServer(t, handler) {
  const pipe = testPipe();
  const peers = new Set();
  const server = net.createServer(socket => {
    const peer = new Peer(socket, async (message, current) => {
      if (message.type === 'hello') current.send({ v: 1, type: 'hello', ok: true });
      else await handler(message, current);
    });
    peers.add(peer);
    socket.on('close', () => peers.delete(peer));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(pipe, resolve);
  });
  t.after(async () => {
    for (const peer of peers) peer.close();
    await new Promise(resolve => server.close(resolve));
  });
  return { pipe, server, peers };
}

export function result(message, value, session = 'test-session') {
  return { v: 1, type: 'result', id: message.id, session_id: session, ok: true, has_value: value !== undefined, ...(value === undefined ? {} : { value }) };
}

export async function sendChunks(peer, message, value, session = 'test-session') {
  const bytes = Buffer.from(JSON.stringify(value), 'utf8');
  const count = Math.ceil(bytes.length / MAX_CHUNK_BYTES);
  peer.send({ v: 1, type: 'result.begin', id: message.id, session_id: session, total_bytes: bytes.length, chunk_count: count });
  for (let index = 0; index < count; index++) {
    const ack = peer.next(item => item.type === 'result.ack' && item.id === message.id && item.index === index);
    peer.send({
      v: 1, type: 'result.chunk', id: message.id, session_id: session, index,
      data: bytes.subarray(index * MAX_CHUNK_BYTES, (index + 1) * MAX_CHUNK_BYTES).toString('base64'),
    });
    await ack;
  }
  peer.send({ v: 1, type: 'result.end', id: message.id, session_id: session });
}
