import { glyphMasks } from './ascii.js';
import { validateOpus } from './opus.js';
import { crc32, IntegrityVerifier } from './checksum.js';
import { CACHE_BYTES, REQUEST_BYTES, MAX_REQUESTS, MAX_RECORDS, audioBytes } from './delivery.js';
export { crc32 } from './checksum.js';

const MAX_CHUNK = 16 * 1024 * 1024;
function invalid(condition, message = 'Invalid SCI stream.') {
  if (condition) throw new Error(message);
}

export function codecFormat(video) {
  invalid(video?.codec !== 'sci-ascii-scene-v1' || video.cellBytes !== 28 || video.font !== 'ascii-3x4-v2' || video.glyphTransform !== 'reflect-xy-v1', 'Unsupported SCI representation.');
  return 28;
}

export function parseHeader(bytes) {
  invalid(bytes.byteLength !== 32);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  invalid(new TextDecoder().decode(bytes.subarray(0, 4)) !== 'SCIV' || ![4, 5, 6].includes(view.getUint16(4, true)), 'Unsupported SCI version.');
  const header = {
    version: view.getUint16(4, true), recordBytes: 48,
    audio: view.getUint16(6, true), metadataLength: view.getUint32(8, true),
    count: view.getUint32(12, true), indexOffset: Number(view.getBigUint64(16, true)), size: Number(view.getBigUint64(24, true)),
  };
  invalid(header.audio > 1 || header.metadataLength < 2 || header.metadataLength > 4096 || header.count < 1 || header.count > 100000);
  invalid(!Number.isSafeInteger(header.size) || header.size > 64 * 1024 ** 3 || header.indexOffset < 32 + header.metadataLength || header.indexOffset > 65536);
  invalid(header.indexOffset + header.count * header.recordBytes >= header.size);
  return header;
}

export function parseIndex(bytes, header, metadata) {
  const video = metadata.video;
  codecFormat(video);
  const recordBytes = 48;
  const packetFormat = header.version === 4 ? 'ascii-scene-zlib' : header.version === 5 ? 'ascii-scene-fields-zlib' : 'ascii-scene-color-fields-zlib';
  invalid(![4, 5, 6].includes(header.version) || metadata.version !== header.version || video.packetFormat !== packetFormat || !glyphMasks.has(video.font) || video.cellWidth !== 3 || video.cellHeight !== 4);
  invalid(!Number.isFinite(metadata.fps) || metadata.fps < 1 || metadata.fps > 60 || metadata.chunkFrames !== Math.round(metadata.fps) * 1);
  invalid(!Number.isInteger(metadata.fpsNumerator) || !Number.isInteger(metadata.fpsDenominator) || metadata.fpsNumerator < 1 || metadata.fpsNumerator > 240000 || metadata.fpsDenominator < 1 || metadata.fpsDenominator > 10000 || metadata.fps !== metadata.fpsNumerator / metadata.fpsDenominator);
  invalid(!Number.isInteger(metadata.frames) || metadata.frames < 1 || metadata.frames > 1296000 || !Number.isFinite(metadata.duration) || metadata.duration > 21600 || metadata.duration <= 0);
  invalid(!Array.isArray(metadata.qualities) || metadata.qualities.length < 1 || metadata.qualities.length > 6);
  const qualities = new Map();
  for (const quality of metadata.qualities) {
    invalid(!Number.isInteger(quality.height) || quality.height < 4 || quality.height > 1080 || qualities.has(quality.height));
    invalid(!Number.isInteger(quality.columns) || quality.columns < 1 || quality.columns > 4096 || !Number.isInteger(quality.rows) || quality.rows !== quality.height || quality.columns % 3 || quality.rows % 4 || quality.columns * quality.rows > 4423680);
    qualities.set(quality.height, quality);
  }
  invalid(Boolean(header.audio) !== Boolean(metadata.audio));
  if (metadata.audio) invalid(metadata.audio.codec !== 'opus' || metadata.audio.sampleRate !== 48000 || metadata.audio.channels !== 2);
  const chunks = metadata.chunks;
  invalid(!Number.isInteger(chunks) || chunks < 1 || chunks > metadata.frames || (metadata.timebase !== 1000000 || metadata.chunkSeconds !== 1));
  invalid(header.count !== chunks * (qualities.size + header.audio) || bytes.byteLength !== header.count * recordBytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const records = new Map();
  let previousEnd = header.indexOffset + header.count * recordBytes;
  const counters = new Map();
  for (let i = 0; i < header.count; i++) {
    const offset = i * recordBytes;
    const record = {
      version: header.version,
      quality: view.getUint16(offset, true), columns: view.getUint16(offset + 2, true), rows: view.getUint16(offset + 4, true),
      frames: view.getUint16(offset + 6, true), first: view.getUint32(offset + 8, true), decoded: view.getUint32(offset + 12, true),
      offset: Number(view.getBigUint64(offset + 16, true)), length: view.getUint32(offset + 24, true), checksum: view.getUint32(offset + 28, true),
    };
    invalid(!Number.isSafeInteger(record.offset) || record.offset < previousEnd || record.length < 1 || record.length > MAX_CHUNK || record.offset + record.length > header.size);
    previousEnd = record.offset + record.length;
    record.fps = metadata.fps;
    record.chunk = counters.get(record.quality) ?? 0;
    counters.set(record.quality, record.chunk + 1);
    record.startUs = Number(view.getBigUint64(offset + 32, true));
    record.endUs = Number(view.getBigUint64(offset + 40, true));
    record.start = record.startUs / 1000000;
    record.end = record.endUs / 1000000;
    invalid(record.first >= metadata.frames);
    invalid((!Number.isSafeInteger(record.startUs) || !Number.isSafeInteger(record.endUs) || record.startUs < 0 || record.endUs <= record.startUs || record.endUs > Math.round(metadata.duration * 1000000) || record.endUs - record.startUs > 2000000));
    const key = `${record.quality}:${record.chunk}`;
    invalid(records.has(key));
    if (record.quality === 0) {
      invalid(!metadata.audio || record.columns || record.rows || record.frames || record.decoded !== (Math.floor(record.endUs * 48000 / 1000000) - Math.floor(record.startUs * 48000 / 1000000)));
    } else {
      const quality = qualities.get(record.quality);
      invalid(!quality || quality.columns !== record.columns || quality.rows !== record.rows || (record.frames < 1 || record.frames > 240));
      invalid(record.decoded !== 0);
    }
    records.set(key, record);
  }
  {
    const firstQuality = metadata.qualities[0].height;
    let first = 0; let end = 0;
    for (let chunk = 0; chunk < chunks; chunk++) {
      const reference = records.get(`${firstQuality}:${chunk}`);
      invalid(!reference || reference.first !== first || reference.startUs !== end);
      for (const height of [...qualities.keys(), ...(metadata.audio ? [0] : [])]) {
        const record = records.get(`${height}:${chunk}`);
        invalid(!record || record.first !== reference.first || record.startUs !== reference.startUs || record.endUs !== reference.endUs || (height && record.frames !== reference.frames));
      }
      first += reference.frames; end = reference.endUs;
    }
    invalid(first !== metadata.frames || end !== Math.round(metadata.duration * 1000000));
  }
  invalid(previousEnd !== header.size);
  return records;
}

export function asciiPackets(bytes, record, cellBytes = 28, format = 28) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = record.columns / 3 * (record.rows / 4);
  const version = record.version ?? 4;
  invalid(![4, 5, 6].includes(version));
  invalid(cellBytes !== 28 || format !== 28 || !Number.isSafeInteger(count) || count < 1 || count > 368640 || !Number.isSafeInteger(record.startUs) || !Number.isSafeInteger(record.endUs) || record.endUs <= record.startUs);
  const packets = [];
  let position = 0;
  let time = record.startUs;
  while (position < bytes.length) {
    invalid(position + 13 > bytes.length);
    const duration = view.getUint32(position, true); position += 4;
    invalid(duration === 0 || duration > 1000000 || time + duration > record.endUs);
    const tag = bytes[position];
    const decoded = view.getUint32(position + 1, true);
    const length = view.getUint32(position + 5, true);
    position += 9;
    invalid(length === 0 || length > MAX_CHUNK || position + length > bytes.length);
    invalid(![4, 5, 6, 7, 8, 9, 10, 11].includes(tag) || ((version === 4 && tag >= 8) || (version === 5 && tag >= 10)) || (packets.length === 0 && [5, 7, 9, 11].includes(tag)) || decoded < 1 || decoded > count * 38 + 1024);
    const sourceFrame = record.first + packets.length;
    packets.push({ sourceFrame, tag, decoded, time: time / 1000000, duration: duration / 1000000, end: (time + duration) / 1000000, bytes: bytes.subarray(position, position + length) });
    time += duration; position += length;
    invalid(packets.length > record.frames);
  }
  invalid(packets.length !== record.frames || time !== record.endUs);
  return packets;
}

export class SciReader {
  constructor(url, audio) {
    this.url = url;
    this.audio = audio;
    this.controller = new AbortController();
    this.cache = new Map();
    this.pending = new Map();
    this.waiting = new Map();
    this.active = new Set();
    this.costs = new Map();
    this.leases = new Map();
    this.cacheWaiters = new Set();
    this.cacheBytes = 0; this.requestBytes = 0;
    this.metrics = { cacheBytes: 0, requestBytes: 0, requests: 0 };
    this.bandwidth = 0;
    this.controller.signal.addEventListener('abort', () => this.close(), { once: true });
  }

  async range(start, length, signal = this.controller.signal) {
    invalid(!Number.isSafeInteger(start) || start<0 || !Number.isInteger(length) || length<1 || length>MAX_CHUNK);
    const begin = performance.now();
    const response = await fetch(this.url, { headers: { Range: `bytes=${start}-${start + length - 1}` }, signal });
    let reader;
    let bytes;
    try {
      invalid(response.status !== 206, 'Server could not deliver this SCI chunk.');
      const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
      invalid(!match || Number(match[1]) !== start || Number(match[2]) !== start + length - 1 || (this.header && Number(match[3]) !== this.header.size));
      reader=response.body?.getReader();
      invalid(!reader,'SCI response has no body.');
      bytes=new Uint8Array(length);
      let offset=0;
      while (true) {
        const {value,done}=await reader.read();
        if (done) break;
        invalid(offset+value.length>length,'SCI response exceeds its byte range.');
        bytes.set(value,offset);offset+=value.length;
      }
      invalid(offset!==length,'SCI response is truncated.');
    } catch (error) {
      try {if (reader) await reader.cancel();else await response.body?.cancel();}
      finally {throw error;}
    } finally {reader?.releaseLock();}
    const rate = length * 8000 / Math.max(1, performance.now() - begin);
    this.bandwidth = this.bandwidth ? this.bandwidth * 0.7 + rate * 0.3 : rate;
    return bytes;
  }

  async open() {
    this.header = parseHeader(await this.range(0, 32));
    this.metadata = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await this.range(32, this.header.metadataLength)));
    this.records = parseIndex(await this.range(this.header.indexOffset, this.header.count * this.header.recordBytes), this.header, this.metadata);
    this.timelines = new Map(this.metadata.qualities.map(quality => [quality.height, Array.from({ length: this.metadata.chunks }, (_, chunk) => this.records.get(`${quality.height}:${chunk}`))]));
    return this.metadata;
  }

  recordAt(quality, position) {
    const records = this.timelines.get(quality);
    let low = 0; let high = records.length;
    while (low + 1 < high) { const middle = Math.floor((low + high) / 2); if (records[middle].start <= position) low = middle; else high = middle; }
    return records[low];
  }

  get(quality, chunk) {
    const key=`${quality}:${chunk}`;
    const value=this.cache.get(key);
    if (value) {this.cache.delete(key);this.cache.set(key,value);}
    return value;
  }

  retain(quality, chunk) {
    const key = `${quality}:${chunk}`;
    const value = this.get(quality, chunk);
    if (!value) return null;
    this.leases.set(key, (this.leases.get(key) ?? 0) + 1);
    let released = false;
    return { value, release: () => {
      if (released) return;
      released = true;
      const count = (this.leases.get(key) ?? 1) - 1;
      if (count) this.leases.set(key, count); else this.leases.delete(key);
      if (this.window && !this.inWindow(key)) this.remove(key);
      this.wakeCache();
    } };
  }

  inWindow(key) {
    if (!this.window) return true;
    const [quality, chunk] = key.split(':').map(Number);
    return (quality === 0 || quality === this.window.quality) && chunk >= this.window.first && chunk <= this.window.last;
  }

  remove(key) {
    if (this.leases.has(key)) return false;
    if (this.cache.delete(key)) { this.cacheBytes -= this.costs.get(key); this.costs.delete(key); }
    return true;
  }

  wakeCache() { for (const resolve of this.cacheWaiters) resolve(); this.cacheWaiters.clear(); }

  makeRoom(cost) {
    while (this.cacheBytes + cost > CACHE_BYTES || this.cache.size >= MAX_RECORDS) {
      const key = [...this.cache.keys()].find(key => !this.leases.has(key) && !this.inWindow(key)) ?? [...this.cache.keys()].find(key => !this.leases.has(key));
      if (key === undefined) return false;
      this.remove(key);
    }
    return true;
  }

  async publish(entry, value, cost) {
    invalid(cost > CACHE_BYTES, 'SCI decoded chunk exceeds its cache budget.');
    while (true) {
      if (entry.controller.signal.aborted || this.closed) throw new DOMException('Stream closed.', 'AbortError');
      if (this.makeRoom(cost)) break;
      await new Promise(resolve => {
        const wake = () => { this.cacheWaiters.delete(wake); entry.controller.signal.removeEventListener('abort', wake); resolve(); };
        this.cacheWaiters.add(wake); entry.controller.signal.addEventListener('abort', wake, { once: true });
      });
    }
    this.cache.set(entry.key, value); this.costs.set(entry.key, cost); this.cacheBytes += cost;
    this.metrics.cacheBytes = Math.max(this.metrics.cacheBytes, this.cacheBytes);
    return value;
  }

  load(quality, chunk) {
    if (this.closed || this.controller.signal.aborted) return Promise.reject(new DOMException('Stream closed.', 'AbortError'));
    const key = `${quality}:${chunk}`;
    if (this.cache.has(key)) return Promise.resolve(this.get(quality, chunk));
    const existing = this.pending.get(key) ?? this.waiting.get(key);
    if (existing) return existing.promise;
    const record = this.records.get(key);
    if (!record) return Promise.reject(new Error('SCI chunk is missing.'));
    if (this.pending.size + this.waiting.size >= MAX_RECORDS) return Promise.reject(new Error('SCI request queue limit exceeded.'));
    const entry = { key, quality, record, controller: new AbortController() };
    entry.cost = record.length * (quality ? 1 : 2) + (quality ? 0 : audioBytes(record, this.audio.sampleRate));
    if (entry.cost > REQUEST_BYTES) return Promise.reject(new Error('SCI request exceeds its reservation budget.'));
    entry.promise = new Promise((resolve, reject) => { entry.resolve = resolve; entry.reject = reject; });
    entry.abort = () => {
      if (this.waiting.get(key) === entry) {
        this.waiting.delete(key); entry.reject(new DOMException('Stream closed.', 'AbortError'));
      }
      if (this.pending.get(key) === entry) this.pending.delete(key);
    };
    entry.controller.signal.addEventListener('abort', entry.abort, { once: true });
    this.waiting.set(key, entry); this.drain();
    return entry.promise;
  }

  drain() {
    if (this.closed) return;
    while (this.active.size < MAX_REQUESTS) {
      const entry = [...this.waiting.values()].find(entry => this.requestBytes + entry.cost <= REQUEST_BYTES);
      if (!entry) return;
      this.waiting.delete(entry.key); this.pending.set(entry.key, entry); this.active.add(entry); this.requestBytes += entry.cost;
      this.metrics.requestBytes = Math.max(this.metrics.requestBytes, this.requestBytes);
      this.metrics.requests = Math.max(this.metrics.requests, this.active.size);
      this.readEntry(entry).then(entry.resolve, entry.reject).finally(() => {
        this.active.delete(entry); this.requestBytes -= entry.cost;
        entry.controller.signal.removeEventListener('abort', entry.abort);
        if (this.pending.get(entry.key) === entry) this.pending.delete(entry.key);
        this.drain();
      });
    }
  }

  async readEntry(entry) {
    const { record, quality } = entry;
    let bytes = await this.range(record.offset, record.length, entry.controller.signal);
    if (typeof Worker === 'function') {
      if (!this.verifier || this.verifier.closed) { this.verifier = new IntegrityVerifier(); this.metrics.integrity = this.verifier.metrics; }
      bytes = await this.verifier.verify(bytes, record.checksum, entry.controller.signal);
    } else invalid(crc32(bytes) !== record.checksum, 'SCI chunk checksum failed.');
    if (entry.controller.signal.aborted || this.closed) throw new DOMException('Stream closed.', 'AbortError');
    if (quality) return this.publish(entry, asciiPackets(bytes, record, this.metadata.video.cellBytes, codecFormat(this.metadata.video)), record.length);
    validateOpus(bytes, record.decoded);
    const value = await this.audio.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const expected = record.decoded / 48000;
    invalid(!Number.isFinite(value.duration) || Math.abs(value.duration - expected) > 0.06 || value.numberOfChannels !== 2 || !Number.isInteger(value.length) || value.length < 1 || value.sampleRate !== this.audio.sampleRate || value.length * 8 > audioBytes(record, value.sampleRate), 'SCI audio decoder returned an unexpected duration or layout.');
    return this.publish(entry, value, value.length * 8);
  }

  trim(chunk, quality, cancel = false, last = chunk + 1) {
    this.window = { quality, first: chunk, last };
    for (const key of this.cache.keys()) if (!this.inWindow(key)) this.remove(key);
    if (cancel) for (const entry of [...this.active, ...this.waiting.values()]) if (!this.inWindow(entry.key)) entry.controller.abort();
    this.wakeCache(); this.drain();
  }

  close() {
    if (this.closed) return;
    this.closed = true; this.controller.abort();
    for (const entry of [...this.active, ...this.waiting.values()]) entry.controller.abort();
    this.verifier?.close(); this.wakeCache();
    this.cache.clear(); this.costs.clear(); this.leases.clear(); this.cacheBytes = 0;
    this.pending.clear(); this.waiting.clear();
  }
}
