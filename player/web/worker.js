export class WorkerDecoder {
  constructor({ gpu = true, nativeInflation = false, deferredRendering = false, automaticRenderer = false, module } = {}) {
    this.gpu = gpu; this.nativeInflation = nativeInflation; this.module = module; this.deferredRendering = deferredRendering; this.automaticRenderer = automaticRenderer;
    this.worker = new Worker(new URL('./decoder-worker.js', import.meta.url), { type: 'module' });
    this.pending = new Map();
    this.sequence = 0;
    this.worker.onmessage = ({ data }) => {
      const pending = this.pending.get(data.id);
      if (!pending) { data.bitmap?.close(); return; }
      this.pending.delete(data.id);
      if (data.error) pending.reject(new Error(data.error));
      else {
        this.memoryBytes = data.memoryBytes;
        if (pending.preparing) {
          data.bitmap?.close();
          if (data.prepared !== true) pending.reject(new Error('SCI worker did not prepare its decoder.'));
          else pending.resolve();
          return;
        }
        const expected = pending.renderDecision;
        if (expected && ['epoch', 'sourceFrame', 'width', 'height', 'format', 'gpu', 'releaseGpu'].some(key => data.renderDecision?.[key] !== expected[key])) {
          data.bitmap?.close(); pending.reject(new Error('SCI renderer result ownership does not match its request.')); return;
        }
        const receivedAt = performance.timeOrigin + performance.now();
        const deliveryMilliseconds = Number.isFinite(data.producedAt) ? receivedAt - data.producedAt : NaN;
        pending.resolve({ pixels: data.pixels, bitmap: data.bitmap, renderer: data.renderer, gpuFailure: data.gpuFailure, timing: data.timing, memoryBytes: data.memoryBytes, consumed: data.consumed, gpuMetrics: data.gpuMetrics, renderDecision: data.renderDecision, renderWorkload: data.renderWorkload, deliveryMilliseconds, producedAt: data.producedAt, receivedAt });
      }
    };
    this.worker.onerror = event => this.close(new Error(event.message || 'SCI decoder worker failed.'));
  }

  decode(packet, width, height, cellBytes, reset, font, present = true, renderDecision) {
    if (this.closed) return Promise.reject(new DOMException('Stream closed.', 'AbortError'));
    if (!(packet?.bytes instanceof Uint8Array) || packet.bytes.length < 1 || packet.bytes.length > 16 * 1024 * 1024) return Promise.reject(new Error('Invalid SCI decoder input.'));
    if (this.automaticRenderer) {
      if (!renderDecision || typeof renderDecision.gpu !== 'boolean' || typeof renderDecision.releaseGpu !== 'boolean' || !Number.isSafeInteger(renderDecision.epoch) || renderDecision.epoch < -1
        || !Number.isSafeInteger(renderDecision.sourceFrame) || renderDecision.sourceFrame < 0 || renderDecision.sourceFrame !== packet.sourceFrame || renderDecision.width !== width || renderDecision.height !== height || renderDecision.format !== cellBytes) return Promise.reject(new Error('Invalid SCI renderer decision ownership.'));
      renderDecision = { ...renderDecision };
    } else if (renderDecision !== undefined) return Promise.reject(new Error('Fixed SCI renderer received an automatic decision.'));
    return this.#send({ type: 'decode', packet, width, height, cellBytes, reset, font, present, renderDecision });
  }

  prepare(width, height) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 3 || height < 4 || width > 4096 || height > 1080 || width % 3 || height % 4) return Promise.reject(new Error('Invalid SCI decoder dimensions.'));
    return this.#send({ type: 'prepare', width, height });
  }

  #send(request) {
    if (this.closed) return Promise.reject(new DOMException('Stream closed.', 'AbortError'));
    if (this.pending.size >= 8) return Promise.reject(new Error('SCI decoder queue limit exceeded.'));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      this.pending.set(id, { resolve, reject, renderDecision: request.renderDecision, preparing: request.type === 'prepare' });
      try {
        const message = { ...request, id, automaticRenderer: this.automaticRenderer, deferredRendering: this.deferredRendering, module: this.module, gpu: this.gpu, nativeInflation: this.nativeInflation };
        const transfers = [];
        if (request.packet) {
          const bytes = request.packet.bytes.slice();
          message.packet = { ...request.packet, bytes }; transfers.push(bytes.buffer);
        }
        this.worker.postMessage(message, transfers);
        this.module = undefined;
      } catch (error) { this.pending.delete(id); reject(error); }
    });
  }

  close(error = new DOMException('Stream closed.', 'AbortError')) {
    this.closed = true;
    this.worker.terminate();
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
