import { glyphMasks, reflectMask } from '../web/ascii.js';
import { AsciiGpu } from '../web/gpu.js';

export function verifyGpu() {
  const glyphs = glyphMasks.get('ascii-3x4-v2');
  const canvas = new OffscreenCanvas(3, 4);
  const gpu = new AsciiGpu(canvas);
  let cases = 0;
  const check = (cells, width, height, plan) => {
    gpu.draw(cells, width, height, plan);
    const bitmap = canvas.transferToImageBitmap();
    const output = new OffscreenCanvas(width, height);
    const context = output.getContext('2d', { alpha: false });
    try { context.drawImage(bitmap, 0, 0); } finally { bitmap.close(); }
    const pixels = context.getImageData(0, 0, width, height).data;
    const columns = width / 3;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const index = Math.floor(y / 4) * columns + Math.floor(x / 3);
      const cell = cells.subarray(index * 28, (index + 1) * 28);
      const scale = 1 << cell[0];
      const bit = 1 << (Math.floor((y % 4 + cell[2] * 4) / scale) * 3 + Math.floor((x % 3 + cell[1] * 3) / scale));
      let expected = cell.subarray(4, 7);
      for (let layer = 0; layer < cell[7]; layer++) {
        const offset = 8 + layer * 5;
        if (reflectMask(glyphs[cell[offset]], cell[offset + 1]) & bit) expected = cell.subarray(offset + 2, offset + 5);
      }
      const offset = (y * width + x) * 4;
      if (pixels[offset] !== expected[0] || pixels[offset + 1] !== expected[1] || pixels[offset + 2] !== expected[2] || pixels[offset + 3] !== 255) throw new Error(`GPU ASCII reconstruction differs at ${x},${y}, scale ${scale}.`);
    }
    cases++;
    return gpu.metrics;
  };
  try {
    for (const scale of [1, 2, 4, 8]) {
      const columns = scale === 1 ? 380 : scale;
      const rows = scale;
      const width = columns * 3; const height = rows * 4;
      const cells = new Uint8Array(columns * rows * 28);
      for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) {
        const index = y * columns + x;
        const cell = cells.subarray(index * 28, (index + 1) * 28);
        cell.set([Math.log2(scale), x % scale, y % scale, 32, 19, 173, 249, 1 + index % 4]);
        if (scale > 1) cell[7] = 4;
        for (let layer = 0; layer < cell[7]; layer++) cell.set([32 + (scale === 1 ? Math.floor(index / 4) + layer * 13 : 42 + layer * 11) % 95, (index + layer) % 4, 241 - layer * 47, 11 + layer * 59, 73 + layer * 37], 8 + layer * 5);
        if (scale > 1) for (let layer = 0; layer < 4; layer++) cell.set([65 + layer * 7, layer, 241 - layer * 47, 11 + layer * 59, 73 + layer * 37], 8 + layer * 5);
      }
      check(cells, width, height);
    }
    const columns = 128; const rows = 32; const cells = new Uint8Array(columns * rows * 28);
    for (let index = 0; index < columns * rows; index++) cells.set([0, 0, 0, 32, index % 256, 83, 197, 1, 47, index % 4, 231, 19, 113], index * 28);
    check(cells, columns * 3, rows * 4);
    const identical = check(cells, columns * 3, rows * 4);
    if (identical.uploadedBytes !== 0 || identical.reconstructedPixels !== 0) throw new Error('Identical ASCII image repeated GPU reconstruction.');
    cells[(13 * columns + 57) * 28 + 9] ^= 3;
    cells[(13 * columns + 57) * 28 + 10] ^= 127;
    const sparse = check(cells, columns * 3, rows * 4);
    if (sparse.full || sparse.changedCells !== 1 || sparse.uploadedBytes >= cells.length) throw new Error('Sparse ASCII changes did not use bounded GPU updates.');
    check(cells, columns * 3, rows * 4);
    for (let index = 0; index < columns * rows; index++) cells[index * 28 + 4] ^= 113;
    if (!check(cells, columns * 3, rows * 4).full) throw new Error('Dense ASCII changes did not use a complete GPU update.');
    const seeded = check(cells, columns * 3, rows * 4);
    if (seeded.uploadedBytes !== 0 || seeded.seededPixels !== columns * rows * 12) throw new Error('Dense-to-partial transition did not rebuild its exact retained image.');
    const retained = check(cells, columns * 3, rows * 4);
    if (retained.uploadedBytes !== 0 || retained.reconstructedPixels !== 0) throw new Error('Retained identical ASCII image repeated GPU work.');
    cells[(2 * columns + 97) * 28 + 10] ^= 53;
    if (check(cells, columns * 3, rows * 4).full) throw new Error('Sparse update after dense transition lost its retained image.');
    check(cells.subarray(0, 6 * 2 * 28), 18, 8);
    const emptyPlan = { full: false, changed: 0, rectangles: [] };
    const forced = check(cells, columns * 3, rows * 4, emptyPlan);
    if (!forced.full || forced.retainedAttributeBytes !== 0) throw new Error('Native plan did not force resize or remove the duplicate attribute cache.');
    if (check(cells, columns * 3, rows * 4, emptyPlan).reconstructedPixels !== 0) throw new Error('Native identical plan repeated retained reconstruction.');
    cells[(10 * columns + 37) * 28 + 10] ^= 41;
    const nativeSparse = check(cells, columns * 3, rows * 4, { full: false, changed: 1, rectangles: [{ x: 32, y: 8, width: 32, height: 8 }] });
    if (nativeSparse.full || nativeSparse.retainedAttributeBytes !== 0 || nativeSparse.uploadedBytes >= cells.length) throw new Error('Native sparse plan did not preserve exact bounded uploads.');
    for (const plan of [
      { full: false, changed: null, rectangles: [] },
      { full: false, changed: 1, rectangles: [] },
      { full: false, changed: 0, rectangles: [{ x: 0, y: 0, width: 1, height: 1 }] },
      { full: true, changed: -1, rectangles: [] },
      { full: false, changed: 1, rectangles: [{ x: columns, y: 0, width: 1, height: 1 }] },
      { full: false, changed: 1, rectangles: Array.from({ length: 33 }, () => ({ x: 0, y: 0, width: 1, height: 1 })) },
    ]) {
      let rejected = false;
      try { gpu.draw(cells, columns * 3, rows * 4, plan); } catch { rejected = true; }
      if (!rejected) throw new Error('Malformed native ASCII change plan was accepted.');
    }
    check(cells, columns * 3, rows * 4, emptyPlan);
    gpu.close();
    try { gpu.draw(new Uint8Array(28), 3, 4); } catch { return { cases, glyphs: 95, reflections: 4, scales: [1, 2, 4, 8], bitmapTransfer: true, exactSparseUpdates: true, identicalUploadBytes: identical.uploadedBytes }; }
    throw new Error('Closed GPU reconstruction remained usable.');
  } finally { gpu.close(); }
}
