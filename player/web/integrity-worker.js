import { crc32 } from './checksum.js';

self.onmessage = ({ data }) => {
  const started = performance.now();
  try {
    if (!(data.bytes instanceof Uint8Array) || data.bytes.length < 1 || data.bytes.length > 16 * 1024 * 1024 || crc32(data.bytes) !== data.checksum) throw new Error('SCI chunk checksum failed.');
    self.postMessage({ id: data.id, milliseconds: performance.now() - started, bytes: data.bytes }, [data.bytes.buffer]);
  } catch (error) { self.postMessage({ id: data.id, milliseconds: performance.now() - started, error: error.message }); }
};
