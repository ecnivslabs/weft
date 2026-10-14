import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareConventional } from './conventional.mjs';

const quality = {width:64, height:48, frames:6, fpsNumerator:10, fpsDenominator:1, duration:0.6, audio:true};
const rgb = Buffer.alloc(quality.width * quality.height * quality.frames * 3);
for (let frame = 0; frame < quality.frames; frame++) {
  for (let y = 0; y < quality.height; y++) {
    for (let x = 0; x < quality.width; x++) {
      const offset = ((frame * quality.height + y) * quality.width + x) * 3;
      rgb[offset] = (x * 3 + frame * 7) % 256;
      rgb[offset + 1] = (y * 5 + frame * 11) % 256;
      rgb[offset + 2] = (x * 2 + y * 3 + frame * 13) % 256;
    }
  }
}
const temporary = mkdtempSync(join(tmpdir(), 'weft-conventional-test-'));
try {
  const source = join(temporary, 'reference.nut');
  const fixture = spawnSync('ffmpeg', ['-nostdin', '-v', 'error', '-filter_threads', '1', '-threads', '2',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', '64x48', '-r', '10', '-i', 'pipe:0',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-map', '0:v:0', '-map', '1:a:0',
    '-t', '0.6', '-c:v', 'ffv1', '-pix_fmt', 'bgr0', '-c:a', 'pcm_s16le', source], {input:rgb});
  if (fixture.error) throw fixture.error;
  assert.equal(fixture.status, 0, fixture.stderr.toString());
  const expectedHash = createHash('sha256').update(rgb).digest('hex');
  for (const [codec, pixelFormat, encoder] of [
    ['H.264', 'rgb24', 'libx264rgb'],
    ['H.264', 'yuv444p', 'libx264'],
    ['AV1', 'yuv444p', 'libaom-av1'],
  ]) {
    const comparison = compareConventional(source, quality, 20, codec, pixelFormat, false, true);
    assert.ok(Number.isFinite(comparison.ssim) && comparison.ssim >= -1 && comparison.ssim <= 1);
    assert.equal(comparison.ssimReference, 'Exact source and decoded RGB24 with matching raw-frame timestamps');
    assert.equal(comparison.encoder, encoder);
    assert.equal(comparison.referenceSha256, expectedHash, 'All encoders must receive the exact RGB reference.');
    assert.equal(comparison.audio, 'Opus 96 kbit/s');
    assert.equal(comparison.timingMeasured, false);
    assert.deepEqual(comparison.seconds, []);
    assert.ok(comparison.bytes > 0);
    assert.ok(comparison.storedPixelFormat);
    assert.ok(Number.isFinite(comparison.mse) && comparison.mse > 0);
    assert.equal(comparison.qualityMatched, Math.abs(comparison.qualityDifferenceDb) <= 0.5);
  }
  assert.throws(() => compareConventional(source, quality, 0), /positive finite target MSE/);
  assert.throws(() => compareConventional(source, quality, 20, 'Unknown'), /Unsupported comparison codec/);
  assert.throws(() => compareConventional(source, quality, 20, 'AV1', 'rgb24'), /requires a YUV/);
  assert.throws(() => compareConventional(source, {...quality, frames:Infinity}, 20), /Invalid comparison frames/);
  assert.throws(() => compareConventional(join(temporary, 'absent.nut'), quality, 20), /No such file or directory/);
  console.log('Exact RGB baseline tests passed.');
} finally {
  rmSync(temporary, {recursive:true, force:true});
}
