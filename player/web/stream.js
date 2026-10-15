import { SciReader } from './sci.js';
import { AsciiFrames } from './frames.js';
import { AudioClock } from './audio.js';
import { readStored, store } from './storage.js';
import { deliveryWindow, presentationRate } from './delivery.js';
import { rendererOptions } from './calibration.js';

export class Stream extends EventTarget {
  constructor(renderer, quality, message, options = {}) {
    super();
    const selected = rendererOptions(options);
    this.decoderOptions = selected.automaticRenderer ? { renderer: 'auto' } : { gpu: selected.gpu };
    this.renderer = renderer;
    this.qualityControl = quality;
    this.message = message;
    this.clock = new AudioClock();
    this.preference = String(readStored('quality-v4', 'auto'));
    this.reader = null;
    this.metadata = null;
    this.epoch = 0;
    this.operation = 0;
    this.frame = null;
    this.ended = false;
    this.defaultPlaybackRate = 1; this.frameRate = 60; this.displayRate = Infinity;
    quality.addEventListener('change', () => this.changeQuality(quality.value));
  }

  get duration() { return this.metadata?.duration ?? 0; }
  get currentTime() { return Math.min(this.duration, this.clock.time); }
  set currentTime(value) { this.seek(value).catch(error => this.fail(error)); }
  get paused() { return !this.clock.playing; }
  get frameRate() { return this.requestedFrameRate ?? 60; }
  set frameRate(value) {
    if (![30, 60].includes(value)) throw new Error('Frame rate must be 30 or 60 FPS.');
    this.requestedFrameRate = value;
    this.updateDisplayRate();
  }
  get displayRate() { return Math.min(this.refreshRate ?? Infinity, this.frameRate); }
  set displayRate(value) {
    if (!(value > 0) || (!Number.isFinite(value) && value !== Infinity)) throw new Error('Invalid display refresh rate.');
    this.refreshRate = value;
    this.updateDisplayRate();
  }
  updateDisplayRate() {
    if (this.frames) this.frames.displayRate = this.displayRate;
    if (this.preparingFrames) this.preparingFrames.displayRate = this.displayRate;
  }
  get playbackRate() { return this.clock.rate; }
  set playbackRate(value) {
    if (!Number.isFinite(value) || value <= 0) throw new Error('Invalid playback rate.');
    const buffering = this.clock.buffering;
    this.clock.freeze(); this.clock.rate = value;
    if (this.reader && this.metadata) {
      this.updateWindow(this.window?.quality ?? this.quality, this.clock.position, true);
      (this.preparingFrames ?? this.frames)?.pump(this.clock.position, this.clock.rate);
      this.prefetch();
    }
    if (!this.paused && !buffering) { this.clock.run(); this.schedule(); }
    else if (this.paused && !buffering) this.clock.buffering = false;
  }
  get volume() { return this.clock.volume; }
  set volume(value) { this.clock.volume = value; this.clock.updateGain(); this.emit('volumechange'); }
  get muted() { return this.clock.muted; }
  set muted(value) { this.clock.muted = value; this.clock.updateGain(); this.emit('volumechange'); }

  emit(name) { this.dispatchEvent(new Event(name)); }

  async load(entry, autoplay = false, position = 0) {
    this.reset();
    const epoch = this.epoch;
    try {
      if (!globalThis.DecompressionStream) throw new Error('This browser does not support SCI decompression. Use a current browser.');
      const reader = this.reader = new SciReader(entry.media, this.clock.context);
      presentationRate(reader.controller.signal).then(rate => {
        if (epoch !== this.epoch) return;
        this.displayRate = rate;
      });
      const metadata = await reader.open();
      if (epoch !== this.epoch) return;
      this.metadata = metadata;
      const heights = metadata.qualities.map(quality => quality.height);
      const selected = heights.includes(Number(this.preference)) ? this.preference : 'auto';
      this.quality = selected === 'auto' ? heights[0] : Number(selected);
      this.qualityControl.replaceChildren(new Option('Auto', 'auto'), ...heights.slice().reverse().map(height => new Option(`${height}p`, String(height))));
      this.qualityControl.value = selected;
      this.updateQualityLabel();
      await this.seek(position);
      if (epoch !== this.epoch) return;
      this.qualityControl.disabled = false;
      this.emit('ready');
      this.emit('durationchange');
      if (autoplay) await this.play();
    } catch (error) { if (epoch === this.epoch) this.fail(error); }
  }

  async ensure(chunk, quality = this.quality) {
    const tasks = [this.reader.load(quality, chunk)];
    if (this.metadata.audio) tasks.push(this.reader.load(0, chunk));
    await Promise.all(tasks);
  }

  updateWindow(quality = this.window?.quality ?? this.quality, position = this.currentTime, cancel = false) {
    const frames = this.preparingFrames ?? this.frames;
    if (frames?.quality === quality && Number.isInteger(frames.chunk)) {
      const required = this.reader.timelines.get(quality)[frames.chunk];
      if (required) position = Math.min(position, required.start);
    }
    this.window = deliveryWindow(this.reader, quality, position, this.playbackRate);
    this.reader.trim(this.window.first, quality, cancel, this.window.last);
    return this.window;
  }

  async seek(value) {
    if (!this.metadata) return;
    const position = Math.max(0, Math.min(this.duration, Number.isFinite(Number(value)) ? Number(value) : 0));
    const requested = Number(this.qualityControl.value);
    const quality = this.metadata.qualities.some(item => item.height === requested) ? requested : this.quality;
    await this.prepareAt(position, quality, true);
  }

  async prepareAt(position, quality, seeking = false) {
    const epoch = this.epoch; const operation = ++this.operation;
    this.clock.freeze();
    if (position !== null) this.clock.position = position;
    position = this.clock.position;
    if (seeking) { this.ended = false; this.emit('timeupdate'); }
    this.message('Buffering');
    this.frames?.close(); this.frames = null;
    this.preparingFrames?.close(); this.preparingFrames = null;
    this.clock.videoEnd = Infinity;
    const window = this.updateWindow(quality, position, true);
    try { await this.ensure(window.first, quality); }
    catch (error) { if (epoch === this.epoch && operation === this.operation) throw error; return; }
    if (epoch !== this.epoch || operation !== this.operation) return;
    const frames = new AsciiFrames(this.reader, quality, this.renderer, error => {
      if (frames === this.frames || frames === this.preparingFrames) this.fail(error);
    }, end => { if (frames === this.frames || frames === this.preparingFrames) this.clock.videoEnd = end; }, this.decoderOptions);
    frames.displayRate = this.displayRate; this.preparingFrames = frames;
    const sample = Math.min(position, Math.max(0, this.duration - 0.000001));
    const ready = frames.prepare(sample, this.playbackRate);
    this.prefetch();
    try { await ready; }
    catch (error) { frames.close(); if (epoch === this.epoch && operation === this.operation) throw error; return; }
    if (epoch !== this.epoch || operation !== this.operation) { frames.close(); return; }
    this.frames = frames; this.preparingFrames = null; this.quality = quality;
    frames.draw(sample, this.playbackRate); this.updateQualityLabel(); this.message('');
    frames.activateRenderer(sample);
    if (seeking) this.emit('seeked');
    if (!this.paused) { this.clock.run(); this.schedule(); this.prefetch(); this.tick(); }
    else this.clock.buffering = false;
  }

  chunk(position = this.currentTime) { return this.reader.recordAt(this.quality, position).chunk; }

  get chunks() { return this.metadata.chunks; }

  ready(chunk) { return !this.metadata.audio || this.reader.get(0, chunk); }

  draw() { this.frames?.draw(Math.min(this.currentTime, Math.max(0, this.duration - 0.000001)), this.playbackRate); }

  async buffer() {
    const epoch = this.epoch; const operation = ++this.operation;
    const frames = this.frames; const quality = this.quality; const reader = this.reader;
    this.clock.freeze(); this.message('Buffering');
    const window = this.updateWindow(quality, this.clock.position, true);
    try { await this.ensure(window.first, quality); }
    catch (error) { if (epoch === this.epoch && operation === this.operation) throw error; return; }
    if (epoch !== this.epoch || operation !== this.operation || frames !== this.frames) return;
    const current = this.reader.recordAt(quality, this.clock.position).chunk;
    let audio;
    try {
      if (this.metadata.audio) { await reader.load(0, current); audio = reader.retain(0, current); }
      if (epoch !== this.epoch || operation !== this.operation || frames !== this.frames) return;
      await frames.catchup(Math.min(this.clock.position, Math.max(0, this.duration - 0.000001)), this.playbackRate);
      if (epoch !== this.epoch || operation !== this.operation || frames !== this.frames) return;
      this.draw(); this.message(''); this.updateWindow();
      if (!this.paused) { this.clock.run(); this.schedule(); this.prefetch(); this.emit('playing'); }
      else this.clock.buffering = false;
    } finally { audio?.release(); }
  }

  schedule() {
    if (!this.metadata?.audio || this.paused || this.clock.buffering || !this.window) return;
    const first = this.chunk();
    for (let index = first; index <= this.window.last; index++) {
      if (this.clock.scheduled.has(index)) continue;
      const lease = this.reader.retain(0, index);
      const record = this.reader.records.get(`0:${index}`);
      if (!lease) continue;
      try { if (!record || !this.clock.schedule(lease.value, index, record.end - record.start, record.start, lease.release)) lease.release(); }
      catch (error) { lease.release(); throw error; }
    }
  }

  prefetch() {
    if (!this.window) return;
    const epoch = this.epoch; const { quality, first, last } = this.window;
    for (let chunk = first; chunk <= last; chunk++) {
      const keys = [`${quality}:${chunk}`, ...(this.metadata.audio ? [`0:${chunk}`] : [])];
      if (keys.every(key => this.reader.cache.has(key) || this.reader.pending.has(key) || this.reader.waiting.has(key))) continue;
      this.ensure(chunk, quality).then(() => {
        if (epoch !== this.epoch || !this.reader.inWindow(`${quality}:${chunk}`)) return;
        (this.preparingFrames ?? this.frames)?.pump(this.currentTime, this.playbackRate); this.schedule();
      }).catch(error => { if (epoch === this.epoch && this.reader.inWindow(`${quality}:${chunk}`)) this.fail(error); });
    }
  }

  async play() {
    if (!this.metadata) return;
    const epoch = this.epoch;
    const intent = this.intent = (this.intent ?? 0) + 1;
    this.clock.playing = true;
    this.emit('play');
    await this.clock.context.resume();
    if (epoch !== this.epoch || intent !== this.intent || this.paused) return;
    if (this.ended || this.clock.position >= this.duration) await this.seek(0);
    else await this.seek(this.clock.position);
    if (epoch === this.epoch && intent === this.intent && !this.paused) this.tick();
  }

  pause() { this.intent = (this.intent ?? 0) + 1; this.clock.pause(); this.emit('pause'); }

  tick() {
    if (this.frame !== null || this.paused) return;
    const step = () => {
      this.frame = null;
      if (this.paused || !this.metadata) return;
      const position = this.currentTime;
      if (position >= this.duration) {
        const last = Math.max(0, this.duration - 0.000001);
        if (!this.frames?.ready(last)) {
          if (!this.clock.buffering) { this.buffer().catch(error => this.fail(error)); this.emit('waiting'); }
          this.updateWindow(); this.prefetch();
          this.frame = document.hidden ? { timer: setTimeout(step, 50) } : { animation: requestAnimationFrame(step) };
          return;
        }
        this.frames.draw(last, this.playbackRate);
        this.pause();
        this.clock.position = this.duration;
        this.ended = true;
        this.emit('timeupdate');
        this.emit('ended');
        return;
      }
      const chunk = this.chunk(position);
      this.frames?.pump(position, this.playbackRate);
      if ((!this.ready(chunk) || !this.frames?.ready(position)) && !this.clock.buffering) {
        this.buffer(position).catch(error => this.fail(error));
        this.emit('waiting');
      }
      if (!document.hidden) this.draw();
      this.schedule();
      this.updateWindow(); this.prefetch();
      if (!this.clock.buffering) this.autoQuality(chunk);
      this.emit('timeupdate');
      this.frame = document.hidden ? { timer: setTimeout(step, 50) } : { animation: requestAnimationFrame(step) };
    };
    this.frame = document.hidden ? { timer: setTimeout(step, 50) } : { animation: requestAnimationFrame(step) };
  }

  autoQuality(chunk) {
    if (this.qualityControl.value !== 'auto' || chunk === this.lastAutoChunk || this.adapting) return;
    this.lastAutoChunk = chunk;
    const canvas = this.renderer.canvas;
    const viewport = Math.max(360, canvas.clientHeight * (globalThis.devicePixelRatio || 1));
    const limit = navigator.connection?.saveData ? Math.min(480, viewport) : viewport;
    const available = this.metadata.qualities.filter(item => item.height <= limit);
    let selected = this.metadata.qualities[0].height;
    const audio = this.reader.records.get(`0:${chunk}`)?.length ?? 0;
    const metrics = this.frames?.metrics;
    const decodeSeconds = metrics?.decoded ? (metrics.decodeWallMilliseconds ?? metrics.decodeMilliseconds) / metrics.decoded / 1000 : 0;
    for (const quality of available) {
      const record = this.reader.records.get(`${quality.height}:${chunk}`);
      const bandwidth = (record.length + audio) * 8 / (record.end - record.start);
      const estimatedDecode = decodeSeconds * quality.columns * quality.rows / (canvas.width * canvas.height || 1);
      if (bandwidth * this.playbackRate < this.reader.bandwidth * 0.7 && estimatedDecode < 0.8 / (this.metadata.fps * this.playbackRate)) selected = quality.height;
    }
    if (selected > this.quality) {
      this.upgradeCount = (this.upgradeCount ?? 0) + 1;
      if (this.upgradeCount < 2) return;
    } else this.upgradeCount = 0;
    if (selected !== this.quality) {
      this.adapting = true;
      this.switchQuality(selected).finally(() => { this.adapting = false; });
    }
  }

  changeQuality(value) {
    this.preference = value;
    store('quality-v4', value);
    if (!this.metadata) return;
    this.switchQuality(value === 'auto' ? this.metadata.qualities[0].height : Number(value));
    this.lastAutoChunk = null;
  }

  async switchQuality(value) {
    if (!this.metadata?.qualities.some(item => item.height === value)) return;
    const epoch = this.epoch;
    try { await this.prepareAt(null, value); }
    catch (error) { if (epoch === this.epoch) this.fail(error); }
  }

  updateQualityLabel() { this.qualityControl.options[0].textContent = `Auto (${this.quality}p)`; }

  fail(error) {
    if (error.name === 'AbortError') return;
    this.pause();
    this.message(error.message || 'Stream could not be loaded. Retry playback.', true);
  }

  reset() {
    ++this.epoch;
    ++this.operation;
    this.frames?.close(); this.preparingFrames?.close();
    this.frames = null; this.preparingFrames = null;
    this.reader?.close();
    this.reader = null;
    this.metadata = null;
    this.pause();
    this.clock.position = 0; this.clock.videoEnd = Infinity;
    this.ended = false;
    this.lastAutoChunk = null;
    this.window = null;
    this.upgradeCount = 0;
    this.adapting = false;
    if (this.frame?.timer !== undefined) clearTimeout(this.frame.timer);
    if (this.frame?.animation !== undefined) cancelAnimationFrame(this.frame.animation);
    this.frame = null;
    this.qualityControl.disabled = true;
    this.renderer.clear();
  }
}
