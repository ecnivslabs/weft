const table = new Uint32Array(256).map((_, index) => {
  let value = index << 24;
  for (let bit = 0; bit < 8; bit++) value = value & 0x80000000 ? (value << 1) ^ 0x04c11db7 : value << 1;
  return value >>> 0;
});

function invalid(condition) { if (condition) throw new Error('Invalid or oversized SCI Opus audio.'); }
function text(bytes) { return new TextDecoder().decode(bytes); }

export function validateOpus(bytes, expected) {
  invalid(!Number.isInteger(expected) || expected < 1 || expected > 144000 || bytes.length > 16 * 1024 * 1024);
  let offset = 0; let serial; let sequence = 0; let packet = []; let headers = 0;
  let samples = 0; let skip = 0; let ended = false;
  while (offset < bytes.length) {
    invalid(ended || offset + 27 > bytes.length);
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, bytes.length - offset);
    invalid(text(bytes.subarray(offset, offset + 4)) !== 'OggS' || view.getUint8(4) !== 0);
    const flags = view.getUint8(5); const segments = view.getUint8(26);
    invalid(flags > 7 || offset + 27 + segments > bytes.length || Boolean(flags & 1) !== Boolean(packet.length));
    const stream = view.getUint32(14, true);
    if (serial === undefined) serial = stream;
    invalid(stream !== serial || view.getUint32(18, true) !== sequence++ || Boolean(flags & 2) !== (sequence === 1));
    const laces = bytes.subarray(offset + 27, offset + 27 + segments);
    const size = 27 + segments + laces.reduce((sum, size) => sum + size, 0);
    invalid(offset + size > bytes.length);
    let checksum = 0;
    for (let i = 0; i < size; i++) {
      const byte = i >= 22 && i < 26 ? 0 : bytes[offset + i];
      checksum = (checksum << 8) ^ table[((checksum >>> 24) ^ byte) & 255];
    }
    invalid((checksum >>> 0) !== view.getUint32(22, true));
    let cursor = offset + 27 + segments;
    for (const length of laces) {
      for (let i = 0; i < length; i++) packet.push(bytes[cursor++]);
      invalid(packet.length > 65536);
      if (length === 255) continue;
      if (headers === 0) {
        invalid(packet.length !== 19 || text(Uint8Array.from(packet.slice(0, 8))) !== 'OpusHead' || packet[8] !== 1 || packet[9] !== 2 || packet[18] !== 0);
        skip = packet[10] | packet[11] << 8; headers++;
      } else if (headers === 1) {
        invalid(packet.length < 16 || text(Uint8Array.from(packet.slice(0, 8))) !== 'OpusTags'); headers++;
      } else {
        invalid(packet.length === 0);
        const configuration = packet[0] >>> 3;
        const frame = configuration >= 16 ? 120 * 2 ** (configuration & 3) : configuration >= 12 ? 480 * 2 ** (configuration & 1) : [480, 960, 1920, 2880][configuration & 3];
        const code = packet[0] & 3;
        invalid(code === 3 && packet.length < 2);
        const count = code === 0 ? 1 : code === 3 ? packet[1] & 63 : 2;
        invalid(count === 0 || frame * count > 5760);
        samples += frame * count;
        invalid(samples > expected + skip + 5760);
      }
      packet = [];
    }
    const granule = view.getBigUint64(6, true);
    if (granule !== 0xffffffffffffffffn) invalid(granule > BigInt(expected + skip + 5760));
    if (flags & 4) {
      invalid(packet.length !== 0 || granule !== BigInt(expected + skip) || samples < expected + skip);
      ended = true;
    }
    offset += size;
  }
  invalid(!ended || headers !== 2);
}
