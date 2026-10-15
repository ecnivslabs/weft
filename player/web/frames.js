import { DecoderPool, decoderModule, partition } from './decode-pool.js';
import { FRAME_BYTES, MAX_FRAME_EVENTS, decoderCount, shouldPaint } from './delivery.js';
import { codecFormat } from './sci.js';
import { RendererPolicy, rendererOptions } from './calibration.js';

export class AsciiFrames {
  constructor(reader, quality, renderer, fail, advance = () => {}, options = {}) {
    this.decoderOptions = rendererOptions(options);
    this.reader = reader;
    this.metadata = reader.metadata;
    this.quality = quality;
    this.renderer = renderer;
    this.fail = fail; this.advance = advance;
    this.queue = [];
    this.queueBytes = 0;
    this.closed = false;
    this.position = 0;
    this.displayedEnd = -1;
    this.completed = new Map(); this.consumedEnd = -Infinity;
    this.reservations = 0; this.reservedBytes = 0; this.inflight = new Map(); this.displayRate = Infinity; this.leases = new Set();
    this.metrics = { decoded: 0, dropped: 0, consumed: 0, lateDecoded: 0, skippedSeekFrames: 0, discoveredFrames: 0, sourceConsumed: 0, reconstructed: 0, deferred: 0, painted: 0, decodeMilliseconds: 0, frameBytes: 0 };
    this.decodeWallMilliseconds = 0;
    Object.defineProperty(this.metrics, 'decodeWallMilliseconds', { enumerable: true, get: () => this.decodeWallMilliseconds + (this.reservations ? performance.now() - this.busyStarted : 0) });
  }

  async prepare(position, rate = 1) {
    const quality = this.metadata.qualities.find(item => item.height === this.quality);
    this.width = quality.columns;
    this.height = quality.rows;
    this.frameBytes = this.width * this.height * 4;
    this.position = position; this.rate = rate;
    const record = this.reader.recordAt(this.quality, position);
    this.chunk = record.chunk; this.nextOrdinal = record.first ?? 0;
    this.seekChunk = this.chunk; this.seekPosition = position;
    const module = await decoderModule();
    if (this.closed) throw new DOMException('Stream closed.', 'AbortError');
    const workers = decoderCount(this.width, this.height, globalThis.navigator?.hardwareConcurrency);
    if (this.decoderOptions.automaticRenderer) {
      this.policy = new RendererPolicy(workers); this.metrics.rendererPolicy = this.policy.metrics;
    }
    this.pool = new DecoderPool(workers, { module, deferredRendering: true, ...this.decoderOptions, automaticRenderer: Boolean(this.policy) }, {
      decide: (packet, width, height, format, present) => this.policy?.request(packet, width, height, format, present, this.position),
      paint: packet => shouldPaint(packet, this.position, this.metadata.duration, this.metadata.fps, this.rate, this.displayRate, this.displayedEnd < 0),
      reserve: (packet, present) => this.reserve(packet, present),
      release: (packet, present) => {
        this.reservations--; this.reservedBytes -= present ? this.frameBytes : 0;
        this.inflight.delete(packet.sourceFrame);
        if (!this.reservations) this.decodeWallMilliseconds += performance.now() - this.busyStarted;
      },
      accept: (frame, packet, elapsed) => this.accept({ ...frame, width: this.width, height: this.height }, packet, elapsed),
      complete: segment => { if (!--segment.batch.remaining) { segment.batch.lease.release(); this.leases.delete(segment.batch.lease); } },
      fail: error => this.reject(error),
    });
    const preparingAt = performance.now();
    await this.pool.prepare(this.width, this.height);
    this.metrics.decoderPreparationMilliseconds = performance.now() - preparingAt;
    if (this.closed) throw new DOMException('Stream closed.', 'AbortError');
    const ready = new Promise((resolve, reject) => { this.waiter = { resolve, reject }; });
    this.pump(position, rate);
    await ready;
  }

  reserve(packet, present) {
    const future = Number.isSafeInteger(packet.sourceFrame) && packet.sourceFrame > this.nextOrdinal;
    const contiguous = item => item.time < this.consumedEnd && item.end > this.position;
    // Reserve missing frontier work, without reserving its already in-flight image twice.
    const spareEvent = Number(future && !this.inflight.has(this.nextOrdinal));
    const spareQueue = Number(spareEvent && !this.queue.some(contiguous));
    const spareImage = Number(future && !this.inflight.get(this.nextOrdinal) && !this.queue.some(item => item.bytes > 0 && contiguous(item)));
    if (this.completed.size + this.reservations + spareEvent >= MAX_FRAME_EVENTS || this.queue.length + this.reservations + spareQueue >= MAX_FRAME_EVENTS
      || this.queueBytes + this.reservedBytes + (Number(present) + spareImage) * this.frameBytes > FRAME_BYTES) return false;
    if (!this.reservations) this.busyStarted = performance.now();
    this.reservations++; this.reservedBytes += present ? this.frameBytes : 0;
    this.inflight.set(packet.sourceFrame, present);
    return true;
  }

  async catchup(position, rate = 1, lead = 0) {
    if (!Number.isFinite(lead) || lead < 0 || lead > 1) throw new Error('Invalid SCI playback lead.');
    const available = () => this.ready(position) && (lead === 0 || this.consumedEnd >= Math.min(this.metadata.duration, position + lead)
      || this.queue.length >= MAX_FRAME_EVENTS || this.queueBytes + this.frameBytes > FRAME_BYTES);
    if (available()) return;
    this.waiter?.reject(new DOMException('Playback preparation superseded.', 'AbortError'));
    const ready = new Promise((resolve, reject) => { this.waiter = { resolve, reject, available }; });
    this.pump(position, rate);
    await ready;
  }

  shift() {
    const frame = this.queue.shift();
    if (frame) {
      this.queueBytes -= frame.bytes; this.metrics.consumed++;
      const waiting = performance.timeOrigin + performance.now() - frame.frame.receivedAt;
      if (Number.isFinite(waiting) && waiting >= 0) this.metrics.presentationQueueMilliseconds = (this.metrics.presentationQueueMilliseconds ?? 0) + waiting;
    }
    return frame;
  }

  pump(position, rate = this.rate ?? 1) {
    if (this.closed) return;
    this.position = position; this.rate = rate;
    while (this.queue.length && this.queue[0].end <= position) {
      this.shift().frame.bitmap?.close(); this.metrics.dropped++;
    }
    if (!this.pool) return;
    const last = this.reader.window?.last ?? this.chunk;
    while (this.chunk <= last) {
      const lease = this.reader.retain(this.quality, this.chunk);
      if (!lease) break;
      let segments;
      try { segments = partition(lease.value, this.chunk === this.seekChunk ? this.seekPosition : -Infinity); }
      catch (error) { lease.release(); this.reject(error); return; }
      if (this.chunk === this.seekChunk && segments.length) this.nextOrdinal += segments[0].first;
      this.metrics.discoveredFrames += lease.value.length;
      this.metrics.skippedSeekFrames += lease.value.length - segments.reduce((count, segment) => count + segment.last - segment.first, 0);
      if (segments.length) {
        this.leases.add(lease);
        const batch = { lease, remaining: segments.length };
        for (const segment of segments) segment.batch = batch;
        try { this.pool.add(segments); } catch (error) { this.reject(error); return; }
      } else lease.release();
      this.chunk++;
    }
    this.pool.pump(position, position + Math.min(1, 0.25 * rate), this.width, this.height, codecFormat(this.metadata.video), this.metadata.video.font);
  }

  reject(error) {
    this.waiter?.reject(error); this.waiter = null;
    if (!this.closed) { this.close(); this.fail(error); }
  }

  accept(frame, packet, elapsed) {
    this.metrics.decoded++; this.metrics.decodeMilliseconds += elapsed;
    if (frame.timing) {
      this.metrics.decoderMilliseconds = (this.metrics.decoderMilliseconds ?? 0) + frame.timing.decoderMilliseconds;
      this.metrics.reconstructionMilliseconds = (this.metrics.reconstructionMilliseconds ?? 0) + frame.timing.reconstructionMilliseconds;
      if (Number.isFinite(frame.timing.initializationMilliseconds) && frame.timing.initializationMilliseconds >= 0) this.metrics.rendererInitializationMilliseconds = (this.metrics.rendererInitializationMilliseconds ?? 0) + frame.timing.initializationMilliseconds;
    }
    if (Number.isFinite(frame.deliveryMilliseconds) && frame.deliveryMilliseconds >= 0) this.metrics.workerDeliveryMilliseconds = (this.metrics.workerDeliveryMilliseconds ?? 0) + frame.deliveryMilliseconds;
    if (frame.gpuMetrics) {
      this.metrics.uploadedAttributeBytes = (this.metrics.uploadedAttributeBytes ?? 0) + frame.gpuMetrics.uploadedBytes;
      this.metrics.reconstructedPixels = (this.metrics.reconstructedPixels ?? 0) + frame.gpuMetrics.reconstructedPixels;
      this.metrics.seededPixels = (this.metrics.seededPixels ?? 0) + (frame.gpuMetrics.seededPixels ?? 0);
      this.metrics.fullReconstructedFrames = (this.metrics.fullReconstructedFrames ?? 0) + Number(frame.gpuMetrics.full);
    }
    if (this.pool) this.metrics.peakWorkerHeapBytes = Math.max(this.metrics.peakWorkerHeapBytes ?? 0, this.pool.slots.reduce((sum, slot) => sum + (slot.decoder.memoryBytes ?? 0), 0));
    if (frame.gpuFailure) {
      const failures = this.metrics.gpuFailures ??= Object.create(null);
      failures[frame.gpuFailure] = (failures[frame.gpuFailure] ?? 0) + 1;
    }
    const end = packet.end ?? packet.time + packet.duration;
    if (Number.isInteger(packet.sourceFrame)) {
      this.completed.set(packet.sourceFrame, end);
      const previousEnd = this.consumedEnd;
      while (this.completed.has(this.nextOrdinal)) {
        this.consumedEnd = this.completed.get(this.nextOrdinal); this.completed.delete(this.nextOrdinal++); this.metrics.sourceConsumed++;
      }
      if (this.consumedEnd !== previousEnd) this.advance(this.consumedEnd);
    }
    const bytes = frame.consumed ? 0 : this.frameBytes;
    if (frame.consumed) this.metrics.deferred++;
    else {
      this.metrics.reconstructed++;
      const renderers = this.metrics.renderers ??= Object.create(null);
      if (frame.renderer) renderers[frame.renderer] = (renderers[frame.renderer] ?? 0) + 1;
    }
    if (end > this.position) {
      this.queue.push({ time: packet.time, end, frame, bytes }); this.queueBytes += bytes;
      this.queue.sort((a, b) => a.time - b.time);
      this.metrics.frameBytes = Math.max(this.metrics.frameBytes, this.queueBytes);
    } else { frame.bitmap?.close(); this.metrics.dropped++; this.metrics.lateDecoded++; }
    if (this.waiter && (this.waiter.available ? this.waiter.available() : this.ready(this.position))) { this.waiter.resolve(); this.waiter = null; }
  }

  ready(position) {
    if (this.nextOrdinal !== undefined && this.consumedEnd <= position) return false;
    return this.displayedEnd > position || this.queue.some(item => item.time <= position && item.end > position);
  }

  draw(position, rate = this.rate ?? 1) {
    this.pump(position, rate);
    let selected; let end = this.displayedEnd;
    while (this.queue.length && this.queue[0].time <= position) {
      const item = this.shift(); end = Math.max(end, item.end);
      if (!item.frame.consumed) {
        if (this.displayedEnd >= 0 && !shouldPaint(item, position, this.metadata.duration, this.metadata.fps, rate, this.displayRate)) {
          item.frame.bitmap?.close(); this.metrics.dropped++; continue;
        }
        if (selected) { selected.frame.bitmap?.close(); this.metrics.dropped++; }
        selected = item;
      }
    }
    if (selected) {
      const startedAt = performance.timeOrigin + performance.now();
      this.renderer.draw(selected.frame);
      const elapsed = performance.timeOrigin + performance.now() - startedAt;
      this.metrics.visibleDrawMilliseconds = (this.metrics.visibleDrawMilliseconds ?? 0) + elapsed;
      this.policy?.observe(selected.frame, position, elapsed, selected.time <= position && position < selected.end && !globalThis.document?.hidden);
      this.metrics.painted++;
    }
    if (selected || this.displayedEnd >= 0) this.displayedEnd = end;
    this.pump(position, rate);
  }

  close() {
    this.closed = true;
    this.pool?.close();
    for (const lease of this.leases) lease.release(); this.leases.clear();
    this.waiter?.reject(new DOMException('Stream closed.', 'AbortError')); this.waiter = null;
    for (const item of this.queue) item.frame.bitmap?.close();
    this.queue = []; this.queueBytes = 0; this.completed.clear();
    this.inflight.clear();
  }

  activateRenderer(position) { this.policy?.activate(position); }
}
