import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { validateOpus } from '../web/opus.js';
import { Decoder } from '../web/wasm.js';
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const encoded = spawnSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '0.25', '-ac', '2', '-c:a', 'libopus', '-f', 'ogg', 'pipe:1']);
if (encoded.error) throw encoded.error;
assert.equal(encoded.status, 0, encoded.stderr.toString());
const bytes = new Uint8Array(encoded.stdout);

test('Opus preflight accepts real bounded audio and rejects corrupt or excessive duration', () => {
  validateOpus(bytes, 12000);
  for (const malformed of [bytes.subarray(0, bytes.length - 1), new Uint8Array([...bytes, ...bytes]), bytes.with(30, bytes[30] ^ 1)]) {
    assert.throws(() => validateOpus(malformed, 12000), /Invalid or oversized/);
  }
  for (const samples of [0, 1, 11999, 12001, 144001, NaN]) assert.throws(() => validateOpus(bytes, samples));
});

test('WASM accepts the fixed font and rejects removed fonts and formats',async()=>{
 const decoder=await Decoder.open(readFileSync(new URL('../web/decoder.wasm',import.meta.url)));
 const data=new Uint8Array(28);data[3]=32;const packet={tag:6,decoded:28,bytes:deflateSync(data)};
 assert.equal(decoder.decode(packet,3,4,28,true,'ascii-3x4-v2').length,48);
 for(const font of ['ascii-3x4-v1','unknown'])assert.throws(()=>decoder.decode(packet,3,4,28,true,font),/Unsupported/);
 for(const format of [7,8,29,30])assert.throws(()=>decoder.decode(packet,3,4,format,true),/Unsupported/);
});
