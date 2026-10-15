const WORKLOADS = new Set(['same', 'sparse', 'partial', 'full']);
export function rendererOptions(options = {}) {
  const { gpu = false, renderer } = options;
  if (typeof gpu !== 'boolean' || (renderer !== undefined && renderer !== 'auto') || (renderer !== undefined && Object.hasOwn(options, 'gpu'))) throw new Error('Invalid SCI renderer policy.');
  return { gpu: renderer === 'auto' ? false : gpu, automaticRenderer: renderer === 'auto' };
}
const median = values => {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

export class RendererPolicy {
  constructor(workers) {
    if (!Number.isInteger(workers) || workers < 1 || workers > 4) throw new Error('Invalid renderer worker count.');
    this.workers = workers;
    this.minimum = Math.max(4, workers * 2);
    this.limit = this.minimum * 3;
    this.epoch = -1; this.mode = 'cpu'; this.enabled = false;
    this.retries = 0; this.wins = 0; this.settled = false;
    this.cpu = new Map();
    this.metrics = { selected: 'cpu', epochs: [], samples: 0, staleSamples: 0, invalidSamples: 0, warmups: 0, retries: 0, failures: 0, fallbacks: 0, requestedCpuImages: 0, requestedGpuImages: 0 };
  }

  activate(position) {
    if (!Number.isFinite(position) || position < 0) throw new Error('Invalid renderer playback position.');
    if (!this.enabled) { this.enabled = true; this.begin('cpu', position); }
  }

  begin(mode, position) {
    this.mode = mode; this.epoch++; this.settled = false;
    this.records = new Map(); this.seen = new Set(); this.samples = 0; this.visits = 0; this.requests = 0;
    this.metrics.selected = mode;
    this.metrics.settled = false;
    this.entry = { epoch: this.epoch, mode, start: position, samples: 0, warmups: 0 };
    this.metrics.epochs.push(this.entry);
    if (this.metrics.epochs.length > 16) this.metrics.epochs.shift();
  }

  settle(mode, position, reason) {
    this.mode = mode; this.epoch++; this.settled = true;
    this.changedAt = position; this.retryAt = position + 10;
    this.metrics.selected = mode;
    this.metrics.settled = true;
    if (this.entry) { this.entry.end = position; this.entry.decision = mode; this.entry.reason = reason; }
    this.records = new Map(); this.seen = new Set(); this.samples = 0; this.visits = 0;
  }

  request(packet, width, height, format, present = true, position = packet.time) {
    if (!Number.isSafeInteger(packet.sourceFrame) || packet.sourceFrame < 0) throw new Error('Invalid renderer source ordinal.');
    if (!Number.isFinite(position) || position < 0) throw new Error('Invalid renderer playback position.');
    if (this.enabled && !this.settled && present && ++this.requests > this.limit * 4) this.settle('cpu', position, 'Pooled probe image limit reached');
    if (present) this.metrics[this.enabled && this.mode === 'gpu' ? 'requestedGpuImages' : 'requestedCpuImages']++;
    return { gpu: this.enabled && this.mode === 'gpu', epoch: this.epoch, sourceFrame: packet.sourceFrame, width, height, format, releaseGpu: this.settled && this.mode === 'cpu' };
  }

  store(records, workload, value) {
    const values = records.get(workload) ?? [];
    values.push(value);
    if (values.length > this.limit) values.shift();
    records.set(workload, values);
  }

  gpuWins() {
    let matched = 0; let retained = 0;
    for (const [workload, values] of this.records) {
      retained += values.length;
      const cpu = this.cpu.get(workload);
      if (values.length < 2 || !cpu || cpu.length < 2) continue;
      matched += values.length;
      if (median(values) >= median(cpu) * .75) return false;
    }
    return matched >= this.minimum && matched >= retained * .75;
  }

  observe(frame, position, visibleDrawMilliseconds, eligible) {
    const decision = frame.renderDecision;
    if (!this.enabled || !decision || decision.epoch !== this.epoch) { this.metrics.staleSamples++; return; }
    if (!Number.isFinite(position) || position < 0) { this.metrics.invalidSamples++; return; }
    this.visits++;
    if (decision.gpu && (frame.gpuFailure || frame.renderer !== 'webgl2')) {
      this.metrics.failures++; this.wins = 0;
      this.settle('cpu', position, 'GPU reconstruction failed'); return;
    }
    const timing = frame.timing;
    const durations = [timing?.decoderMilliseconds, timing?.reconstructionMilliseconds, timing?.initializationMilliseconds, frame.deliveryMilliseconds, visibleDrawMilliseconds];
    if (!eligible || !WORKLOADS.has(frame.renderWorkload) || !Number.isInteger(frame.workerId) || frame.workerId < 0 || frame.workerId >= this.workers
      || durations.some(value => !Number.isFinite(value) || value < 0)
      || frame.renderer !== (decision.gpu ? 'webgl2' : 'canvas2d')) {
      this.metrics.invalidSamples++;
      if (!this.settled && this.visits >= this.limit) this.settle('cpu', position, 'Invalid or ineligible pooled samples');
      return;
    }
    const cost = durations.reduce((sum, value) => sum + value, 0);
    if (!this.seen.has(frame.workerId)) {
      this.seen.add(frame.workerId); this.metrics.warmups++;
      if (!this.settled) this.entry.warmups++;
      return;
    }
    this.store(this.records, frame.renderWorkload, cost);
    this.samples++; this.metrics.samples++;
    if (this.settled) {
      if (this.mode === 'cpu') {
        this.store(this.cpu, frame.renderWorkload, cost);
        if (position >= this.retryAt && this.retries < 2 && this.samples >= this.minimum) {
          this.retries++; this.metrics.retries = this.retries; this.wins = 0;
          this.begin('gpu', position);
        }
      } else if (position - this.changedAt >= 5 && this.samples >= this.minimum && !this.gpuWins()) {
        this.metrics.fallbacks++; this.wins = 0;
        this.settle('cpu', position, 'GPU costs no longer beat CPU baseline');
      }
      return;
    }
    this.entry.samples = this.samples;
    if ((this.samples < this.minimum || this.seen.size < Math.min(2, this.workers)) && this.visits < this.limit) return;
    if (this.seen.size < Math.min(2, this.workers) || this.samples < this.minimum) {
      this.settle('cpu', position, 'Insufficient pooled samples'); return;
    }
    if (this.mode === 'cpu') {
      this.cpu = this.records;
      this.entry.end = position;
      this.begin('gpu', position);
    } else if (this.gpuWins()) {
      this.wins++; this.entry.end = position;
      if (this.wins >= 2) this.settle('gpu', position, 'Repeated workload-matched GPU wins');
      else this.begin('cpu', position);
    } else {
      this.wins = 0;
      this.settle('cpu', position, 'GPU did not consistently beat matched CPU costs');
    }
  }
}
