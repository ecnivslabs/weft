const crcTable = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
const crcTables = [crcTable, ...Array.from({ length: 7 }, () => new Uint32Array(256))];
for (let index = 0; index < 256; index++) {
  let value = crcTable[index];
  for (let slice = 1; slice < 8; slice++) {
    value = crcTable[value & 255] ^ (value >>> 8);
    crcTables[slice][index] = value >>> 0;
  }
}

export function crc32(bytes) {
  let crc = 0xffffffff;
  let index = 0;
  const end = bytes.length - bytes.length % 8;
  const [t0, t1, t2, t3, t4, t5, t6, t7] = crcTables;
  while (index < end) {
    crc ^= bytes[index] | bytes[index + 1] << 8 | bytes[index + 2] << 16 | bytes[index + 3] << 24;
    crc = t7[crc & 255] ^ t6[crc >>> 8 & 255] ^ t5[crc >>> 16 & 255] ^ t4[crc >>> 24]
      ^ t3[bytes[index + 4]] ^ t2[bytes[index + 5]] ^ t1[bytes[index + 6]] ^ t0[bytes[index + 7]];
    index += 8;
  }
  while (index < bytes.length) crc = t0[(crc ^ bytes[index++]) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export class IntegrityVerifier {
  constructor() {
    this.worker = new Worker(new URL('./integrity-worker.js', import.meta.url), { type: 'module' });
    this.pending = new Map(); this.bytes = 0; this.sequence = 0;
    this.metrics = { verifiedBytes: 0, workerMilliseconds: 0, roundTripMilliseconds: 0 };
    this.worker.onmessage = ({ data }) => {
      const entry = this.pending.get(data.id);
      if (!entry) return;
      this.pending.delete(data.id); this.bytes -= entry.length;
      this.metrics.roundTripMilliseconds += performance.now() - entry.started;
      if (Number.isFinite(data.milliseconds) && data.milliseconds >= 0) this.metrics.workerMilliseconds += data.milliseconds;
      if (!data.error) this.metrics.verifiedBytes += entry.length;
      if (entry.signal.aborted) entry.reject(new DOMException('Stream closed.', 'AbortError'));
      else if (data.error) entry.reject(new Error(data.error));
      else if (!(data.bytes instanceof Uint8Array) || data.bytes.length !== entry.length) entry.reject(new Error('SCI integrity worker returned an invalid buffer.'));
      else entry.resolve(data.bytes);
    };
    this.worker.onerror = event => this.close(new Error(event.message || 'SCI integrity worker failed.'));
  }

  verify(bytes, checksum, signal) {
    if (this.closed || signal.aborted) return Promise.reject(new DOMException('Stream closed.', 'AbortError'));
    if (!(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > 16 * 1024 * 1024 || bytes.byteOffset !== 0 || bytes.buffer.byteLength !== bytes.length || !Number.isInteger(checksum) || checksum < 0 || checksum > 0xffffffff || this.pending.size >= 8 || this.bytes + bytes.length > 48 * 1024 * 1024) return Promise.reject(new Error('SCI integrity reservation limit exceeded.'));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence; const length = bytes.length;
      this.pending.set(id, { resolve, reject, signal, length, started: performance.now() }); this.bytes += length;
      try { this.worker.postMessage({ id, bytes, checksum }, [bytes.buffer]); }
      catch (error) { this.pending.delete(id); this.bytes -= length; reject(error); }
    });
  }

  close(error = new DOMException('Stream closed.', 'AbortError')) {
    this.closed = true; this.worker.terminate();
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear(); this.bytes = 0;
  }
}
