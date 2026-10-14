import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32, IntegrityVerifier } from '../web/checksum.js';

test('sliced CRC preserves standard checks and unaligned bytewise tail results', () => {
  const reference = bytes => {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  assert.equal(crc32(new Uint8Array()), 0);
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  const bytes = new Uint8Array(65561);
  let seed = 183771;
  for (let index = 0; index < bytes.length; index++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    bytes[index] = seed >>> 24;
  }
  for (const offset of [0, 1, 3, 7, 13]) {
    for (const length of [...Array.from({ length: 33 }, (_, index) => index), 255, 256, 257, 1023, 4096, 65536]) {
      const view = bytes.subarray(offset, offset + length);
      assert.equal(crc32(view), reference(view));
    }
  }
});

class WorkerStub {
  constructor() {this.messages=[];}
  postMessage(data) {this.messages.push(data);if(this.fail)throw new Error('Post failed');}
  terminate(){this.terminated=true;}
}

test('integrity cancellation keeps transferred buffers reserved until the worker reply', async () => {
  const original=globalThis.Worker;globalThis.Worker=WorkerStub;
  try {
    const verifier=new IntegrityVerifier();const controller=new AbortController();
    const pending=verifier.verify(new Uint8Array(16),0,controller.signal);
    controller.abort();assert.equal(verifier.bytes,16);assert.equal(verifier.pending.size,1);
    verifier.worker.onmessage({data:{id:1,bytes:new Uint8Array(16)}});
    await assert.rejects(pending,{name:'AbortError'});
    assert.equal(verifier.bytes,0);assert.equal(verifier.pending.size,0);verifier.close();
  } finally {globalThis.Worker=original;}
});

test('integrity worker rejects oversized queues, posting failures and worker errors without leaking reservations', async () => {
  const original=globalThis.Worker;globalThis.Worker=WorkerStub;
  try {
    const verifier=new IntegrityVerifier();const signal=new AbortController().signal;
    await assert.rejects(verifier.verify(new Uint8Array(17*1024*1024),0,signal),/limit/);
    verifier.worker.fail=true;
    await assert.rejects(verifier.verify(new Uint8Array(16),0,signal),/Post failed/);
    assert.equal(verifier.bytes,0);verifier.worker.fail=false;
    const pending=Array.from({length:8},()=>verifier.verify(new Uint8Array(16),0,signal).catch(error=>error));
    await assert.rejects(verifier.verify(new Uint8Array(16),0,signal),/limit/);
    verifier.worker.onerror({message:'CRC worker crashed'});
    assert.ok((await Promise.all(pending)).every(error=>error.message==='CRC worker crashed'));
    assert.equal(verifier.bytes,0);assert.equal(verifier.pending.size,0);assert.equal(verifier.closed,true);
  } finally {globalThis.Worker=original;}
});
