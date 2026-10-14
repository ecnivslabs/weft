import test from 'node:test';
import assert from 'node:assert/strict';
import { AttributeUpdates } from '../web/gpu.js';

function checkSnapshot(updates, cells) {
  assert.deepEqual(updates.bytes, new Uint8Array(cells));
}

test('attribute cache preserves exact bytes, owns its snapshot, and skips identical uploads', () => {
  const updates = new AttributeUpdates(65, 17);
  const cells = Uint8Array.from({ length: updates.count * 28 }, (_, index) => (index * 73 + 109) % 256);
  assert.equal(updates.update(cells).full, true);
  checkSnapshot(updates, cells);
  assert.deepEqual(updates.update(cells), { full: false, changed: 0, rectangles: [] });
  cells[(9 * 65 + 40) * 28 + 27] ^= 127;
  const update = updates.update(cells);
  assert.equal(update.changed, 1); assert.equal(update.full, false);
  assert.deepEqual(update.rectangles, [{ x: 32, y: 8, width: 32, height: 8 }]);
  checkSnapshot(updates, cells);
  assert.equal(updates.update(cells).changed, 0);
});

test('dirty rectangles merge adjacent tile rows, clip edges, and bound fragmented calls', () => {
  const updates = new AttributeUpdates(128, 32);
  const cells = new Uint8Array(updates.count * 28);
  updates.update(cells);
  for (const [x, y] of [[33, 1], [65, 1], [33, 9], [65, 9]]) cells[(y * 128 + x) * 28] = 1;
  assert.deepEqual(updates.update(cells).rectangles, [{ x: 32, y: 0, width: 64, height: 16 }]);
  const edges = new AttributeUpdates(33, 9); const edgeCells = new Uint8Array(edges.count * 28);
  edges.update(edgeCells); edgeCells[(8 * 33 + 32) * 28 + 7] = 1;
  assert.deepEqual(edges.update(edgeCells).rectangles, [{ x: 32, y: 8, width: 1, height: 1 }]);
  const fragmented = new AttributeUpdates(640, 270); const scattered = new Uint8Array(fragmented.count * 28);
  fragmented.update(scattered);
  for (let tile = 0; tile < 100; tile += 2) {
    const row = Math.floor(tile / 20); const column = tile % 20 + row % 2;
    scattered[(row * 8 * 640 + column * 32) * 28] = 1;
  }
  const result = fragmented.update(scattered);
  assert.equal(result.full, true); assert.equal(result.rectangles.length, 1);
  checkSnapshot(fragmented, scattered);
});

test('unaligned byte views and dense changes preserve snapshot data and force complete updates', () => {
  for (const backing of [new Uint8Array(561), Buffer.alloc(561)]) {
    const view = backing.subarray(1);
    const updates = new AttributeUpdates(5, 4);
    view.fill(0x57); updates.update(view); checkSnapshot(updates, view);
    view.fill(0xe3);
    assert.equal(updates.update(view).full, true); checkSnapshot(updates, view);
    assert.equal(updates.update(view, true).full, true);
    assert.throws(() => updates.update(view.subarray(1)), /buffer/);
  }
  for (const [columns, rows] of [[0, 1], [1, 0], [1366, 1], [1, 271], [NaN, 1]]) {
    assert.throws(() => new AttributeUpdates(columns, rows), /dimensions/);
  }
});
