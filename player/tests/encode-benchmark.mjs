import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { parseHeader, parseIndex, asciiPackets, crc32 } from '../web/sci.js';
import { Decoder } from '../web/wasm.js';
import { validateOpus } from '../web/opus.js';

const [source, height, ...binaries] = process.argv.slice(2);
if (!source || ![360,480,720,1080].includes(Number(height)) || binaries.length !== 2) {
  throw new Error('Usage: node player/tests/encode-benchmark.mjs SHORT_SOURCE HEIGHT BEFORE_BINARY AFTER_BINARY');
}
const temporary = mkdtempSync(join(tmpdir(), 'weft-encode-speed-'));
const samples = binaries.map(binary => ({binary:resolve(binary), seconds:[]}));
let expected;
let expectedTimeline;
try {
  for (let iteration = 0; iteration < 4; iteration++) {
    for (const [index, sample] of (iteration % 2 ? [...samples.entries()].reverse() : [...samples.entries()])) {
      const output = join(temporary, `${iteration}-${index}.sci`);
      const begin = performance.now();
      const result = spawnSync(sample.binary, ['encode',resolve(source),output,'--heights',height], {encoding:'utf8', maxBuffer:1024*1024});
      const seconds = (performance.now() - begin) / 1000;
      if (result.error) throw result.error;
      assert.equal(result.status,0,result.stderr);
      assert.ok(statSync(output).size <= 64*1024*1024, 'Use a short source producing at most 64 MiB.');
      const bytes = readFileSync(output);
      const header = parseHeader(bytes.subarray(0,32));
      const metadata = JSON.parse(bytes.subarray(32,32+header.metadataLength));
      const records = parseIndex(bytes.subarray(header.indexOffset,header.indexOffset+header.count*header.recordBytes),header,metadata);
      const quality = metadata.qualities[0];
      const timeline = [quality.columns,quality.rows,metadata.frames,metadata.fpsNumerator,metadata.fpsDenominator,metadata.duration];
      if (expectedTimeline) assert.deepEqual(timeline,expectedTimeline);
      expectedTimeline = timeline;
      const decoder = await Decoder.open(readFileSync(new URL('../web/decoder.wasm',import.meta.url)));
      const pixels = createHash('sha256');
      for (let chunk=0;chunk<metadata.chunks;chunk++) {
        const record = records.get(`${height}:${chunk}`);
        const payload = bytes.subarray(record.offset,record.offset+record.length);
        assert.equal(crc32(payload),record.checksum);
        for (const [index,packet] of asciiPackets(payload,record,metadata.video.cellBytes).entries()) {
          pixels.update(String(packet.time)); pixels.update(String(packet.duration));
          pixels.update(decoder.decode(packet,quality.columns,quality.rows,metadata.video.cellBytes,index===0,metadata.video.font));
        }
        if (metadata.audio) {
          const audio = records.get(`0:${chunk}`);
          validateOpus(bytes.subarray(audio.offset,audio.offset+audio.length),audio.decoded);
        }
      }
      const hash = pixels.digest('hex');
      if (expected) assert.equal(hash,expected,'Lossless optimizations must preserve decoded pixels and presentation times.');
      expected = hash;
      sample.bytes = bytes.length;
      if (iteration) sample.seconds.push(seconds);
    }
  }
  console.log(JSON.stringify({height:Number(height),warmups:1,measuredIterations:3,presentationSha256:expected,timeline:expectedTimeline,
    results:samples.map(sample=>({...sample,medianSeconds:sample.seconds.toSorted((a,b)=>a-b)[1]}))},null,2));
} finally {rmSync(temporary,{recursive:true,force:true});}
