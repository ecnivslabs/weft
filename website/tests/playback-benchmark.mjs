import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { openSync, readSync, closeSync, readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { parseHeader, parseIndex, asciiPackets, codecFormat, crc32 } from '../web/sci.js';
import { Decoder } from '../web/wasm.js';

const [archive, heightText, ...modules] = process.argv.slice(2);
if (!archive || ![360, 480, 720, 1080].includes(Number(heightText)) || !modules.length) {
  throw new Error('Usage: node website/tests/playback-benchmark.mjs ARCHIVE HEIGHT WASM[#cells][#native] [WASM[#cells][#native]...]');
}
const file = openSync(archive, 'r');
function range(offset, length) {
  assert.ok(length > 0 && length <= 16 * 1024 * 1024);
  const bytes = Buffer.alloc(length);
  assert.equal(readSync(file, bytes, 0, length, offset), length);
  return bytes;
}
try {
  const header = parseHeader(range(0, 32));
  const metadata = JSON.parse(range(32, header.metadataLength));
  const records = parseIndex(range(header.indexOffset, header.count * header.recordBytes), header, metadata);
  const height = Number(heightText);
  const quality = metadata.qualities.find(item => item.height === height);
  assert.ok(quality);
  const chunks = [];
  let frames = 0;
  for (let index = 0; index < metadata.chunks && frames < 60; index++) {
    const record = records.get(`${height}:${index}`);
    const bytes = range(record.offset, record.length);
    assert.equal(crc32(bytes), record.checksum);
    const packets = asciiPackets(bytes, record, metadata.video.cellBytes, codecFormat(metadata.video));
    chunks.push(packets);
    frames += packets.length;
  }
  const samples = modules.map(argument => {
    const nativeInflation = argument.endsWith('#native');
    const selected = nativeInflation ? argument.slice(0, -7) : argument;
    const cellsOnly = selected.endsWith('#cells');
    const module = cellsOnly ? selected.slice(0, -6) : selected;
    return { module, nativeInflation, cellsOnly, bytes: readFileSync(module), milliseconds: [] };
  });
  const expected = new Map();
  for (let iteration = 0; iteration < 6; iteration++) {
    for (const sample of iteration % 2 ? samples.toReversed() : samples) {
      const decoder = await Decoder.open(sample.bytes);
      const hash = createHash('sha256');
      let elapsed = 0;
      for (const packets of chunks) {
        for (const [index, packet] of packets.entries()) {
          const begin = performance.now();
          const pixels = await decoder[sample.cellsOnly ? (sample.nativeInflation ? 'decodeCellsNative' : 'decodeCells') : (sample.nativeInflation ? 'decodeNative' : 'decode')](packet, quality.columns, quality.rows, codecFormat(metadata.video), index === 0, metadata.video.font);
          elapsed += performance.now() - begin;
          hash.update(pixels);
        }
      }
      const checksum = hash.digest('hex');
      if (expected.has(sample.cellsOnly)) assert.equal(checksum, expected.get(sample.cellsOnly), 'Every decoder must reconstruct identical output in its selected mode.');
      expected.set(sample.cellsOnly, checksum);
      if (iteration) sample.milliseconds.push(elapsed);
    }
  }
  console.log(JSON.stringify({ height, width: quality.columns, frames, warmups: 1, measuredIterations: 5, pixelSha256: expected.get(false), cellSha256: expected.get(true),
    results: samples.map(({module, nativeInflation, cellsOnly, milliseconds}) => ({module, nativeInflation, cellsOnly, milliseconds, medianMillisecondsPerFrame: milliseconds.toSorted((a,b)=>a-b)[2] / frames})) }, null, 2));
} finally { closeSync(file); }
