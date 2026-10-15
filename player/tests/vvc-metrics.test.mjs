import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileHash, rgbMetrics, run, ssim } from './vvc-metrics.mjs';

const temporary = mkdtempSync(join(tmpdir(), 'weft-vvc-metrics-test-'));
try {
  const reference = join(temporary, 'reference.rgb');
  const decoded = join(temporary, 'decoded.rgb');
  const rgb = Buffer.alloc(16 * 16 * 3 * 3, 100);
  writeFileSync(reference, rgb);
  writeFileSync(decoded, Buffer.alloc(rgb.length, 102));
  const metrics = rgbMetrics(reference, decoded, 16 * 16 * 3, 3);
  assert.equal(metrics.mse, 4);
  assert.equal(metrics.psnr, 10 * Math.log10(255 ** 2 / 4));
  assert.equal(metrics.referenceSha256, createHash('sha256').update(rgb).digest('hex'));
  assert.equal(fileHash(reference), metrics.referenceSha256);
  assert.equal(rgbMetrics(reference, reference, 16 * 16 * 3, 3).psnr, 'Infinity');
  assert.throws(() => rgbMetrics(reference, decoded, 16 * 16 * 3, 4), /Reference frame count differs/);
  writeFileSync(decoded, Buffer.alloc(rgb.length - 1));
  assert.throws(() => rgbMetrics(reference, decoded, 16 * 16 * 3, 3), /Decoded frame count differs/);
  const quality = { width: 16, height: 16, frames: 3, fpsNumerator: 10, fpsDenominator: 1 };
  assert.equal(ssim(reference, reference, quality), 1);
  assert.throws(() => run(process.execPath, ['-e', 'process.exit(2)']), /node/);
  assert.throws(() => run(join(temporary, 'missing'), []), /ENOENT/);
  console.log('Bounded RGB comparison metrics passed.');
} finally { rmSync(temporary, { recursive: true, force: true }); }
