import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { openSync, readSync, closeSync, readFileSync } from 'node:fs';
import { cpus, platform, arch } from 'node:os';
import { performance } from 'node:perf_hooks';
import { parseHeader, parseIndex, asciiPackets, codecFormat, crc32 } from '../web/sci.js';
import { Decoder } from '../web/wasm.js';

const [before, after, heightText, beforeModule, afterModule, mode = 'cells'] = process.argv.slice(2);
const height = Number(heightText);
assert.ok(before && after && [360, 480, 720, 1080].includes(height) && ['cells', 'pixels'].includes(mode),
  'Usage: node player/tests/packing-benchmark.mjs BEFORE.sci AFTER.sci HEIGHT [BEFORE.wasm AFTER.wasm [cells|pixels]]');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const median = values => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
const percentile = (values, fraction) => values.toSorted((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
function open(path, module) {
  const file = openSync(path, 'r');
  const range = (offset, length) => {
    assert.ok(length > 0 && length <= 16 * 1024 * 1024);
    const bytes = Buffer.alloc(length);
    assert.equal(readSync(file, bytes, 0, length, offset), length);
    return bytes;
  };
  try {
    const header = parseHeader(range(0, 32));
    const metadata = JSON.parse(range(32, header.metadataLength));
    const records = parseIndex(range(header.indexOffset, header.count * 48), header, metadata);
    const quality = metadata.qualities.find(quality => quality.height === height);
    assert.ok(quality, 'Requested rendition missing.');
    const wasm = readFileSync(module ?? new URL('../web/decoder.wasm', import.meta.url));
    const payloadBytes = [...records.values()].filter(record => record.quality === 0 || record.quality === height).reduce((sum, record) => sum + record.length, 0);
    return { file, path, range, header, metadata, records, quality, wasm, moduleSha256: digest(wasm),
      transferredMediaBytes: 32 + header.metadataLength + header.count * 48 + payloadBytes, milliseconds: [], p95Milliseconds: [], firstFrameMilliseconds: [] };
  } catch (error) { closeSync(file); throw error; }
}
const samples = [];
try {
  samples.push(open(before, beforeModule));
  samples.push(open(after, afterModule));
  let expected;
  let expectedAudio;
  let expectedTimeline;
  for (let iteration = 0; iteration < 6; iteration++) {
    for (const sample of iteration % 2 ? samples.toReversed() : samples) {
      const { quality, metadata, records } = sample;
      const timeline = [quality.columns, quality.rows, metadata.frames, metadata.duration, metadata.fpsNumerator, metadata.fpsDenominator];
      if (expectedTimeline) assert.deepEqual(timeline, expectedTimeline);
      expectedTimeline = timeline;
      const decoder = await Decoder.open(sample.wasm);
      const hash = createHash('sha256');
      const audio = createHash('sha256');
      const milliseconds = [];
      const tags = {};
      for (let chunk = 0; chunk < metadata.chunks; chunk++) {
        const record = records.get(`${height}:${chunk}`);
        const payload = sample.range(record.offset, record.length);
        assert.equal(crc32(payload), record.checksum);
        const packets = asciiPackets(payload, record, 28, codecFormat(metadata.video));
        for (const [index, packet] of packets.entries()) {
          const begin = performance.now();
          const output = decoder[mode === 'cells' ? 'decodeCells' : 'decode'](packet, quality.columns, quality.rows, 28, index === 0, metadata.video.font);
          milliseconds.push(performance.now() - begin);
          hash.update(`${packet.sourceFrame}:${Math.round(packet.time * 1000000)}:${Math.round(packet.duration * 1000000)}:`);
          hash.update(output);
          tags[packet.tag] = (tags[packet.tag] ?? 0) + 1;
        }
        if (metadata.audio) {
          const record = records.get(`0:${chunk}`);
          const payload = sample.range(record.offset, record.length);
          assert.equal(crc32(payload), record.checksum);
          audio.update(`${record.startUs}:${record.endUs}:${record.decoded}:`).update(payload);
        }
      }
      assert.equal(milliseconds.length, metadata.frames);
      const fingerprint = hash.digest('hex');
      const audioFingerprint = audio.digest('hex');
      if (expected) assert.equal(fingerprint, expected, 'ASCII output and presentation timing must match exactly.');
      if (expectedAudio) assert.equal(audioFingerprint, expectedAudio, 'Audio and synchronized chunk boundaries must match exactly.');
      expected = fingerprint; expectedAudio = audioFingerprint;
      sample.tags = tags;
      if (iteration) {
        sample.milliseconds.push(milliseconds.reduce((a, b) => a + b, 0));
        sample.p95Milliseconds.push(percentile(milliseconds, .95));
        sample.firstFrameMilliseconds.push(milliseconds[0]);
      }
    }
  }
  const results = samples.map(sample => ({ path: sample.path, version: sample.header.version, moduleSha256: sample.moduleSha256,
    archiveBytes: sample.header.size, transferredMediaBytes: sample.transferredMediaBytes, tags: sample.tags,
    milliseconds: sample.milliseconds, p95Milliseconds: sample.p95Milliseconds,
    medianMillisecondsPerFrame: median(sample.milliseconds) / sample.metadata.frames,
    medianP95Milliseconds: median(sample.p95Milliseconds), medianFirstFrameMilliseconds: median(sample.firstFrameMilliseconds) }));
  console.log(JSON.stringify({ host: { platform: platform(), arch: arch(), cpu: cpus()[0]?.model, node: process.version }, height, mode,
    warmups: 1, measuredIterations: 5, frames: samples[0].metadata.frames, timeline: expectedTimeline,
    outputAndTimingSha256: expected, audioAndTimingSha256: expectedAudio, results,
    transferredBytesSavedPercent: 100 * (1 - results[1].transferredMediaBytes / results[0].transferredMediaBytes),
    medianDecodeChangePercent: 100 * (results[1].medianMillisecondsPerFrame / results[0].medianMillisecondsPerFrame - 1),
    p95DecodeChangePercent: 100 * (results[1].medianP95Milliseconds / results[0].medianP95Milliseconds - 1) }, null, 2));
} finally { for (const sample of samples) closeSync(sample.file); }
