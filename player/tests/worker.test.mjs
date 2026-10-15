import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkerDecoder } from '../web/worker.js';

class WorkerStub {
  constructor() { this.messages = []; }
  postMessage(message) { if (this.fail) throw new Error('Cannot post packet'); this.messages.push(message); }
  terminate() { this.terminated = true; }
}

test('preparation initializes the worker before packets and validates its acknowledgment', async () => {
  const original = globalThis.Worker; globalThis.Worker = WorkerStub;
  try {
    const module = {};
    const decoder = new WorkerDecoder({ gpu: false, module });
    await assert.rejects(decoder.prepare(4, 4), /dimensions/);
    const preparing = decoder.prepare(1920, 1080);
    const request = decoder.worker.messages[0];
    assert.equal(request.type, 'prepare'); assert.equal(request.module, module); assert.equal(request.gpu, false);
    decoder.worker.onmessage({ data: { id: request.id, prepared: true, memoryBytes: 65536 } });
    await preparing; assert.equal(decoder.memoryBytes, 65536); assert.equal(decoder.module, undefined);
    const invalid = decoder.prepare(3, 4);
    decoder.worker.onmessage({ data: { id: decoder.worker.messages[1].id } });
    await assert.rejects(invalid, /did not prepare/);
    const pending = decoder.prepare(3, 4); decoder.close();
    await assert.rejects(pending, { name: 'AbortError' });
  } finally { globalThis.Worker = original; }
});

test('worker queue bounds pending packets and releases all requests on close', async () => {
  const original = globalThis.Worker; globalThis.Worker = WorkerStub;
  try {
    const decoder = new WorkerDecoder();
    const packet = { bytes: Uint8Array.of(1), tag: 6, decoded: 28 };
    const pending = Array.from({ length: 8 }, () => decoder.decode(packet, 3, 4, 28, true).catch(error => error));
    assert.equal(decoder.pending.size, 8);
    await assert.rejects(decoder.decode(packet, 3, 4, 28, true), /queue limit/);
    decoder.close();
    assert.equal(decoder.pending.size, 0);
    assert.equal(decoder.worker.terminated, true);
    assert.ok((await Promise.all(pending)).every(error => error.name === 'AbortError'));
    await assert.rejects(decoder.decode(packet, 3, 4, 28, true), { name: 'AbortError' });
  } finally { globalThis.Worker = original; }
});

test('worker posting failures do not consume queue capacity and stale bitmaps close', async () => {
  const original = globalThis.Worker; globalThis.Worker = WorkerStub;
  try {
    const decoder = new WorkerDecoder(); decoder.worker.fail = true;
    for (let index = 0; index < 12; index++) await assert.rejects(decoder.decode({ bytes: Uint8Array.of(1) }, 3, 4, 28, true), /Cannot post/);
    assert.equal(decoder.pending.size, 0);
    await assert.rejects(decoder.decode({}, 3, 4, 28, true));
    assert.equal(decoder.pending.size, 0);
    let closed = false;
    decoder.worker.onmessage({ data: { id: 999, bitmap: { close() { closed = true; } } } });
    assert.equal(closed, true); decoder.close();
  } finally { globalThis.Worker = original; }
});


test('worker rejects invalid and oversized inputs before copying or posting', async () => {
  const original = globalThis.Worker; globalThis.Worker = WorkerStub;
  try {
    const decoder = new WorkerDecoder();
    const oversized = new Uint8Array(16 * 1024 * 1024 + 1);
    let copied = false; oversized.slice = () => { copied = true; throw new Error('Unexpected copy'); };
    for (const bytes of [oversized, new Uint8Array(), new ArrayBuffer(16), undefined]) {
      await assert.rejects(decoder.decode({ bytes }, 3, 4, 28, true), /Invalid SCI decoder input/);
      assert.equal(decoder.pending.size, 0);
    }
    assert.equal(copied, false); assert.equal(decoder.worker.messages.length, 0); decoder.close();
  } finally { globalThis.Worker = original; }
});

test('automatic decisions retain exact ownership and close mismatched replies', async () => {
  const original = globalThis.Worker; globalThis.Worker = WorkerStub;
  try {
    const decoder = new WorkerDecoder({ gpu: false, automaticRenderer: true });
    const packet = { sourceFrame: 2, bytes: Uint8Array.of(1) };
    const decision = { epoch: 1, sourceFrame: 2, width: 3, height: 4, format: 28, gpu: true, releaseGpu: false };
    for (const invalid of [undefined, { ...decision, epoch: NaN }, { ...decision, sourceFrame: -1 }, { ...decision, width: 6 }, { ...decision, format: 29 }]) await assert.rejects(decoder.decode(packet, 3, 4, 28, true, undefined, true, invalid), /ownership/);
    assert.equal(decoder.pending.size, 0); assert.equal(decoder.worker.messages.length, 0);
    const result = decoder.decode(packet, 3, 4, 28, true, undefined, true, decision);
    decision.epoch = 9;
    const request = decoder.worker.messages[0]; assert.equal(request.renderDecision.epoch, 1);
    let closed = 0;
    decoder.worker.onmessage({ data: { id: request.id, renderDecision: { ...request.renderDecision, height: 8 }, bitmap: { close() { closed++; } } } });
    await assert.rejects(result, /ownership/); assert.equal(closed, 1); assert.equal(decoder.pending.size, 0);
    decoder.close();
  } finally { globalThis.Worker = original; }
});
