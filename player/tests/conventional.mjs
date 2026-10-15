import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// This is an explicit external comparison, never a weft playback path.
export function compareConventional(source, quality, targetMse, codec = 'H.264', pixelFormat = 'yuv444p', measureTimes = true, measureSsim = false) {
  assert.equal(typeof measureSsim, 'boolean', 'SSIM measurement flag must be boolean.');
  assert.ok(['H.264', 'AV1'].includes(codec), 'Unsupported comparison codec.');
  assert.ok(['yuv444p', 'yuv444p10le', 'rgb24'].includes(pixelFormat), 'Unsupported comparison pixel format.');
  assert.ok(codec !== 'AV1' || pixelFormat !== 'rgb24', 'AV1 comparison requires a YUV pixel format.');
  assert.ok(Number.isFinite(targetMse) && targetMse > 0, 'Comparison requires a positive finite target MSE.');
  for (const field of ['width', 'height', 'frames', 'fpsNumerator', 'fpsDenominator']) {
    assert.ok(Number.isSafeInteger(quality[field]) && quality[field] > 0, `Invalid comparison ${field}.`);
  }
  assert.ok(Number.isFinite(quality.duration) && quality.duration > 0, 'Invalid comparison duration.');
  const frameSize = quality.width * quality.height * 3;
  assert.ok(Number.isSafeInteger(frameSize * quality.frames) && frameSize * quality.frames <= 128 * 1024 * 1024);
  const temporary = mkdtempSync(join(tmpdir(), 'weft-conventional-'));
  try {
    function run(arguments_, capture = false) {
      const result = spawnSync('ffmpeg', ['-nostdin', '-v', 'error', '-filter_threads', '1', '-threads', '2', ...arguments_], { maxBuffer: capture ? 128 * 1024 * 1024 : 1024 * 1024 });
      if (result.error) throw result.error;
      assert.equal(result.status, 0, result.stderr.toString());
      return result.stdout;
    }
    const filter = `fps=${quality.fpsNumerator}/${quality.fpsDenominator}:start_time=0,scale=${quality.width}:${quality.height}:flags=lanczos`;
    const duration = String(quality.duration);
    const reference = run(['-i', source, '-map', '0:v:0', '-an', '-vf', filter, '-t', duration, '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], true);
    assert.equal(reference.length, frameSize * quality.frames);
    const encoder = codec === 'AV1' ? 'libaom-av1' : pixelFormat === 'rgb24' ? 'libx264rgb' : 'libx264';
    function encode(crf, output) {
      const arguments_ = ['-nostdin', '-v', 'error', '-filter_threads', '1', '-threads', '2',
        '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${quality.width}x${quality.height}`,
        '-r', `${quality.fpsNumerator}/${quality.fpsDenominator}`, '-i', 'pipe:0',
        ...(quality.audio ? ['-i', source] : []), '-map', '0:v:0',
        ...(quality.audio ? ['-map', '1:a:0'] : []), '-t', duration,
        ...(codec === 'AV1' ? ['-c:v', encoder, '-cpu-used', '6', '-row-mt', '1', '-b:v', '0'] : ['-c:v', encoder, '-preset', 'medium']),
        '-threads', '2', '-crf', String(crf),
        '-g', String(Math.max(1, Math.round(quality.fpsNumerator / quality.fpsDenominator))), '-pix_fmt', pixelFormat,
        '-c:a', 'libopus', '-b:a', '96k', '-ar', '48000', '-ac', '2', output];
      const result = spawnSync('ffmpeg', arguments_, {input:reference, maxBuffer:1024*1024});
      if (result.error) throw result.error;
      assert.equal(result.status, 0, result.stderr.toString());
    }
    function mse(output) {
      const decoded = run(['-i', output, '-map', '0:v:0', '-an', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], true);
      assert.equal(decoded.length, reference.length);
      let squared = 0;
      for (let index = 0; index < decoded.length; index++) squared += (decoded[index] - reference[index]) ** 2;
      return squared / decoded.length;
    }
    let lower = 0;
    let upper = codec === 'AV1' ? 63 : 51;
    let best;
    while (lower <= upper) {
      const crf = Math.floor((lower + upper) / 2);
      const output = join(temporary, `search-${crf}.mkv`);
      encode(crf, output);
      const error = mse(output);
      if (!best || Math.abs(error - targetMse) < Math.abs(best.mse - targetMse)) best = {crf,mse:error};
      if (error < targetMse) lower = crf + 1; else upper = crf - 1;
    }
    const seconds = [];
    let output;
    for (let iteration = 0; iteration < (measureTimes ? 4 : 1); iteration++) {
      output = join(temporary, `measured-${iteration}.mkv`);
      const started = performance.now();
      encode(best.crf, output);
      if (measureTimes && iteration > 0) seconds.push((performance.now() - started) / 1000);
    }
    const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=pix_fmt', '-of', 'json', output], {encoding:'utf8',maxBuffer:1024*1024});
    if (probe.error) throw probe.error;
    assert.equal(probe.status, 0, probe.stderr);
    const storedPixelFormat = JSON.parse(probe.stdout).streams[0]?.pix_fmt;
    assert.ok(storedPixelFormat, 'Comparison output lacks a declared pixel format.');
    let ssim;
    if (measureSsim) {
      const referencePath = join(temporary, 'reference.rgb');
      const decodedPath = join(temporary, 'decoded.rgb');
      writeFileSync(referencePath, reference);
      const decoded = run(['-i', output, '-map', '0:v:0', '-an', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], true);
      assert.equal(decoded.length, reference.length);
      writeFileSync(decodedPath, decoded);
      const rawInput = path => ['-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${quality.width}x${quality.height}`,
        '-r', `${quality.fpsNumerator}/${quality.fpsDenominator}`, '-i', path];
      const comparison = spawnSync('ffmpeg', ['-nostdin', '-v', 'info', '-filter_threads', '1', '-threads', '2',
        ...rawInput(referencePath), ...rawInput(decodedPath), '-lavfi', '[0:v][1:v]ssim',
        '-frames:v', String(quality.frames), '-f', 'null', '-'], {encoding:'utf8',maxBuffer:1024*1024});
      if (comparison.error) throw comparison.error;
      assert.equal(comparison.status, 0, comparison.stderr);
      const match = comparison.stderr.match(/SSIM.*All:(-?[\d.]+)/);
      assert.ok(match, comparison.stderr);
      ssim = Number(match[1]);
      assert.ok(Number.isFinite(ssim) && ssim >= -1 && ssim <= 1);
    }
    const qualityDifferenceDb = 10 * Math.log10(targetMse / best.mse);
    return {
      codec,
      encoder,
      ...(measureSsim ? {ssim,ssimReference:'Exact source and decoded RGB24 with matching raw-frame timestamps'} : {}),
      referenceInput:'Exact scaled RGB24 reference frames',
      referenceSha256:createHash('sha256').update(reference).digest('hex'),
      audio:quality.audio ? 'Opus 96 kbit/s' : null,
      container:'Matroska',
      pixelFormat,
      storedPixelFormat,
      preset:codec === 'AV1' ? 'libaom cpu-used=6, row-mt=1' : 'medium',
      threads:2,
      ...best,
      psnr:10 * Math.log10(255 ** 2 / best.mse),
      qualityDifferenceDb,
      qualityMatched:Math.abs(qualityDifferenceDb) <= 0.5,
      maximumQualityDifferenceDb:0.5,
      bytes:statSync(output).size,
      timingMeasured:measureTimes,
      seconds,
      medianSeconds:seconds.toSorted((a, b) => a - b)[1],
    };
  } finally {
    rmSync(temporary,{recursive:true,force:true});
  }
}
