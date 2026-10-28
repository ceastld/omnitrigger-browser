export const VERSION = 1;
export const MAX_FRAME_BYTES = 256 * 1024;
export const MAX_CHUNK_BYTES = 128 * 1024;
export const MAX_RESULT_BYTES = 32 * 1024 * 1024;
export const MAX_REASSEMBLY_BYTES = 64 * 1024 * 1024;

const utf8 = new TextDecoder('utf-8', { fatal: true });

export class ProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProtocolError';
    this.code = 'protocol_error';
  }
}

export function parseJsonBytes(bytes) {
  try {
    return JSON.parse(utf8.decode(bytes));
  } catch {
    throw new ProtocolError('响应不是完整的 UTF-8 JSON。');
  }
}

export function encodeFrame(message) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  if (!payload.length || payload.length > MAX_FRAME_BYTES) {
    throw new ProtocolError('消息超过 256 KiB 单帧限制。');
  }
  const frame = Buffer.allocUnsafe(payload.length + 4);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

// 在读取帧头后先检查长度，再分配内存；支持任意 TCP / Named Pipe 分片。
export class FrameDecoder {
  #header = Buffer.alloc(4);
  #headerBytes = 0;
  #payload;
  #payloadBytes = 0;
  #onMessage;

  constructor(onMessage) {
    this.#onMessage = onMessage;
  }

  push(chunk) {
    if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
    let offset = 0;
    while (offset < chunk.length) {
      if (!this.#payload) {
        const size = Math.min(4 - this.#headerBytes, chunk.length - offset);
        chunk.copy(this.#header, this.#headerBytes, offset, offset + size);
        this.#headerBytes += size;
        offset += size;
        if (this.#headerBytes < 4) continue;
        const length = this.#header.readUInt32LE(0);
        if (!length || length > MAX_FRAME_BYTES) throw new ProtocolError('收到无效的消息帧长度。');
        this.#payload = Buffer.allocUnsafe(length);
        this.#payloadBytes = 0;
      }
      const size = Math.min(this.#payload.length - this.#payloadBytes, chunk.length - offset);
      chunk.copy(this.#payload, this.#payloadBytes, offset, offset + size);
      this.#payloadBytes += size;
      offset += size;
      if (this.#payloadBytes === this.#payload.length) {
        const message = parseJsonBytes(this.#payload);
        this.#payload = undefined;
        this.#payloadBytes = 0;
        this.#headerBytes = 0;
        this.#onMessage(message);
      }
    }
  }

  finish() {
    if (this.#headerBytes || this.#payload) throw new ProtocolError('连接在消息帧完成前关闭。');
  }
}

export function decodeChunk(data) {
  if (typeof data !== 'string' || data.length > Math.ceil(MAX_CHUNK_BYTES / 3) * 4
      || data.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
    throw new ProtocolError('分块编码无效。');
  }
  const bytes = Buffer.from(data, 'base64');
  if (!bytes.length || bytes.length > MAX_CHUNK_BYTES || bytes.toString('base64') !== data) {
    throw new ProtocolError('分块长度或编码无效。');
  }
  return bytes;
}
