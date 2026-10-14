import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioClock } from '../web/audio.js';

class Context {
  constructor() { this.currentTime = 0; this.created = []; }
  createGain() { return { gain: { setValueAtTime() {} }, connect() {} }; }
  createBufferSource() {
    const source = { playbackRate: {}, connect() {}, disconnect() {}, start(...args) { this.args = args; }, stop() { this.stopped = true; } };
    this.created.push(source); return source;
  }
}
function clock() { const value = new AudioClock(); value.playing = true; value.rate = 2; value.run(); return value; }

test('wide audio horizons never reschedule current or queued chunks', () => {
  const original = globalThis.AudioContext; globalThis.AudioContext = Context;
  try {
    const audio = clock(); const buffer = { duration: 0.02 };
    for (let chunk = 0; chunk < 64; chunk++) audio.schedule(buffer, chunk, 0.02, chunk * 0.02);
    audio.schedule(buffer, 0, 0.02, 0); audio.schedule(buffer, 1, 0.02, 0.02);
    assert.equal(audio.context.created.length, 64); assert.equal(audio.scheduled.size, 64);
    assert.equal(audio.context.created[10].args[0], audio.anchor + 0.1);
    for (const source of audio.context.created) source.onended();
    assert.equal(audio.sources.size, 0); assert.equal(audio.scheduled.size, 0);
  } finally { globalThis.AudioContext = original; }
});

test('stopped old audio callbacks cannot remove a new source for the same chunk', () => {
  const original = globalThis.AudioContext; globalThis.AudioContext = Context;
  try {
    const audio = clock(); const buffer = { duration: 1 };
    audio.schedule(buffer, 0, 1, 0); const previous = audio.context.created[0];
    audio.freeze(); audio.run(); audio.schedule(buffer, 0, 1, 0);
    const current = audio.context.created[1]; previous.onended();
    assert.equal(audio.scheduled.get(0), current); assert.equal(audio.sources.has(current), true);
    audio.schedule(buffer, 0, 1, 0); assert.equal(audio.context.created.length, 2);
    audio.pause(); current.onended(); assert.equal(audio.scheduled.size, 0);
  } finally { globalThis.AudioContext = original; }
});

test('media time cannot cross the contiguous decoded video ceiling between RAF callbacks', () => {
  const original=globalThis.AudioContext;globalThis.AudioContext=Context;
  try {
    const audio=clock();audio.videoEnd=.1;audio.context.currentTime=1;
    assert.equal(audio.time,.1);audio.freeze();assert.equal(audio.position,.1);
    audio.videoEnd=.2;audio.run();audio.context.currentTime+=1;assert.equal(audio.time,.2);
    audio.pause();assert.equal(audio.position,.2);
    audio.position=5;audio.buffering=true;assert.equal(audio.time,5);
  } finally {globalThis.AudioContext=original;}
});
