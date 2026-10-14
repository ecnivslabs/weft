import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { Decoder } from '../web/wasm.js';

const module = readFileSync(new URL('../web/decoder.wasm', import.meta.url));
function packet(data, decoded = data.length) { return { tag: 6, decoded, bytes: deflateSync(data) }; }
function cell() { const data = new Uint8Array(28); data[3] = 32; data.set([23, 141, 97], 4); return data; }

function spatial(cells) {
  const count = cells.length / 28;
  const columns=128;
  const data=new Uint8Array(cells.length);
  for(let channel=0;channel<28;channel++) for(let index=0;index<count;index++) {
    const left=index%columns?cells[(index-1)*28+channel]:0;
    const above=index>=columns?cells[(index-columns)*28+channel]:0;
    const corner=index>=columns&&index%columns?cells[(index-columns-1)*28+channel]:0;
    const value=left+above-corner;
    const distances=[Math.abs(value-left),Math.abs(value-above),Math.abs(value-corner)];
    const prediction=distances[0]<=distances[1]&&distances[0]<=distances[2]?left:distances[1]<=distances[2]?above:corner;
    data[channel*count+index]=(cells[index*28+channel]-prediction+256)%256;
  }
  return packet(data);
}

test('painted plans compare the last presentation across deferred frames and independent resets', async () => {
  const decoder = await Decoder.open(module);
  assert.equal(decoder.supportsPaintedPlan, true);
  const width = 384; const height = 96; const cells = new Uint8Array(128 * 24 * 28);
  for (let index = 0; index < cells.length; index += 28) cells.set(cell(), index);
  decoder.decodeCells(spatial(cells), width, height, 28, true);
  assert.deepEqual(decoder.paintedPlan(), { full: true, changed: 3072, rectangles: [{ x: 0, y: 0, width: 128, height: 24 }] });
  decoder.commitPainted();
  decoder.decodeCells(spatial(cells), width, height, 28, true);
  assert.deepEqual(decoder.paintedPlan(), { full: false, changed: 0, rectangles: [] });
  decoder.commitPainted();
  const deferred = cells.slice(); deferred[33 * 28 + 4]++;
  decoder.decodeCells(spatial(deferred), width, height, 28);
  const selected = cells.slice(); selected[100 * 28 + 6]++;
  decoder.decodeCells(spatial(selected), width, height, 28);
  assert.deepEqual(decoder.paintedPlan(), { full: false, changed: 1, rectangles: [{ x: 96, y: 0, width: 32, height: 8 }] });
  assert.deepEqual(decoder.currentCells(width, height, 28), selected);
  assert.throws(() => decoder.currentCells(192, 192, 28), /configuration/);
  assert.throws(() => decoder.currentCells(width, height, 29), /configuration/);
  decoder.commitPainted();
  decoder.decodeCells(spatial(selected), width, height, 28);
  assert.deepEqual(decoder.paintedPlan(), { full: false, changed: 0, rectangles: [] });
  decoder.decodeCells(spatial(selected), width, height, 28);
  assert.throws(() => decoder.commitPainted(), /missing or stale/);
  assert.equal(decoder.paintedPlan().full, true);
  decoder.commitPainted();
  const invalid = selected.slice(); invalid[3] = 1;
  assert.throws(() => decoder.decodeCells(spatial(invalid), width, height, 28), /Invalid/);
  assert.throws(() => decoder.paintedPlan(), /cell-output/);
  decoder.decodeCells(spatial(selected), width, height, 28, true);
  assert.equal(decoder.paintedPlan().full, true);
});

test('optional painted ABI preserves older modules and refreshes views after memory growth', async () => {
  const decoder = await Decoder.open(module);
  const legacy = new Decoder(Object.fromEntries(Object.entries(decoder.exports).filter(([name]) => !name.startsWith('dirty_') && name !== 'commit_painted')));
  assert.equal(legacy.supportsPaintedPlan, false);
  assert.equal(legacy.paintedPlan(), undefined);
  legacy.commitPainted();
  const borrowed = legacy.decodeCells(packet(cell()), 3, 4, 28, true, 'ascii-3x4-v2', false);
  decoder.exports.memory.grow(1);
  assert.equal(borrowed.byteLength, 0);
  const current = legacy.currentCells(3, 4, 28, false);
  assert.deepEqual(current, cell());
  assert.equal(decoder.paintedPlan().full, true);
  decoder.commitPainted();
});

test('native inflation and WASM inflation reconstruct identical ASCII pixels', async () => {
  const native = await Decoder.open(module);
  const wasm = await Decoder.open(module);
  const data = packet(cell());
  assert.deepEqual(await native.decodeNative(data, 3, 4, 28, true), wasm.decode(data, 3, 4, 28, true));
});

test('native inflation bounds expansion, checks length and rejects invalid zlib streams', async () => {
  const decoder = await Decoder.open(module);
  const good = packet(cell());
  const expected = await decoder.decodeNative(good, 3, 4, 28, true);
  for (const bad of [
    { ...good, decoded: 27 },
    { ...good, decoded: 29 },
    { ...good, bytes: good.bytes.subarray(0, good.bytes.length - 1) },
    { ...good, bytes: Uint8Array.from([...good.bytes, 0]) },
    packet(new Uint8Array(1024 * 1024), 28),
    { ...good, decoded: 16 * 1024 * 1024 + 1 },
  ]) {
    await assert.rejects(decoder.decodeNative(bad, 3, 4, 28));
    assert.deepEqual(await decoder.decodeNative(good, 3, 4, 28, true), expected);
  }
});

test('native decoding rejects overlapping frame operations', async () => {
  const decoder = await Decoder.open(module);
  const good = packet(cell());
  const first = decoder.decodeNative(good, 3, 4, 28, true);
  await assert.rejects(decoder.decodeNative(good, 3, 4, 28, true), /pending frame/);
  assert.throws(() => decoder.decode(good, 3, 4, 28, true), /pending frame/);
  await first;
});


test('cell output preserves validated ASCII references and rejects output mode changes without reset', async () => {
  const decoder = await Decoder.open(module);
  const good = packet(cell());
  assert.deepEqual(decoder.decodeCells(good, 3, 4, 28, true), cell());
  assert.equal(decoder.exports.pixels_length(), 0);
  assert.throws(() => decoder.decode(good, 3, 4, 28), /without reset/);
  assert.deepEqual(await decoder.decodeCellsNative(good, 3, 4, 28, true), cell());
  const invalid = cell(); invalid[7] = 5;
  assert.throws(() => decoder.decodeCells(packet(invalid), 3, 4, 28), /Invalid/);
  assert.equal(decoder.exports.frame_length(), 0);
  assert.deepEqual(decoder.decodeCells(good, 3, 4, 28, true), cell());
});


test('CPU fallback renders the current cells without consuming or resetting the reference', async () => {
  const decoder = await Decoder.open(module);
  const good = packet(cell());
  assert.throws(() => decoder.renderCurrentCells(3, 4), /cell-output frame/);
  decoder.decodeCells(good, 3, 4, 28, true);
  const expected = (await Decoder.open(module)).decode(good, 3, 4, 28, true);
  assert.deepEqual(decoder.renderCurrentCells(3, 4), expected);
  assert.deepEqual(new Uint8Array(decoder.exports.memory.buffer, decoder.exports.frame(), decoder.exports.frame_length()), cell());
  assert.deepEqual(decoder.decodeCells(good, 3, 4, 28), cell());
  assert.deepEqual(decoder.renderCurrentCells(3, 4), expected);
});

test('removed codec selectors, fonts and packet tags fail and clear output',async()=>{
  const decoder=await Decoder.open(module);const good=packet(cell());
  for(const format of [7,8,29,30]) {assert.throws(()=>decoder.decode(good,3,4,format,true),/Unsupported/);await assert.rejects(decoder.decodeNative(good,3,4,format,true));}
  assert.throws(()=>decoder.decode(good,3,4,28,true,'ascii-3x4-v1'),/Unsupported/);
  for(const tag of [0,1,2,3,8,9]) {assert.throws(()=>decoder.decode({...good,tag},3,4,28,true),/Invalid/);assert.equal(decoder.exports.frame_length(),0);}
  assert.deepEqual(decoder.decodeCells(good,3,4,28,true),cell());
});
