export class Decoder {
  constructor(exports) {
    this.exports = exports; this.busy = false; this.cellConfiguration = null;
    this.supportsPaintedPlan = ['dirty_plan', 'dirty_flags', 'dirty_changed_cells', 'dirty_rectangles', 'dirty_rectangles_length', 'commit_painted'].every(name => typeof exports[name] === 'function');
  }

  static async open(bytes) {
    const result = await WebAssembly.instantiate(bytes, {});
    return new Decoder((result.instance ?? result).exports);
  }

  decode(packet, width, height, format, reset = false, font = 'ascii-3x4-v2', copyOutput = true) {
    if (this.busy) throw new Error('SCI decoder already has a pending frame.');
    const pointer = this.exports.reserve(packet.bytes.length);
    if (!pointer) throw new Error('Invalid SCI decoder input.');
    new Uint8Array(this.exports.memory.buffer, pointer, packet.bytes.length).set(packet.bytes);
    return this.finish('decode', packet, width, height, format, reset, font, copyOutput);
  }

  decodeCells(packet, width, height, format, reset = false, font = 'ascii-3x4-v2', copyOutput = true) {
    if (this.busy) throw new Error('SCI decoder already has a pending frame.');
    const pointer = this.exports.reserve(packet.bytes.length);
    if (!pointer) throw new Error('Invalid SCI decoder input.');
    new Uint8Array(this.exports.memory.buffer, pointer, packet.bytes.length).set(packet.bytes);
    return this.finish('decode_cells', packet, width, height, format, reset, font, copyOutput);
  }

  decodeCellsNative(packet, width, height, format, reset = false, font = 'ascii-3x4-v2', copyOutput = true) {
    return this.decodeNative(packet, width, height, format, reset, font, copyOutput, true);
  }

  async decodeNative(packet, width, height, format, reset = false, font = 'ascii-3x4-v2', copyOutput = true, cellsOnly = false) {
    if (!this.exports.decode_expanded || typeof DecompressionStream !== 'function') return this[cellsOnly ? 'decodeCells' : 'decode'](packet, width, height, format, reset, font, copyOutput);
    if (this.busy) throw new Error('SCI decoder already has a pending frame.');
    const count = width / 3 * (height / 4);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 3 || height < 4 || width > 4096 || height > 1080 || width % 3 || height % 4 || width * height > 4423680 || format !== 28 || !Number.isInteger(packet.decoded) || packet.decoded < 1 || packet.decoded > (count * 38 + 1024) || packet.bytes.length < 1 || packet.bytes.length > 16 * 1024 * 1024) throw new Error('Invalid SCI decoder input.');
    this.busy = true;
    let reader;
    try {
      const pointer = this.exports.reserve(packet.decoded);
      if (!pointer) throw new Error('Invalid SCI decoder input.');
      const output = new Uint8Array(this.exports.memory.buffer, pointer, packet.decoded);
      reader = new Blob([packet.bytes]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
      let position = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (position + value.length > output.length) throw new Error('SCI packet exceeds its declared length.');
        output.set(value, position); position += value.length;
      }
      if (position !== output.length) throw new Error('SCI packet does not match its declared length.');
      return this.finish(cellsOnly ? 'decode_cells_expanded' : 'decode_expanded', packet, width, height, format, reset, font, copyOutput);
    } finally {
      if (reader) { try { await reader.cancel(); } catch {} reader.releaseLock(); }
      this.busy = false;
    }
  }

  renderCurrentCells(width, height, copyOutput = true) {
    if (this.busy) throw new Error('SCI decoder already has a pending frame.');
    const exports = this.exports;
    if (!exports.render_current_cells()) throw new Error(new TextDecoder().decode(new Uint8Array(exports.memory.buffer, exports.error(), exports.error_length())));
    if (exports.pixels_length() !== width * height * 4) throw new Error('SCI decoder returned invalid pixels.');
    const pixels = new Uint8ClampedArray(exports.memory.buffer, exports.pixels(), exports.pixels_length());
    return copyOutput ? pixels.slice() : pixels;
  }

  currentCells(width, height, format, copyOutput = true) {
    if (this.busy) throw new Error('SCI decoder already has a pending frame.');
    const configuration = this.cellConfiguration;
    if (!configuration || configuration.width !== width || configuration.height !== height || configuration.format !== format) throw new Error('SCI cells do not match the current decoder configuration.');
    return this.#currentCells(width, height, format, copyOutput);
  }

  #currentCells(width, height, format, copyOutput) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 3 || height < 4 || width > 4096 || height > 1080 || width % 3 || height % 4 || width * height > 4423680 || format !== 28) throw new Error('Invalid SCI cell dimensions.');
    const length = width / 3 * (height / 4) * 28;
    if (!Number.isSafeInteger(length) || length < 1 || this.exports.frame_length() !== length) throw new Error('SCI decoder returned invalid cells.');
    // Borrowed cells are read-only and remain valid only until the next decoder call.
    const cells = new Uint8Array(this.exports.memory.buffer, this.exports.frame(), length);
    return copyOutput ? cells.slice() : cells;
  }

  paintedPlan() {
    if (this.busy) throw new Error('SCI decoder already has a pending frame.');
    if (!this.supportsPaintedPlan) return undefined;
    const exports = this.exports;
    if (!exports.dirty_plan()) throw new Error(new TextDecoder().decode(new Uint8Array(exports.memory.buffer, exports.error(), exports.error_length())));
    const length = exports.dirty_rectangles_length();
    const flags = exports.dirty_flags() >>> 0;
    if (!Number.isInteger(length) || length < 0 || length > 128 || length % 4 || flags > 1) throw new Error('SCI decoder returned an invalid painted plan.');
    const words = new Uint32Array(exports.memory.buffer, exports.dirty_rectangles(), length);
    const rectangles = [];
    for (let index = 0; index < words.length; index += 4) rectangles.push({ x: words[index], y: words[index + 1], width: words[index + 2], height: words[index + 3] });
    const changed = exports.dirty_changed_cells() >>> 0;
    return { full: Boolean(flags), changed: changed === 0xffffffff ? null : changed, rectangles };
  }

  commitPainted() {
    if (this.busy) throw new Error('SCI decoder already has a pending frame.');
    if (!this.supportsPaintedPlan) return;
    const exports = this.exports;
    if (!exports.commit_painted()) throw new Error(new TextDecoder().decode(new Uint8Array(exports.memory.buffer, exports.error(), exports.error_length())));
  }

  finish(method, packet, width, height, format, reset, font, copyOutput) {
    const exports = this.exports;
    if (!exports[method](width, height, format, font === 'ascii-3x4-v2' ? 1 : 2, packet.tag, packet.decoded, Number(reset))) {
      this.cellConfiguration = null;
      throw new Error(new TextDecoder().decode(new Uint8Array(exports.memory.buffer, exports.error(), exports.error_length())));
    }
    this.cellConfiguration = method.startsWith('decode_cells') ? { width, height, format } : null;
    if (method.startsWith('decode_cells')) {
      return this.#currentCells(width, height, format, copyOutput);
    }
    if (exports.pixels_length() !== width * height * 4) throw new Error('SCI decoder returned invalid pixels.');
    // A borrowed view remains valid only until the next decoder call.
    const pixels = new Uint8ClampedArray(exports.memory.buffer, exports.pixels(), exports.pixels_length());
    return copyOutput ? pixels.slice() : pixels;
  }
}
