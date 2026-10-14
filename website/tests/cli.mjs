import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Decoder } from '../web/wasm.js';
import { asciiPackets } from '../web/sci.js';

export async function verifyRustDecoder(root, temporary, first, archivePath, sourceBytes, metadata, records) {
  const cli = resolve(root, 'target/release', process.platform === 'win32' ? 'weft.exe' : 'weft');
  const inspected = spawnSync(cli, ['inspect', archivePath], { encoding: 'utf8' });
  assert.equal(inspected.status, 0, inspected.stderr);
  assert.deepEqual(JSON.parse(inspected.stdout), metadata);
  const decodedPath = join(temporary, 'decoded.ppm');
  const decoded = spawnSync(cli, ['decode', archivePath, '61', decodedPath], { encoding: 'utf8' });
  assert.equal(decoded.status, 0, decoded.stderr);
  const seekRecord = [...records.values()].find(record => record.quality === 360 && record.first <= 61 && record.first + record.frames > 61);
  const seekPackets = asciiPackets(sourceBytes.subarray(seekRecord.offset, seekRecord.offset + seekRecord.length), seekRecord, metadata.video.cellBytes);
  const decoder = await Decoder.open(readFileSync(join(root, 'website/web/decoder.wasm')));
  let rgba;
  for (const [index, packet] of seekPackets.slice(0, 62 - seekRecord.first).entries()) rgba = decoder.decode(packet, seekRecord.columns, seekRecord.rows, metadata.video.cellBytes, index === 0, metadata.video.font);
  const ppmHeader = Buffer.from(`P6\n${seekRecord.columns} ${seekRecord.rows}\n255\n`);
  const ppm = readFileSync(decodedPath);
  assert.deepEqual(ppm.subarray(0, ppmHeader.length), ppmHeader);
  assert.deepEqual(ppm.subarray(ppmHeader.length), Buffer.from(rgba.filter((_, index) => index % 4 !== 3)), 'Rust seek decoder and browser renderer must agree pixel for pixel.');
  const overwritten = spawnSync(cli, ['encode', first, archivePath], { encoding: 'utf8' });
  assert.notEqual(overwritten.status, 0);
  assert.deepEqual(readFileSync(archivePath), Buffer.from(sourceBytes), 'Encoding must preserve existing archives.');
}
