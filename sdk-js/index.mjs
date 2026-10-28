import net from 'node:net';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  FrameDecoder, encodeFrame, decodeChunk, parseJsonBytes, ProtocolError,
  MAX_RESULT_BYTES, MAX_REASSEMBLY_BYTES,
} from './protocol.mjs';

export class BrowserError extends Error {
  constructor(code, message, { method, effectState = 'not_started' } = {}) {
    super(message);
    this.name = 'BrowserError';
    this.code = code;
    this.method = method;
    this.effectState = effectState;
  }
}

function timeoutValue(value, fallback) {
  const timeoutMs = value ?? fallback;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new BrowserError('invalid_request', 'timeoutMs 必须为 1..60000 的整数。');
  }
  return timeoutMs;
}

function validateMethod(method) {
  if (typeof method !== 'string' || method.length > 256
      || !/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(method)
      || method.split('.').some(part => ['__proto__', 'prototype', 'constructor'].includes(part))) {
    throw new BrowserError('invalid_request', '方法需使用 bookmarks.getTree 等 Chrome API 路径。');
  }
}

function validateJson(value, seen = new Set(), depth = 0) {
  if (depth > 64) throw new BrowserError('invalid_request', '参数嵌套过深。');
  if (value === null || typeof value === 'string' || typeof value === 'boolean'
      || (typeof value === 'number' && Number.isFinite(value))) return;
  if (!value || typeof value !== 'object' || seen.has(value)
      || (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
      || Object.getOwnPropertySymbols(value).length) {
    throw new BrowserError('invalid_request', '参数必须为可序列化的 JSON，不支持函数、undefined 或循环引用。');
  }
  seen.add(value);
  for (const item of Array.isArray(value) ? value : Object.values(value)) validateJson(item, seen, depth + 1);
  seen.delete(value);
}

function chromeProxy(client, parts = []) {
  return new Proxy(function () {}, {
    get(_target, name) {
      if (name === 'then' || name === 'toJSON') return undefined;
      if (name === Symbol.toStringTag) return 'RemoteChrome';
      if (typeof name !== 'string') return undefined;
      return chromeProxy(client, [...parts, name]);
    },
    apply(_target, _thisArg, args) {
      return client.call(parts.join('.'), args);
    },
  });
}

export class BrowserClient {
  #socket;
  #pending = new Map();
  #ready;
  #readyResolve;
  #readyReject;
  #readyDone = false;
  #closed = false;
  #counter = 0;
  #prefix = randomUUID();
  #reservedBytes = 0;
  #helloTimer;
  #profile;
  #defaultTimeout;

  constructor(socket, { profile, timeoutMs = 10_000, connectTimeoutMs = 5000 } = {}) {
    this.#socket = socket;
    this.#profile = profile;
    this.#defaultTimeout = timeoutValue(timeoutMs, 10_000);
    this.chrome = chromeProxy(this);
    this.#ready = new Promise((resolve, reject) => {
      this.#readyResolve = resolve;
      this.#readyReject = reject;
    });
    this.#helloTimer = setTimeout(() => this.#fail(new BrowserError('timeout', '连接桥接服务超时。')), timeoutValue(connectTimeoutMs, 5000));
    const decoder = new FrameDecoder(message => this.#receive(message));
    socket.on('connect', () => {
      try { this.#write({ v: 1, type: 'hello', role: 'client' }); }
      catch (error) { this.#fail(error); }
    });
    socket.on('data', chunk => {
      try { decoder.push(chunk); }
      catch (error) { this.#fail(error); }
    });
    socket.on('error', error => this.#fail(new BrowserError('disconnected', `桥接连接失败：${error.message}`, { effectState: 'unknown' })));
    socket.on('close', () => {
      try { decoder.finish(); }
      catch (error) { this.#fail(error); return; }
      this.#fail(new BrowserError('disconnected', '桥接连接已关闭。', { effectState: 'unknown' }));
    });
  }

  ready() { return this.#ready; }

  async profiles(options = {}) {
    return this.#request('profiles', {}, options);
  }

  async call(method, args = [], options = {}) {
    validateMethod(method);
    if (!Array.isArray(args)) throw new BrowserError('invalid_request', 'args 必须为数组。');
    validateJson(args);
    const profile = options.profile ?? this.#profile;
    if (profile !== undefined && (typeof profile !== 'string' || !profile || profile.length > 256)) {
      throw new BrowserError('invalid_request', 'profile 必须为浏览器身份字符串。');
    }
    return this.#request('call', {
      method, args, ...(profile === undefined ? {} : { browser_instance_id: profile }),
    }, options);
  }

  close() {
    this.#fail(new BrowserError('disconnected', '客户端已关闭。', { effectState: 'unknown' }));
  }

  async #request(type, fields, options) {
    const timeoutMs = timeoutValue(options.timeoutMs, this.#defaultTimeout);
    await this.#ready;
    if (this.#closed) throw new BrowserError('disconnected', '客户端已关闭。');
    if (options.signal?.aborted) throw new BrowserError('cancelled', '调用在派发前已取消。');
    if (this.#pending.size >= 8) throw new BrowserError('busy', '本客户端最多同时执行 8 个调用。');
    const id = `${this.#prefix}:${++this.#counter}`;
    const message = { v: 1, type, id, ...fields, timeout_ms: timeoutMs };
    const frame = encodeFrame(message);
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, method: fields.method, stream: undefined, timer: undefined, removeAbort: undefined };
      const cancel = code => {
        if (!this.#pending.has(id)) return;
        this.#finish(id, new BrowserError(code, code === 'timeout' ? '浏览器调用超时；操作可能已生效。' : '调用等待已取消；操作可能已生效。', {
          method: fields.method, effectState: 'unknown',
        }));
        try { this.#write({ v: 1, type: 'cancel', id }); } catch { /* 连接错误由 socket 处理。 */ }
      };
      entry.timer = setTimeout(() => cancel('timeout'), timeoutMs);
      if (options.signal) {
        const aborted = () => cancel('cancelled');
        options.signal.addEventListener('abort', aborted, { once: true });
        entry.removeAbort = () => options.signal.removeEventListener('abort', aborted);
      }
      this.#pending.set(id, entry);
      try { this.#socket.write(frame); }
      catch (error) { this.#finish(id, new BrowserError('disconnected', error.message, { effectState: 'unknown' })); }
    });
  }

  #write(message) {
    if (this.#closed) throw new BrowserError('disconnected', '客户端已关闭。');
    this.#socket.write(encodeFrame(message));
  }

  #receive(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message) || message.v !== 1) {
      throw new ProtocolError('响应协议版本或格式无效。');
    }
    if (!this.#readyDone) {
      if (message.type !== 'hello' || message.ok !== true) throw new ProtocolError('桥接服务握手失败。');
      clearTimeout(this.#helloTimer);
      this.#readyDone = true;
      this.#readyResolve(this);
      return;
    }
    if (typeof message.id !== 'string') throw new ProtocolError('响应缺少请求身份。');
    const entry = this.#pending.get(message.id);
    // 已超时或已取消请求的迟到响应不能污染后续调用。
    if (!entry) return;
    if (message.type === 'result') {
      if (message.ok === false) {
        if (!message.error || typeof message.error.code !== 'string' || typeof message.error.message !== 'string') {
          throw new ProtocolError('错误响应格式无效。');
        }
        return this.#finish(message.id, new BrowserError(message.error.code, message.error.message, {
          method: entry.method, effectState: message.error.effect_state ?? 'unknown',
        }));
      }
      if (entry.stream || message.ok !== true || typeof message.has_value !== 'boolean'
          || (message.has_value && !Object.hasOwn(message, 'value'))) throw new ProtocolError('成功响应格式无效。');
      return this.#finish(message.id, undefined, message.has_value ? message.value : undefined);
    }
    if (message.type === 'result.begin') {
      if (entry.stream || !Number.isInteger(message.total_bytes) || message.total_bytes < 1 || message.total_bytes > MAX_RESULT_BYTES
          || !Number.isInteger(message.chunk_count) || message.chunk_count < 1 || message.chunk_count > 4096
          || message.chunk_count > message.total_bytes || message.total_bytes > message.chunk_count * 131072
          || typeof message.session_id !== 'string' || !message.session_id) {
        throw new ProtocolError('分块结果声明无效或超限。');
      }
      if (this.#reservedBytes + message.total_bytes > MAX_REASSEMBLY_BYTES) throw new ProtocolError('连接结果重组预算已满。');
      this.#reservedBytes += message.total_bytes;
      entry.stream = { total: message.total_bytes, count: message.chunk_count, session: message.session_id, next: 0, bytes: 0, chunks: [] };
      return;
    }
    const stream = entry.stream;
    if (!stream || message.session_id !== stream.session) throw new ProtocolError('分块结果会话不匹配。');
    if (message.type === 'result.chunk') {
      if (!Number.isInteger(message.index) || message.index !== stream.next || stream.next >= stream.count) {
        throw new ProtocolError('分块序号无效。');
      }
      const bytes = decodeChunk(message.data);
      if (stream.bytes + bytes.length > stream.total) throw new ProtocolError('分块结果超过声明的总长度。');
      stream.chunks.push(bytes);
      stream.bytes += bytes.length;
      stream.next++;
      this.#write({ v: 1, type: 'result.ack', id: message.id, index: message.index });
      return;
    }
    if (message.type === 'result.end') {
      if (stream.bytes !== stream.total || stream.next !== stream.count) throw new ProtocolError('分块结果不完整。');
      const value = parseJsonBytes(Buffer.concat(stream.chunks, stream.total));
      return this.#finish(message.id, undefined, value);
    }
    throw new ProtocolError('未知响应消息类型。');
  }

  #finish(id, error, value) {
    const entry = this.#pending.get(id);
    if (!entry) return;
    this.#pending.delete(id);
    clearTimeout(entry.timer);
    entry.removeAbort?.();
    if (entry.stream) this.#reservedBytes -= entry.stream.total;
    if (error) entry.reject(error);
    else entry.resolve(value);
  }

  #fail(error) {
    if (this.#closed) return;
    this.#closed = true;
    clearTimeout(this.#helloTimer);
    if (!this.#readyDone) {
      this.#readyDone = true;
      this.#readyReject(error);
    }
    for (const id of this.#pending.keys()) this.#finish(id, error);
    this.#socket.destroy();
  }
}

export async function connect(options = {}) {
  timeoutValue(options.timeoutMs, 10_000);
  timeoutValue(options.connectTimeoutMs, 5000);
  let pipe = options.pipe ?? process.env.OMNITRIGGER_BROWSER_PIPE;
  if (!pipe) {
    const configPath = options.configPath ?? (process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, 'OmniTriggerBrowser', 'connection.json') : undefined);
    if (!configPath) throw new BrowserError('not_configured', '请指定 pipe 或 configPath。');
    let config;
    try { config = JSON.parse((await readFile(configPath, 'utf8')).replace(/^\uFEFF/, '')); }
    catch (error) { throw new BrowserError('not_configured', `无法读取连接配置：${error.message}`); }
    pipe = config.pipe;
  }
  if (typeof pipe !== 'string' || !pipe || pipe.length > 1000) throw new BrowserError('invalid_request', '连接配置缺少有效 pipe。');
  const socket = net.createConnection(pipe);
  const client = new BrowserClient(socket, options);
  await client.ready();
  return client;
}
