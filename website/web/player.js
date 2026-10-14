import { PixelRenderer } from './renderer.js';

import { Stream } from './stream.js';
import { formatTime } from './time.js';
import { readStored, store } from './storage.js';

export class Player extends EventTarget {
  constructor() {
    super();
    this.element = document.querySelector('#player');
    this.renderer = new PixelRenderer(document.querySelector('#picture'));
    this.stream = new Stream(this.renderer, document.querySelector('#resolution'), (text, retry) => this.message(text, retry));
    this.seek = document.querySelector('#seek');
    this.settings = document.querySelector('#settings');
    this.hideTimer = null;
    this.feedbackTimer = null;
    this.loaded = false;
    this.stream.volume = 0.8;
    const speed = Number(readStored('speed', 1));
    if ([0.5, 0.75, 1, 1.25, 1.5, 2].includes(speed)) {
      this.stream.defaultPlaybackRate = speed;
      this.stream.playbackRate = speed;
      document.querySelector('#speed').value = String(speed);
    }
    const frameRate = Number(readStored('frame-rate', 60));
    this.stream.frameRate = [30, 60].includes(frameRate) ? frameRate : 60;
    document.querySelector('#frame-rate').value = String(this.stream.frameRate);
    this.bind();
  }

  bind() {
    const on = (id, event, callback) => document.querySelector(`#${id}`).addEventListener(event, callback);
    on('surface', 'click', () => this.toggle());
    on('surface', 'dblclick', () => this.fullscreen());
    on('big-play', 'click', () => this.toggle());
    on('play', 'click', () => this.toggle());
    on('mute', 'click', () => { this.stream.muted = !this.stream.muted; });
    on('volume', 'input', event => { this.stream.volume = Number(event.target.value); this.stream.muted = false; });
    on('seek', 'input', () => {
      if (this.loaded && Number.isFinite(this.stream.duration)) {
        this.stream.currentTime = Number(this.seek.value) / 1000 * this.stream.duration;
        this.updateTime();
      }
    });
    on('speed', 'change', event => {
      this.stream.defaultPlaybackRate = Number(event.target.value);
      this.stream.playbackRate = this.stream.defaultPlaybackRate;
      store('speed', this.stream.playbackRate);
    });
    on('frame-rate', 'change', event => {
      this.stream.frameRate = Number(event.target.value);
      store('frame-rate', this.stream.frameRate);
    });
    on('settings-toggle', 'click', () => this.openSettings(this.settings.hidden));
    on('close-settings', 'click', () => this.openSettings(false));
    on('theater', 'click', () => this.theater());
    on('fullscreen', 'click', () => this.fullscreen());
    this.element.addEventListener('pointermove', () => this.showControls());
    this.element.addEventListener('pointerleave', () => this.scheduleHide());
    this.element.addEventListener('focusin', () => this.showControls());
    this.element.addEventListener('focusout', () => this.scheduleHide());
    document.addEventListener('pointerdown', event => {
      if (!event.target.closest('#settings, #settings-toggle')) this.openSettings(false);
    });
    document.addEventListener('keydown', event => this.keyboard(event));
    this.stream.addEventListener('play', () => this.updatePlayback());
    this.stream.addEventListener('pause', () => {
      if (this.waiting) this.message('');
      this.updatePlayback();
    });
    this.stream.addEventListener('ready', () => {
      this.loaded = true;
      this.message('');
      document.querySelector('#play').disabled = false;
      this.seek.disabled = false;
      this.updateTime();
      this.updatePlayback();
      this.dispatchEvent(new Event('ready'));
    });
    this.stream.addEventListener('seeked', () => this.message(''));
    this.stream.addEventListener('timeupdate', () => this.updateTime());
    this.stream.addEventListener('durationchange', () => this.updateTime());
    this.stream.addEventListener('volumechange', () => this.updateVolume());
    this.stream.addEventListener('waiting', () => {
      if (this.loaded && !this.stream.paused) {
        this.message('Buffering');
        this.waiting = true;
      }
    });
    this.stream.addEventListener('playing', () => this.message(''));
    this.stream.addEventListener('ended', () => {
      this.updatePlayback();
      this.dispatchEvent(new Event('ended'));
    });
    document.addEventListener('fullscreenchange', () => {
      const active = document.fullscreenElement === this.element;
      document.querySelector('#fullscreen').setAttribute('aria-label', active ? 'Exit fullscreen (F)' : 'Fullscreen (F)');
      this.showControls();
    });
  }

  load(entry, autoplay = false, position = 0) {
    this.reset();
    this.message('Loading video');
    this.stream.load(entry, autoplay, position);
  }

  reset() {
    this.loaded = false;
    this.stream.reset();
    this.seek.disabled = true;
    this.seek.value = '0';
    document.querySelector('#play').disabled = true;
    document.querySelector('#big-play').hidden = true;
    document.querySelector('#time').textContent = '0:00 / 0:00';
    this.updatePlayback();
  }

  async play() {
    try { await this.stream.play(); }
    catch (error) {
      if (error.name === 'NotAllowedError') this.message('Press play to start.');
      else if (error.name !== 'AbortError') this.message('Playback failed. Retry this video.', true);
    }
  }

  toggle() {
    if (!this.loaded) return;
    if (this.stream.paused) this.play();
    else this.stream.pause();
  }

  message(text, retry = false) {
    this.waiting = false;
    document.querySelector('#message-text').textContent = text;
    document.querySelector('#player-message').hidden = !text;
    document.querySelector('#retry').hidden = !retry;
    document.querySelector('.empty-film').hidden = this.loaded;
    document.querySelector('#big-play').hidden = Boolean(text) || !this.loaded || !this.stream.paused;
  }

  updatePlayback() {
    const paused = this.stream.paused;
    const button = document.querySelector('#play');
    button.querySelector('use').setAttribute('href', paused ? '#i-play' : '#i-pause');
    button.setAttribute('aria-label', paused ? 'Play (K)' : 'Pause (K)');
    button.title = paused ? 'Play (K)' : 'Pause (K)';
    document.querySelector('#surface').setAttribute('aria-label', paused ? 'Play video' : 'Pause video');
    document.querySelector('#big-play').hidden = !paused || !this.loaded || !document.querySelector('#player-message').hidden;
    this.element.classList.toggle('is-paused', paused);
    this.showControls();
  }

  updateVolume() {
    const muted = this.stream.muted || this.stream.volume === 0;
    document.querySelector('#mute use').setAttribute('href', muted ? '#i-mute' : '#i-volume');
    document.querySelector('#mute').setAttribute('aria-label', muted ? 'Unmute (M)' : 'Mute (M)');
    document.querySelector('#volume').value = String(muted ? 0 : this.stream.volume);
  }

  updateTime() {
    const duration = this.stream.duration;
    const current = this.stream.currentTime;
    this.seek.value = Number.isFinite(duration) && duration > 0 ? String(current / duration * 1000) : '0';
    this.seek.setAttribute('aria-valuetext', `${formatTime(current)} of ${formatTime(duration)}`);
    document.querySelector('#time').textContent = `${formatTime(current)} / ${formatTime(duration)}`;
    this.dispatchEvent(new Event('timeupdate'));
  }

  showControls() {
    this.element.classList.add('controls-visible');
    this.scheduleHide();
  }

  scheduleHide() {
    clearTimeout(this.hideTimer);
    if (this.stream.paused || !this.settings.hidden || this.element.contains(document.activeElement)) return;
    this.hideTimer = setTimeout(() => this.element.classList.remove('controls-visible'), 2400);
  }

  openSettings(open) {
    this.settings.hidden = !open;
    document.querySelector('#settings-toggle').setAttribute('aria-expanded', String(open));
    this.showControls();
  }

  theater() {
    const enabled = document.body.classList.toggle('theater-mode');
    document.querySelector('#theater').setAttribute('aria-pressed', String(enabled));
  }

  async fullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (this.element.requestFullscreen) await this.element.requestFullscreen();
      else this.feedback('Fullscreen is unavailable in this browser.');
    } catch { this.feedback('Fullscreen is unavailable.'); }
  }

  feedback(text) {
    const element = document.querySelector('#feedback');
    element.textContent = text;
    element.hidden = false;
    clearTimeout(this.feedbackTimer);
    this.feedbackTimer = setTimeout(() => { element.hidden = true; }, 1100);
  }

  keyboard(event) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.target.closest('input, select, textarea, dialog, [contenteditable=true]')) return;
    if (event.key === 'Escape') { this.openSettings(false); return; }
    if (event.target.closest('button') && [' ', 'Enter'].includes(event.key)) return;
    const key = event.key.toLowerCase();
    if (![' ', 'k', 'j', 'l', 'm', 'f', 't', 'arrowleft', 'arrowright', 'arrowup', 'arrowdown'].includes(key)) return;
    event.preventDefault();
    if (key === ' ' || key === 'k') this.toggle();
    else if (key === 'm') this.stream.muted = !this.stream.muted;
    else if (key === 'f') this.fullscreen();
    else if (key === 't') this.theater();
    else if (key === 'arrowup' || key === 'arrowdown') {
      this.stream.volume = Math.max(0, Math.min(1, this.stream.volume + (key === 'arrowup' ? 0.05 : -0.05)));
      this.stream.muted = false;
      this.feedback(`Volume ${Math.round(this.stream.volume * 100)}%`);
    } else if (this.loaded) {
      const amount = ['j', 'l'].includes(key) ? 10 : 5;
      const delta = ['j', 'arrowleft'].includes(key) ? -amount : amount;
      this.stream.currentTime = Math.max(0, Math.min(this.stream.duration, this.stream.currentTime + delta));
      this.feedback(`${delta > 0 ? '+' : ''}${delta}s`);
    }
    this.showControls();
  }
}
