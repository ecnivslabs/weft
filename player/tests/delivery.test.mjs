import test from 'node:test';
import assert from 'node:assert/strict';
import { deliveryWindow, decoderCount, CACHE_BYTES, FRAME_BYTES, shouldPaint, presentationRate } from '../web/delivery.js';

function reader(length = 1000) {
  const timeline = Array.from({ length: 200 }, (_, chunk) => ({ chunk, start: chunk * 0.02, end: (chunk + 1) * 0.02, length }));
  return { metadata: { audio: null }, timelines: new Map([[360, timeline]]), recordAt: (_, position) => timeline[Math.min(199, Math.floor(position / 0.02))] };
}

test('delivery horizon follows playback time rather than a fixed next chunk', () => {
  const source = reader();
  const normal = deliveryWindow(source, 360, 0.4, 1);
  const fast = deliveryWindow(source, 360, 0.4, 2);
  assert.equal(normal.first, 20); assert.ok(normal.last > 21);
  assert.ok(normal.end >= 1.15);
  assert.equal(fast.last - fast.first + 1, 64);
  assert.ok(fast.end > normal.end);
  assert.ok(fast.bytes <= CACHE_BYTES);
});

test('delivery window honors byte budget and includes audio memory reservations', () => {
  const source = reader(16 * 1024 * 1024);
  assert.equal(deliveryWindow(source, 360, 0, 2).last, 3);
  source.metadata.audio = { channels: 2 }; source.audio = { sampleRate: 48000 };
  source.records = new Map(source.timelines.get(360).map(record => [`0:${record.chunk}`, { decoded: 960 }]));
  assert.equal(deliveryWindow(source, 360, 0, 2).last, 2);
  assert.throws(() => deliveryWindow(source, 999, 0));
  assert.throws(() => deliveryWindow(source, 360, NaN));
  assert.throws(() => deliveryWindow(source, 360, 0, 0));
});

test('decoder ceiling respects hardware and global RGBA reservations', () => {
  for (const [width, height] of [[639, 360], [852, 480], [1281, 720], [1920, 1080], [4095, 1080]]) {
    const count = decoderCount(width, height, 16);
    assert.ok(count >= 1 && count <= 4);
    assert.ok(count * width * height * 4 <= FRAME_BYTES);
    assert.equal(decoderCount(width, height, 1), 1);
  }
});

test('presentation selection preserves source timing while respecting measured display cadence', () => {
  const packets=Array.from({length:60},(_,index)=>({time:index/60,duration:1/60}));
  assert.equal(packets.filter(packet=>shouldPaint(packet,0,1,60,2,60)).length,30);
  assert.equal(packets.filter(packet=>shouldPaint(packet,0,1,60,1,60)).length,60);
  assert.equal(packets.filter(packet=>shouldPaint(packet,0,1,60,2,144)).length,60);
  assert.equal(shouldPaint(packets[0],0,1,60,2,60,true),true);
  assert.equal(shouldPaint(packets[0],.1,1,60,2,60),false);
  assert.equal(shouldPaint(packets.at(-1),0,1,60,2,60),true);
  assert.equal(shouldPaint(packets[0],0,1,60,2,Infinity),true);
});

test('presentation uses exact stored ends before an adjacent fractional boundary', () => {
  const packet = { time: .35, duration: .016667, end: .366667 };
  assert.equal(shouldPaint(packet, packet.time + packet.duration, 1, 60, 1, 60), true);
  assert.equal(shouldPaint(packet, packet.end, 1, 60, 1, 60), false);
});

test('refresh probing uses median callback interval and cancels bounded work', async () => {
  const originalRaf=globalThis.requestAnimationFrame,originalCancel=globalThis.cancelAnimationFrame;
  let callback;let cancelled=0;globalThis.requestAnimationFrame=value=>{callback=value;return 1;};globalThis.cancelAnimationFrame=()=>cancelled++;
  try {
    const controller=new AbortController();const result=presentationRate(controller.signal);
    for(let index=0;index<13;index++)callback(index*1000/60);
    assert.ok(Math.abs(await result-60)<1e-9);assert.equal(cancelled,1);
    const pending=presentationRate(controller.signal);controller.abort();assert.equal(await pending,Infinity);assert.equal(cancelled,2);
  } finally {globalThis.requestAnimationFrame=originalRaf;globalThis.cancelAnimationFrame=originalCancel;}
});
