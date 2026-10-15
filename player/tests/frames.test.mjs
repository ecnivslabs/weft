import test from 'node:test';
import assert from 'node:assert/strict';
import { AsciiFrames } from '../web/frames.js';
import { FRAME_BYTES, MAX_FRAME_EVENTS } from '../web/delivery.js';
import { RendererPolicy } from '../web/calibration.js';
import { DecoderPool, partition } from '../web/decode-pool.js';

test('future images leave capacity for an earlier chain after its deferred predecessor finishes', async () => {
  for (const presentFirst of [false, true]) {
    const frames = new AsciiFrames({ metadata: { duration: 1, fps: 60 } }, 1080, { draw() {} }, error => { throw error; });
    frames.frameBytes = FRAME_BYTES / 4; frames.nextOrdinal = 0; frames.position = .01;
    const workers = [];
    const pool = frames.pool = new DecoderPool(4, {}, {
      paint: packet => presentFirst || packet.sourceFrame !== 0,
      reserve: (packet, present) => frames.reserve(packet, present),
      release: (packet, present) => { frames.reservations--; frames.reservedBytes -= present ? frames.frameBytes : 0; frames.inflight.delete(packet.sourceFrame); },
      accept: (frame, packet) => frames.accept(frame, packet, 1), complete() {}, fail: error => { throw error; },
    }, () => {
      const worker = { calls: [], decode(packet, width, height, format, reset, font, present) {
        this.calls.push(packet.sourceFrame);
        return new Promise((resolve, reject) => { this.pending = { resolve: () => resolve({ consumed: !present }), reject }; });
      }, finish() { const pending = this.pending; this.pending = null; pending.resolve(); }, close() { this.pending?.reject(new DOMException('Closed', 'AbortError')); } };
      workers.push(worker); return worker;
    });
    const packets = Array.from({ length: 6 }, (_, index) => ({ sourceFrame: index, tag: index === 1 ? 7 : 6, time: index / 100, end: (index + 1) / 100 }));
    pool.add(partition(packets, 0)); pool.pump(.01, 1, 1920, 1080, 28, 'ascii-3x4-v2');
    const settle = () => new Promise(resolve => setImmediate(resolve));
    assert.ok(workers.every(worker => worker.pending), 'Available worker capacity was reserved twice');
    for (const worker of workers.slice(1)) { worker.finish(); await settle(); }
    assert.equal(frames.queue.length, 3);
    assert.ok(!workers.some(worker => worker.calls.includes(5)));
    workers[0].finish(); await settle();
    assert.deepEqual(workers[0].calls, [0, 1]);
    assert.equal(frames.reservedBytes + frames.queueBytes, FRAME_BYTES);
    frames.close(); await settle(); assert.equal(frames.reservations, 0);
  }
});

test('playback lead waits for contiguous source work, clamps at end and rejects on close', async () => {
  const frames = new AsciiFrames({ metadata: { duration: .3, fps: 10 } }, 360, { draw() {} }, error => { throw error; });
  frames.frameBytes = 48; frames.pump = () => {}; frames.nextOrdinal = 0;
  frames.accept({}, { sourceFrame: 0, time: 0, end: .1 }, 1);
  let ready = false;
  const pending = frames.catchup(0, 2, .2).then(() => { ready = true; });
  frames.accept({}, { sourceFrame: 2, time: .2, end: .3 }, 1);
  await Promise.resolve(); assert.equal(ready, false);
  frames.accept({}, { sourceFrame: 1, time: .1, end: .2 }, 1);
  await pending; assert.equal(ready, true);
  await frames.catchup(.25, 2, .2);
  await assert.rejects(frames.catchup(0, 2, NaN), /playback lead/);
  const closed = frames.catchup(.3, 1, 0);
  frames.close(); await assert.rejects(closed, { name: 'AbortError' });
});

test('lead preparation cannot deadlock behind a full future queue', async () => {
  for (const frameBytes of [48, 1920 * 1080 * 4]) {
    const frames = new AsciiFrames({ metadata: { duration: 10, fps: 60 } }, 1080, { draw() {} }, error => { throw error; });
    frames.frameBytes = frameBytes; frames.pump = () => {}; frames.nextOrdinal = 0;
    frames.accept({}, { sourceFrame: 0, time: 0, end: .01 }, 1);
    const pending = frames.catchup(0, 2, .1);
    const limit = frameBytes === 48 ? MAX_FRAME_EVENTS : Math.floor(FRAME_BYTES / frameBytes);
    for (let index = 1; index < limit; index++) {
      frames.accept({}, { sourceFrame: index + 10, time: .15 + index / 60, end: .15 + (index + 1) / 60 }, 1);
    }
    await pending;
    assert.equal(frames.consumedEnd, .01);
    assert.equal(frames.ready(0), true);
    frames.close();
  }
});

test('FPS cap discards already prepared images while consuming every source dependency and preserving the final image', () => {
  for (const rate of [1, 2]) {
    const selected = [], released = [];
    const frames = new AsciiFrames({ metadata: { version: 4, duration: 1, fps: 60 } }, 360,
      { draw: frame => selected.push(frame.id) }, error => { throw error; });
    frames.frameBytes = 48; frames.pump = () => {}; frames.nextOrdinal = 0;
    frames.displayRate = 60;
    frames.accept({ id: 0 }, { sourceFrame: 0, time: 0, end: 1 / 60 }, 1); frames.draw(0, rate);
    frames.displayRate = 30;
    for (let index = 1; index < 60; index++) {
      const packet = { sourceFrame: index, time: index / 60, end: (index + 1) / 60 };
      frames.accept({ id: index, bitmap: { close() { released.push(index); } } }, packet, 1);
      frames.draw(packet.time, rate);
    }
    assert.equal(frames.metrics.sourceConsumed, 60); assert.equal(frames.nextOrdinal, 60);
    assert.equal(frames.consumedEnd, 1); assert.equal(frames.displayedEnd, 1);
    assert.equal(selected.at(-1), 59); assert.equal(selected.length, 30 / rate + 1);
    assert.equal(selected.length + released.length, 60); assert.equal(frames.queueBytes, 0);
    frames.close();
  }
});

test('consumed source events extend readiness without replacing selected exact pixels', () => {
  const selected=[];
  const frames=new AsciiFrames({metadata:{version:4}},360,{draw:frame=>selected.push(frame.id)},error=>{throw error;});
  frames.frameBytes=48;frames.pump=()=>{};
  frames.accept({id:0}, {time:0,duration:1},1);
  frames.accept({consumed:true}, {time:1,duration:1},1);
  frames.accept({id:2}, {time:2,duration:1},1);
  assert.equal(frames.queueBytes,96);assert.equal(frames.ready(1.5),true);
  frames.draw(1.5);assert.deepEqual(selected,[0]);assert.equal(frames.displayedEnd,2);assert.equal(frames.queueBytes,48);
  frames.draw(2.5);assert.deepEqual(selected,[0,2]);assert.equal(frames.displayedEnd,3);
  assert.equal(frames.metrics.decoded,3);assert.equal(frames.metrics.deferred,1);assert.equal(frames.metrics.reconstructed,2);assert.equal(frames.metrics.painted,2);
  frames.close();assert.equal(frames.queueBytes,0);
});

test('a later independent image cannot advance readiness before earlier source events are consumed', () => {
  const advanced=[];
  const frames=new AsciiFrames({metadata:{version:4}},360,{draw(){}},error=>{throw error;},end=>advanced.push(end));
  frames.frameBytes=48;frames.pump=()=>{};frames.nextOrdinal=0;
  frames.accept({}, {sourceFrame:2,time:2,duration:1},1);
  assert.equal(frames.ready(2.5),false);assert.equal(frames.completed.size,1);
  assert.deepEqual(advanced,[]);
  frames.accept({consumed:true}, {sourceFrame:0,time:0,duration:1},1);
  assert.equal(frames.ready(2.5),false);assert.equal(frames.metrics.sourceConsumed,1);
  assert.deepEqual(advanced,[1]);
  frames.accept({consumed:true}, {sourceFrame:1,time:1,duration:1},1);
  assert.equal(frames.ready(2.5),true);assert.equal(frames.metrics.sourceConsumed,3);assert.equal(frames.completed.size,0);
  assert.deepEqual(advanced,[1,3]);
  frames.close();
});

test('clock frontier and readiness share the exact adjacent packet boundary', () => {
  let frontier;
  const frames = new AsciiFrames({ metadata: { version: 4 } }, 360, { draw() {} }, error => { throw error; }, end => { frontier = end; });
  frames.frameBytes = 48; frames.pump = () => {}; frames.nextOrdinal = 21;
  frames.accept({}, { sourceFrame: 21, time: .35, duration: .016667, end: .366667 }, 1);
  frames.draw(.35);
  assert.equal(frontier, .366667);
  assert.equal(frames.ready(frontier), false);
  frames.accept({ consumed: true }, { sourceFrame: 22, time: .366667, duration: .016666, end: .383333 }, 1);
  assert.equal(frames.ready(.366667), true);
  frames.draw(.366667);
  assert.equal(frames.displayedEnd, .383333);
  frames.close();
});

test('realized renderer and fallback messages retain exact counts without inherited keys', () => {
  const frames = new AsciiFrames({ metadata: { version: 4 } }, 360, { draw() {} }, error => { throw error; });
  frames.frameBytes = 48; frames.pump = () => {};
  frames.accept({ renderer: 'canvas2d', gpuFailure: 'constructor' }, { time: 0, duration: 1 }, 1);
  frames.accept({ renderer: 'canvas2d', gpuFailure: 'constructor' }, { time: 1, duration: 1 }, 1);
  assert.deepEqual({ ...frames.metrics.renderers }, { canvas2d: 2 });
  assert.deepEqual({ ...frames.metrics.gpuFailures }, { constructor: 2 });
  frames.close();
});

test('automatic model observes the visible import but excludes stale epochs without dropping source events', () => {
  const frames = new AsciiFrames({ metadata: { version: 4 } }, 360, { draw() {} }, error => { throw error; }, () => {}, { renderer: 'auto' });
  frames.frameBytes = 48; frames.pump = () => {}; frames.nextOrdinal = 0;
  frames.policy = new RendererPolicy(1); frames.activateRenderer(0);
  const created = performance.timeOrigin + performance.now();
  const packet = { sourceFrame: 0, time: 0, end: 1 };
  const image = { renderer: 'canvas2d', renderWorkload: 'full', workerId: 0, renderDecision: { ...frames.policy.request(packet, 3, 4, 28), epoch: -1 },
    receivedAt: created, deliveryMilliseconds: 2, timing: { decoderMilliseconds: 3, reconstructionMilliseconds: 4, initializationMilliseconds: 5 } };
  frames.accept(image, packet, 14); frames.draw(.5);
  assert.equal(frames.metrics.sourceConsumed, 1); assert.equal(frames.metrics.painted, 1);
  assert.equal(frames.policy.metrics.staleSamples, 1); assert.equal(frames.policy.samples, 0);
  assert.ok(frames.metrics.presentationQueueMilliseconds >= 0); assert.ok(frames.metrics.visibleDrawMilliseconds >= 0);
  assert.equal(frames.metrics.workerDeliveryMilliseconds, 2); assert.equal(frames.metrics.rendererInitializationMilliseconds, 5);
  frames.close();
});

test('deferred event readiness cannot make an expired image eligible for calibration', () => {
  const frames = new AsciiFrames({ metadata: { version: 4 } }, 360, { draw() {} }, error => { throw error; }, () => {}, { renderer: 'auto' });
  frames.frameBytes = 48; frames.pump = () => {}; frames.nextOrdinal = 0;
  frames.policy = new RendererPolicy(1); frames.activateRenderer(0);
  const packet = { sourceFrame: 0, time: 0, end: 1 };
  const image = { renderer: 'canvas2d', renderWorkload: 'full', workerId: 0, renderDecision: frames.policy.request(packet, 3, 4, 28),
    deliveryMilliseconds: 2, timing: { decoderMilliseconds: 3, reconstructionMilliseconds: 4, initializationMilliseconds: 5 } };
  frames.accept(image, packet, 14);
  frames.accept({ consumed: true }, { sourceFrame: 1, time: 1, end: 2 }, 1);
  frames.draw(1.5);
  assert.equal(frames.displayedEnd, 2); assert.equal(frames.metrics.sourceConsumed, 2); assert.equal(frames.metrics.painted, 1);
  assert.equal(frames.policy.metrics.invalidSamples, 1); assert.equal(frames.policy.metrics.warmups, 0); assert.equal(frames.policy.samples, 0);
  frames.close();
});
