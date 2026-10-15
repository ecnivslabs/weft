import { Decoder } from './wasm.js';

export class FrameDecoder {
  constructor(decoder, { gpu = true, nativeInflation = false, deferredRendering = false, automaticRenderer = false } = {}) {
    this.decoder = decoder;
    this.preferGpu = gpu && typeof decoder.exports.decode_cells === 'function' && typeof decoder.exports.render_current_cells === 'function';
    this.nativeInflation = nativeInflation; this.deferredRendering = deferredRendering;
    this.automaticRenderer = automaticRenderer;
    this.gpuAttempted = false;
    this.cellOutput = false;
    this.busy = false;
    this.closed = false;
  }

  selectRenderer(decision, packet, width, height, format) {
    if (!this.automaticRenderer) {
      if (decision !== undefined) throw new Error('Fixed SCI renderer received an automatic decision.');
      return;
    }
    if (!decision || typeof decision.gpu !== 'boolean' || typeof decision.releaseGpu !== 'boolean' || !Number.isSafeInteger(decision.epoch) || decision.epoch < -1
      || !Number.isSafeInteger(decision.sourceFrame) || decision.sourceFrame < 0 || decision.sourceFrame !== packet.sourceFrame || decision.width !== width || decision.height !== height || decision.format !== format) throw new Error('Invalid SCI renderer decision ownership.');
    if (!decision.gpu) {
      this.gpuNeedsSync = true;
      if (decision.releaseGpu) { this.gpu?.close(); this.gpu = null; }
    } else if (!this.preferGpu && !this.gpu) this.gpuAttempted = false;
    this.preferGpu = decision.gpu && typeof this.decoder.exports.decode_cells === 'function' && typeof this.decoder.exports.render_current_cells === 'function';
  }

  async decode(packet, width, height, format, reset, font, present = true, renderDecision) {
    if (this.closed) throw new DOMException('Stream closed.', 'AbortError');
    if (this.busy) throw new Error('SCI frame decoder already has a pending frame.');
    if (format !== 28) throw new Error('Unsupported SCI representation.');
    const initializingAt = performance.now();
    this.selectRenderer(renderDecision, packet, width, height, format);
    this.busy = true;
    try {
      const offscreen = typeof OffscreenCanvas === 'function';
      if (!this.gpuAttempted && this.preferGpu && offscreen) {
        this.gpuAttempted = true;
        try {
          const { AsciiGpu } = await import('./gpu.js');
          this.gpu = new AsciiGpu(new OffscreenCanvas(width, height));
          this.gpuFailure = undefined;
          this.cellOutput = true;
        } catch (error) { this.gpuFailure = error.message || 'ASCII GPU reconstruction is unavailable.'; this.gpu = null; }
      }
      const initializationMilliseconds = performance.now() - initializingAt;
      if (this.closed) throw new DOMException('Stream closed.', 'AbortError');
      if (this.deferredRendering && typeof this.decoder.exports.render_current_cells === 'function') this.cellOutput = true;
      if (!present && !this.cellOutput) throw new Error('Deferred presentation requires ASCII composition cell output.');
      let pixels;
      let plan;
      const started = performance.now();
      let decodedAt;
      const result = frame => {
        const covered = plan?.rectangles.reduce((sum, rectangle) => sum + rectangle.width * rectangle.height, 0) ?? 0;
        const renderWorkload = !plan || plan.full ? 'full' : plan.changed === 0 ? 'same' : covered < width / 3 * (height / 4) / 8 ? 'sparse' : 'partial';
        return { ...frame, renderDecision, renderWorkload, producedAt: performance.timeOrigin + performance.now(), timing: { decoderMilliseconds: (decodedAt ?? performance.now()) - started, reconstructionMilliseconds: decodedAt === undefined ? 0 : performance.now() - decodedAt, initializationMilliseconds, cellsOnly: this.cellOutput }, memoryBytes: this.decoder.exports.memory.buffer.byteLength };
      };
      const presented = frame => {
        try { if (plan) this.decoder.commitPainted(); }
        catch (error) { frame.bitmap?.close(); throw error; }
        return result(frame);
      };
      if (this.cellOutput) {
        let cells = await this.decoder[this.nativeInflation ? 'decodeCellsNative' : 'decodeCells'](packet, width, height, format, reset, font, false);
        decodedAt = performance.now();
        if (this.closed) throw new DOMException('Stream closed.', 'AbortError');
        if (!present) return result({ consumed: true, renderer: 'cells' });
        plan = this.decoder.paintedPlan();
        if (plan) cells = this.decoder.currentCells(width, height, format, false);
        if (this.gpu && this.preferGpu) {
          let bitmap;
          try {
            const synchronized = this.gpuNeedsSync ? { full: true, changed: null, rectangles: [{ x: 0, y: 0, width: width / 3, height: height / 4 }] } : plan;
            this.gpu.draw(cells, width, height, synchronized);
            bitmap = this.gpu.canvas.transferToImageBitmap();
            this.gpuNeedsSync = false;
          } catch (error) {
            this.gpuFailure = error.message;
            this.gpu.close(); this.gpu = null;
          }
          if (bitmap) return presented({ bitmap, renderer: 'webgl2', gpuMetrics: this.gpu.metrics });
        }
        pixels = this.decoder.renderCurrentCells(width, height, !offscreen);
      } else { pixels = await this.decoder[this.nativeInflation ? 'decodeNative' : 'decode'](packet, width, height, format, reset, font, !offscreen); decodedAt = performance.now(); }
      if (this.closed) throw new DOMException('Stream closed.', 'AbortError');
      if (offscreen) {
        if (!this.canvas || this.canvas.width !== width || this.canvas.height !== height) this.canvas = new OffscreenCanvas(width, height);
        this.canvas.getContext('2d', { alpha: false }).putImageData(new ImageData(pixels, width, height), 0, 0);
        return presented({ bitmap: this.canvas.transferToImageBitmap(), renderer: 'canvas2d', gpuFailure: this.preferGpu ? this.gpuFailure : undefined });
      }
      return presented({ pixels, renderer: 'rgba', gpuFailure: this.preferGpu ? this.gpuFailure : undefined });
    } finally {
      this.busy = false;
      if (this.closed) { this.gpu?.close(); this.gpu = null; this.canvas = null; this.decoder.exports.reset(); }
    }
  }

  close() {
    this.closed = true;
    this.gpu?.close(); this.gpu = null; this.canvas = null;
    if (!this.busy) this.decoder.exports.reset();
  }
}

if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
  let manager;
  let queue = Promise.resolve();
  async function decode(data) {
    try {
      if (!manager) {
        let module = data.module;
        if (!module) {
          const response = await fetch('./decoder.wasm');
          if (!response.ok) throw new Error('SCI decoder is missing. Run npm run build --prefix player.');
          module = await response.arrayBuffer();
        }
        manager = new FrameDecoder(await Decoder.open(module), { gpu: data.gpu, nativeInflation: data.nativeInflation, deferredRendering: data.deferredRendering, automaticRenderer: data.automaticRenderer });
      }
      const frame = await manager.decode(data.packet, data.width, data.height, data.cellBytes, data.reset, data.font, data.present, data.renderDecision);
      self.postMessage({ id: data.id, ...frame }, frame.bitmap ? [frame.bitmap] : frame.pixels ? [frame.pixels.buffer] : []);
    } catch (error) { self.postMessage({ id: data.id, error: error.message }); }
  }
  self.onmessage = ({ data }) => { queue = queue.then(() => decode(data)); };
}
