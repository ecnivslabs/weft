export class AudioClock {
  constructor() {
    this.context = new AudioContext({ sampleRate: 48000 });
    this.gain = this.context.createGain();
    this.gain.connect(this.context.destination);
    this.position = 0;
    this.anchor = 0;
    this.rate = 1; this.videoEnd = Infinity;
    this.playing = false;
    this.buffering = false;
    this.volume = 0.8;
    this.muted = false;
    this.sources = new Set();
    this.scheduled = new Map();
    this.updateGain();
  }

  get time() {
    if (!this.playing || this.buffering) return this.position;
    return Math.min(this.videoEnd, this.position + Math.max(0, this.context.currentTime - this.anchor) * this.rate);
  }

  stopSources() {
    for (const source of this.sources) source.stop();
    this.sources.clear();
    this.scheduled.clear();
  }

  freeze() {
    this.position = this.time;
    this.buffering = true;
    this.stopSources();
  }

  run() {
    this.anchor = this.context.currentTime + 0.025;
    this.buffering = false;
  }

  pause() {
    this.position = this.time;
    this.playing = false;
    this.buffering = false;
    this.stopSources();
  }

  schedule(buffer, chunk, duration, begin, release = () => {}) {
    if (!this.playing || this.buffering || this.scheduled.has(chunk)) return false;
    const end = begin + duration;
    const position = Math.max(begin, this.time);
    if (position >= end || position - begin >= buffer.duration) return false;
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = this.rate;
    source.connect(this.gain);
    source.onended = () => {
      source.disconnect(); this.sources.delete(source); release();
      if (this.scheduled.get(chunk) === source) this.scheduled.delete(chunk);
    };
    const when = Math.max(this.context.currentTime, this.anchor + (position - this.position) / this.rate);
    try { source.start(when, position - begin, Math.min(end - position, buffer.duration - (position - begin))); }
    catch (error) { source.disconnect(); throw error; }
    this.sources.add(source);
    this.scheduled.set(chunk, source); return true;
  }

  updateGain() {
    this.gain.gain.setValueAtTime(this.muted ? 0 : this.volume, this.context.currentTime);
  }
}
