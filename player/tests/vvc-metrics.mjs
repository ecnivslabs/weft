import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

export function run(program, arguments_, output) {
  const file = output ? openSync(output, 'wx') : undefined;
  try {
    const result = spawnSync(program, arguments_, {
      encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', file ?? 'pipe', 'pipe'],
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `${program}: ${result.stderr}`);
    return { stdout: result.stdout, stderr: result.stderr };
  } finally { if (file !== undefined) closeSync(file); }
}

export function rgbMetrics(reference, decoded, frameBytes, frames) {
  assert.ok(Number.isSafeInteger(frameBytes) && frameBytes > 0);
  assert.ok(Number.isSafeInteger(frames) && frames > 0);
  const expected = frameBytes * frames;
  assert.equal(statSync(reference).size, expected, 'Reference frame count differs.');
  assert.equal(statSync(decoded).size, expected, 'Decoded frame count differs.');
  const files = [];
  try {
    files.push(openSync(reference, 'r'));
    files.push(openSync(decoded, 'r'));
    const buffers = [Buffer.alloc(frameBytes), Buffer.alloc(frameBytes)];
    const hashes = [createHash('sha256'), createHash('sha256')];
    let squared = 0;
    for (let frame = 0; frame < frames; frame++) {
      for (let side = 0; side < 2; side++) {
        assert.equal(readSync(files[side], buffers[side], 0, frameBytes, frame * frameBytes), frameBytes);
        hashes[side].update(buffers[side]);
      }
      for (let index = 0; index < frameBytes; index++) squared += (buffers[0][index] - buffers[1][index]) ** 2;
    }
    const mse = squared / expected;
    return { mse, psnr: mse ? 10 * Math.log10(255 ** 2 / mse) : 'Infinity',
      referenceSha256: hashes[0].digest('hex'), reconstructionSha256: hashes[1].digest('hex') };
  } finally { files.forEach(closeSync); }
}

export function fileHash(path) {
  const file = openSync(path, 'r');
  try {
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(1024 * 1024);
    let length;
    while ((length = readSync(file, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, length));
    return hash.digest('hex');
  } finally { closeSync(file); }
}

export function rawInput(path, quality) {
  return ['-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${quality.width}x${quality.height}`,
    '-r', `${quality.fpsNumerator}/${quality.fpsDenominator}`, '-i', path];
}

export function ssim(reference, decoded, quality) {
  const { stderr } = run('ffmpeg', ['-nostdin', '-v', 'info', '-filter_complex_threads', '1',
    ...rawInput(decoded, quality), ...rawInput(reference, quality),
    '-lavfi', '[0:v]format=yuv444p[d];[1:v]format=yuv444p[r];[d][r]ssim',
    '-frames:v', String(quality.frames), '-an', '-f', 'null', '-']);
  const value = Number(stderr.match(/SSIM.*All:(-?[\d.]+)/)?.[1]);
  assert.ok(Number.isFinite(value) && value >= -1 && value <= 1, 'SSIM output missing or invalid.');
  return value;
}
