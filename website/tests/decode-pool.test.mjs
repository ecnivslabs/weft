import test from 'node:test';
import assert from 'node:assert/strict';
import { DecoderPool, partition } from '../web/decode-pool.js';

const packet = (tag, time) => ({ tag, time, duration: 1 });
const settle = () => new Promise(resolve => setImmediate(resolve));

test('partition preserves temporal dependency ownership and skips complete past sequences', () => {
  const packets = [packet(6, 0), packet(7, 1), packet(8, 2), packet(9, 3), packet(5, 4), packet(4, 5)];
  assert.deepEqual(partition(packets, 0).map(item => [item.first, item.last]), [[0, 3], [3, 5], [5, 6]]);
  assert.deepEqual(partition(packets, 3).map(item => [item.first, item.last]), [[3, 5], [5, 6]]);
  assert.deepEqual(partition(packets, 1.5).map(item => item.first), [0, 3, 5]);
  assert.throws(() => partition([packet(7, 0)], 0), /dependency/);
});

test('seek partition uses the exact stored end at fractional frame boundaries', () => {
  const first = { ...packet(6, .35), duration: .016667, end: .366667 };
  const next = { ...packet(6, .366667), duration: .016666, end: .383333 };
  assert.equal(partition([first, next], first.time + first.duration).length, 2);
  assert.deepEqual(partition([first, next], first.end).map(segment => segment.first), [1]);
});

test('pool decodes dependency chains sequentially on their owner with global backpressure', async () => {
  const decoders = []; const output = []; const completed = []; let reserved = 0; let peak = 0;
  const factory = () => {
    const decoder = { calls: [], decode(packet, width, height, format, reset) {
      assert.equal(this.pending, undefined);
      this.calls.push({ packet, reset });
      return new Promise((resolve, reject) => { this.pending = { resolve, reject }; });
    }, finish() { const pending = this.pending; this.pending = undefined; pending.resolve({}); },
    close() { this.pending?.reject(new DOMException('Closed', 'AbortError')); this.pending = undefined; } };
    decoders.push(decoder); return decoder;
  };
  const pool = new DecoderPool(2, {}, {
    reserve: () => { if (reserved === 2) return false; reserved++; peak = Math.max(peak, reserved); return true; },
    release: () => reserved--,
    accept: (_, packet) => output.push(packet.time), complete: segment => completed.push(segment.first),
    fail: error => { throw error; },
  }, factory);
  pool.add(partition([packet(6, 0), packet(7, 1), packet(9, 2), packet(8, 3), packet(4, 4)], 0));
  pool.pump(0, 10, 3, 4, 28, 'ascii-3x4-v2');
  assert.equal(reserved, 2);
  decoders[1].finish(); await settle();
  assert.deepEqual(decoders[1].calls.map(item => [item.packet.time, item.reset]), [[2, true], [3, false]]);
  decoders[0].finish(); await settle();
  assert.deepEqual(decoders[0].calls.map(item => [item.packet.time, item.reset]), [[0, true], [1, false]]);
  decoders[0].finish(); decoders[1].finish(); await settle();
  const last = decoders.find(decoder => decoder.pending); last.finish(); await settle();
  assert.deepEqual(output.sort((a,b) => a-b), [0,1,2,3,4]);
  assert.equal(completed.length, 3); assert.equal(peak, 2); assert.equal(reserved, 0);
  pool.close();
});

test('closing pool releases in-flight reservations and closes late bitmaps', async () => {
  let finish; let reservation = 0; let closed = 0;
  const pool = new DecoderPool(1, {}, {
    reserve: () => { reservation++; return true; }, release: () => reservation--,
    accept: () => assert.fail('Closed output escaped'), complete() {}, fail: () => assert.fail('Closed pool failed'),
  }, () => ({ decode: () => new Promise(resolve => { finish = resolve; }), close() {} }));
  pool.add(partition([packet(6, 0)], 0)); pool.pump(0, 1, 3, 4, 28, 'ascii-3x4-v2');
  pool.close(); finish({ bitmap: { close: () => closed++ } }); await settle();
  assert.equal(reservation, 0); assert.equal(closed, 1);
});

test('future bitmaps cannot consume the reservation needed by an earlier dependent chain', async () => {
  const decoders=[];const queue=[];let reserved=0;
  const pool=new DecoderPool(4,{}, {
    reserve:()=>{if(queue.length+reserved>=4)return false;reserved++;return true;},release:()=>reserved--,
    accept:(_,packet)=>queue.push(packet.time),complete(){},fail:error=>{throw error;},
  },()=>{const decoder={calls:[],decode(packet){this.calls.push(packet.time);return new Promise(resolve=>{this.finish=()=>{this.finish=null;resolve({});};});},close(){}};decoders.push(decoder);return decoder;});
  pool.add(partition([packet(6,0),packet(7,0.01),packet(7,0.02),packet(6,0.04),packet(6,0.05),packet(6,0.06),packet(6,0.07)],0));
  pool.pump(0,1,3,4,28,'ascii-3x4-v2');
  for(const decoder of decoders.slice(1))decoder.finish();await settle();
  assert.equal(queue.length,3);assert.equal(reserved,1);
  decoders[0].finish();await settle();assert.equal(queue.length,4);assert.equal(reserved,0);
  queue.splice(queue.indexOf(0),1);pool.pump(0.01,1,3,4,28,'ascii-3x4-v2');
  assert.deepEqual(decoders[0].calls,[0,0.01]);
  assert.equal(decoders.flatMap(decoder=>decoder.calls).includes(0.07),false);
  decoders[0].finish();await settle();
  queue.splice(queue.indexOf(0.01),1);pool.pump(0.02,1,3,4,28,'ascii-3x4-v2');
  assert.deepEqual(decoders[0].calls,[0,0.01,0.02]);
  decoders[0].finish();await settle();pool.close();
});
