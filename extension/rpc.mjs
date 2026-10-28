import { API_MODES } from './api-modes.mjs';

export const MAX_FRAME_BYTES = 262144;
export const MAX_RESULT_BYTES = 33554432;
export const CHUNK_BYTES = 131072;
export const MAX_CALLS = 8;
const encoder = new TextEncoder();
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);

export class RpcFault extends Error {
  constructor(code, message, effectState = 'not_started') {
    super(message);
    this.code = code;
    this.effectState = effectState;
  }
}

export function resolveChromeMethod(chromeApi, method) {
  if (typeof method !== 'string' || method.length > 200) {
    throw new RpcFault('invalid_request', 'method 必须是 Chrome API 方法路径。');
  }
  const parts = method.split('.');
  if (parts.length < 2 || parts.some(part => !/^[A-Za-z][A-Za-z0-9_]*$/.test(part) || forbidden.has(part))) {
    throw new RpcFault('invalid_request', 'Chrome API 方法路径无效。');
  }
  let owner = chromeApi;
  for (const part of parts.slice(0, -1)) {
    if (!owner || !Object.hasOwn(owner, part)) {
      throw new RpcFault('api_unavailable', `Chrome API 不可用：${method}`);
    }
    owner = owner[part];
  }
  const leaf = parts.at(-1);
  if (!owner || !Object.hasOwn(owner, leaf) || typeof owner[leaf] !== 'function') {
    throw new RpcFault('api_unavailable', `Chrome API 不可用：${method}`);
  }
  const mode = API_MODES[method];
  if (!mode) {
    throw new RpcFault('unsupported_api', `尚未适配此 API 的调用模式：${method}`);
  }
  return { owner, fn: owner[leaf], mode };
}

export function serializeJson(value) {
  const seen = new Set();
  function inspect(item) {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || seen.has(item)) {
      throw new RpcFault('unsupported_serialization', 'Chrome API 结果必须是 JSON 数据。', 'unknown');
    }
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
      throw new RpcFault('unsupported_serialization', 'Chrome API 对象需要专门的句柄适配。', 'unknown');
    }
    seen.add(item);
    if (Array.isArray(item)) {
      for (let index = 0; index < item.length; index++) {
        if (!Object.hasOwn(item, index)) throw new RpcFault('unsupported_serialization', 'Chrome API 结果不能包含稀疏数组。', 'unknown');
      }
    }
    for (const nested of Object.values(item)) inspect(nested);
    seen.delete(item);
  }
  inspect(value);
  return encoder.encode(JSON.stringify(value));
}

function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

function raceAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

export class RpcSession {
  constructor({ chromeApi, sessionId, browserInstanceId, send }) {
    this.chromeApi = chromeApi;
    this.sessionId = sessionId;
    this.browserInstanceId = browserInstanceId;
    this.send = send;
    this.active = new Map();
    this.closed = false;
  }

  post(message) {
    if (this.closed) throw new RpcFault('disconnected', 'Native 连接已关闭。', 'unknown');
    if (encoder.encode(JSON.stringify(message)).length > MAX_FRAME_BYTES) throw new RpcFault('payload_too_large', '协议帧超过 256 KiB。', 'unknown');
    this.send(message);
  }

  fail(id, error, started = false) {
    const fault = error instanceof RpcFault ? error : new RpcFault('chrome_error', String(error?.message ?? error), started ? 'unknown' : 'not_started');
    this.post({ v: 1, type: 'result', id, session_id: this.sessionId, ok: false, error: {
      code: fault.code, message: fault.message.slice(0, 2048), effect_state: fault.effectState,
    } });
  }

  async handle(message) {
    if (this.closed) return;
    if (!message || typeof message !== 'object' || message.v !== 1) return;
    if (message.type === 'result.ack') {
      const call = this.active.get(message.id);
      if (call?.ack?.index === message.index) call.ack.resolve();
      return;
    }
    if (message.type === 'cancel') {
      const call = this.active.get(message.id);
      call?.controller.abort(new RpcFault('cancelled', '调用已取消；Chrome 内部操作可能已经开始。', call.started ? 'unknown' : 'not_started'));
      return;
    }
    if (message.type !== 'call') {
      if (typeof message.id === 'string') this.fail(message.id, new RpcFault('unsupported_api', '首版暂不支持此协议操作。'));
      return;
    }
    const { id, args, method } = message;
    if (typeof id !== 'string' || !id || id.length > 256) return;
    if (message.session_id !== this.sessionId || (message.browser_instance_id && message.browser_instance_id !== this.browserInstanceId)) {
      this.fail(id, new RpcFault('invalid_request', '请求不属于当前浏览器会话。'));
      return;
    }
    if (this.active.has(id)) {
      this.fail(id, new RpcFault('invalid_request', '请求 ID 已在执行。'));
      return;
    }
    if (this.active.size >= MAX_CALLS) {
      this.fail(id, new RpcFault('busy', '扩展调用配额已满。'));
      return;
    }
    const milliseconds = message.timeout_ms ?? 10000;
    if (!Array.isArray(args) || !Number.isInteger(milliseconds) || milliseconds < 1 || milliseconds > 60000
        || encoder.encode(JSON.stringify(message)).length > MAX_FRAME_BYTES) {
      this.fail(id, new RpcFault('invalid_request', '参数、超时或请求长度无效。'));
      return;
    }
    const call = { controller: new AbortController(), started: false, ack: null };
    this.active.set(id, call);
    const timer = setTimeout(() => call.controller.abort(new RpcFault('timeout', 'Chrome API 调用或结果传输超时。', call.started ? 'unknown' : 'not_started')), milliseconds);
    try {
      const { owner, fn, mode } = resolveChromeMethod(this.chromeApi, method);
      if (call.controller.signal.aborted) throw call.controller.signal.reason;
      call.started = true;
      const pending = Reflect.apply(fn, owner, args);
      // Never call again to probe callback-vs-Promise compatibility.
      if (mode === 'promise' && (!pending || typeof pending.then !== 'function')) {
        throw new RpcFault('unsupported_api', '当前 Chrome 版本未按预期返回 Promise；未重复调用。', 'unknown');
      }
      const value = await raceAbort(pending, call.controller.signal);
      await this.sendValue(id, value, call);
    } catch (error) {
      if (!this.closed) this.fail(id, error, call.started);
    } finally {
      clearTimeout(timer);
      this.active.delete(id);
    }
  }

  async sendValue(id, value, call) {
    const prefix = { v: 1, type: 'result', id, session_id: this.sessionId, ok: true, has_value: value !== undefined };
    if (value === undefined) { this.post(prefix); return; }
    const bytes = serializeJson(value);
    if (bytes.length > MAX_RESULT_BYTES) throw new RpcFault('result_too_large', 'Chrome API 结果超过 32 MiB。', 'unknown');
    const message = { ...prefix, value };
    if (encoder.encode(JSON.stringify(message)).length <= MAX_FRAME_BYTES) { this.post(message); return; }
    const chunkCount = Math.ceil(bytes.length / CHUNK_BYTES);
    this.post({ v: 1, type: 'result.begin', id, session_id: this.sessionId, total_bytes: bytes.length, chunk_count: chunkCount });
    for (let index = 0; index < chunkCount; index++) {
      if (call.controller.signal.aborted) throw call.controller.signal.reason;
      let resolveAck;
      const acknowledgement = new Promise(resolve => { resolveAck = resolve; });
      call.ack = { index, resolve: resolveAck };
      this.post({ v: 1, type: 'result.chunk', id, session_id: this.sessionId, index, data: toBase64(bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES)) });
      await raceAbort(acknowledgement, call.controller.signal);
      call.ack = null;
    }
    if (call.controller.signal.aborted) throw call.controller.signal.reason;
    this.post({ v: 1, type: 'result.end', id, session_id: this.sessionId });
  }

  close() {
    this.closed = true;
    for (const call of this.active.values()) call.controller.abort(new RpcFault('disconnected', 'Native 连接已关闭。', call.started ? 'unknown' : 'not_started'));
  }
}
