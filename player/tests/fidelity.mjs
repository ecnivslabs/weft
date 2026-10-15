import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, statSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseHeader, parseIndex, asciiPackets, codecFormat, crc32 } from '../web/sci.js';
import { Decoder } from '../web/wasm.js';

const [source, ...archives] = process.argv.slice(2);
if (!source || archives.length !== 2) throw new Error('Usage: node player/tests/fidelity.mjs SOURCE BASELINE_SCI CURRENT_SCI');
let expected;
const results = [];
for (const path of archives) {
  assert.ok(statSync(path).size <= 64 * 1024 * 1024, 'Use a short comparison archive, at most 64 MiB.');
  const archive = new Uint8Array(readFileSync(path));
  const header = parseHeader(archive.subarray(0, 32));
  const metadata = JSON.parse(new TextDecoder().decode(archive.subarray(32, 32 + header.metadataLength)));
  const records = parseIndex(archive.subarray(header.indexOffset, header.indexOffset + header.count * header.recordBytes), header, metadata);
  assert.equal(metadata.qualities.length, 1, 'Compare archives with one rendition.');
  const quality = metadata.qualities[0];
  const frameSize = quality.columns * quality.rows * 3;
  assert.ok(frameSize * metadata.frames <= 128 * 1024 * 1024, 'Use shorter comparison clips, at most 128 MiB decoded RGB.');
  const timeline = [quality.columns, quality.rows, metadata.frames, metadata.fpsNumerator, metadata.fpsDenominator];
  if (expected) assert.deepEqual(timeline, expected, 'Comparisons must have identical dimensions and timelines.');
  expected = timeline;
  const reference = spawnSync('ffmpeg', ['-nostdin', '-v', 'error', '-filter_threads', '1', '-threads', '2', '-i', source, '-map', '0:v:0', '-an', '-vf', `fps=${metadata.fpsNumerator}/${metadata.fpsDenominator}:start_time=0,scale=${quality.columns}:${quality.rows}:flags=lanczos`, '-t', String(metadata.duration), '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { maxBuffer: 128 * 1024 * 1024 });
  if (reference.error) throw reference.error;
  assert.equal(reference.status, 0, reference.stderr.toString());
  assert.equal(reference.stdout.length, frameSize * metadata.frames);
  const reconstructed = Buffer.alloc(reference.stdout.length);
  let pixels;
  const wasm = readFileSync(new URL('../web/decoder.wasm', import.meta.url));
  let squared = 0;
  let index = 0;
  const decodeTimes = [];
  const firstFrameTimes = [];
  for (let iteration = 0; iteration < 4; iteration++) {
  index = 0;
  const decoder = await Decoder.open(wasm);
  let decodeTime = 0;
  const started = performance.now();
  for (let chunk = 0; chunk < metadata.chunks; chunk++) {
    const record = records.get(`${quality.height}:${chunk}`);
    const payload = archive.subarray(record.offset, record.offset + record.length);
    assert.equal(crc32(payload), record.checksum);
    for (const [packetIndex, packet] of asciiPackets(payload, record, metadata.video.cellBytes, codecFormat(metadata.video)).entries()) {
      const decodeStarted = performance.now();
      pixels = decoder.decode(packet, quality.columns, quality.rows, codecFormat(metadata.video), packetIndex === 0, metadata.video.font);
      decodeTime += performance.now() - decodeStarted;
      if (index === 0 && iteration > 0) firstFrameTimes.push(performance.now() - started);
      if (iteration === 0) for (let pixel = 0; pixel < quality.columns * quality.rows; pixel++) {
        for (let channel = 0; channel < 3; channel++) {
          const difference = pixels[pixel * 4 + channel] - reference.stdout[index * frameSize + pixel * 3 + channel];
          squared += difference * difference;
          reconstructed[index * frameSize + pixel * 3 + channel] = pixels[pixel * 4 + channel];
        }
      }
      index++;
    }
  }
  assert.equal(index, metadata.frames);
  if (iteration > 0) decodeTimes.push(decodeTime);
  }
  const mse = squared / reference.stdout.length;
  const temporary = mkdtempSync(join(tmpdir(),'weft-metrics-'));
  let perceptual;
  try {
    writeFileSync(join(temporary,'reconstruction.rgb'), reconstructed);
    writeFileSync(join(temporary,'reference.rgb'), reference.stdout);
    function compare(filter) {
      const arguments_ = ['-nostdin','-v','info','-filter_complex_threads','2'];
      for (const file of ['reconstruction.rgb','reference.rgb']) arguments_.push('-f','rawvideo','-pix_fmt','rgb24','-s',`${quality.columns}x${quality.rows}`,'-r',`${metadata.fpsNumerator}/${metadata.fpsDenominator}`,'-i',file);
      arguments_.push('-lavfi',`[0:v]format=yuv444p[d];[1:v]format=yuv444p[r];[d][r]${filter}`,'-an','-f','null','-');
      return spawnSync('ffmpeg', arguments_, {cwd:temporary,encoding:'utf8',maxBuffer:1024*1024});
    }
    const ssim = compare('ssim');
    if (ssim.error) throw ssim.error;
    assert.equal(ssim.status,0,ssim.stderr);
    const vmaf = compare('libvmaf=log_fmt=json:log_path=vmaf.json:n_threads=2');
    if (vmaf.error) throw vmaf.error;
    if (vmaf.status !== 0 && !vmaf.stderr.includes('No such filter')) assert.equal(vmaf.status,0,vmaf.stderr);
    perceptual = {ssim:Number(ssim.stderr.match(/All:([0-9.]+)/)?.[1]), vmaf:vmaf.status===0 ? JSON.parse(readFileSync(join(temporary,'vmaf.json'))).pooled_metrics.vmaf.mean : null,
      vmafUnavailable:vmaf.status===0 ? undefined : 'FFmpeg libvmaf filter unavailable.'};
  } finally {rmSync(temporary,{recursive:true,force:true});}
  results.push({ reconstructionSha256:createHash('sha256').update(reconstructed).digest('hex'), path, width: quality.columns, height: quality.rows, frames: index, fpsNumerator:metadata.fpsNumerator, fpsDenominator:metadata.fpsDenominator, duration:metadata.duration, audio:Boolean(metadata.audio), independentVideoBytes:quality.independentVideoBytes ?? null, videoBytes:quality.videoBytes ?? null, font: metadata.video.font, mapper: metadata.video.mapper, bytes: archive.length, totalBitrate:archive.length*8/metadata.duration, audioBytes: [...records.values()].filter(record => record.quality === 0).reduce((sum, record) => sum + record.length, 0), decodeMilliseconds: decodeTimes, medianDecodeMillisecondsPerFrame: decodeTimes.toSorted((a,b)=>a-b)[1] / metadata.frames, medianFirstFrameMilliseconds: firstFrameTimes.toSorted((a,b)=>a-b)[1], mse, psnr: mse === 0 ? 'Infinity' : 10 * Math.log10(255 ** 2 / mse), ...perceptual });
}
console.log(JSON.stringify({ results, rgbErrorReductionPercent: results[0].mse === 0 ? null : 100 * (1 - results[1].mse / results[0].mse) }, null, 2));
