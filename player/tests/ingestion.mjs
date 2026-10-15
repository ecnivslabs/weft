import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { validateOpus } from '../web/opus.js';
import { Decoder } from '../web/wasm.js';
import { parseHeader, parseIndex, asciiPackets, codecFormat } from '../web/sci.js';

const root = resolve(import.meta.dirname, '../..');
const temporary = mkdtempSync(join(tmpdir(), 'weft-ingestion-'));
const cli = join(root, 'target/release', process.platform === 'win32' ? 'weft.exe' : 'weft');
function run(program, arguments_) {
  const result = spawnSync(program, arguments_, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
function archive(path) {
  const bytes = new Uint8Array(readFileSync(path));
  const header = parseHeader(bytes.subarray(0,32));
  const metadata = JSON.parse(new TextDecoder().decode(bytes.subarray(32,32+header.metadataLength)));
  const records = parseIndex(bytes.subarray(header.indexOffset,header.indexOffset+header.count*header.recordBytes),header,metadata);
  return { bytes, metadata, records };
}
try {
  for (const [name, rate, size, duration, extra] of [
    ['native', '60', '1920x1080', '1.1', []],
    ['nut', '60', '320x180', '0.25', []],
    ['fractional', '60000/1001', '320x180', '1.1', []],
    ['capped', '120', '320x180', '1', []],
    ['sparse', '1/2', '320x180', '4', []],
    ['variable', '30', '320x180', '1.5', ['-vf', 'select=not(mod(n\\,3))+not(mod(n\\,7))', '-fps_mode', 'vfr']],
  ]) {
    const source = join(temporary,`${name}.${name==='nut' ? 'nut' : 'mp4'}`);
    run('ffmpeg',['-nostdin','-v','error','-y','-f','lavfi','-i',`color=c=0x238d61:size=${size}:rate=${rate}`,'-f','lavfi','-i','sine=frequency=550:sample_rate=48000','-t',duration,...extra,...(name==='nut' ? ['-c:v','ffv1','-c:a','pcm_s16le'] : ['-c:v','libx264','-preset','ultrafast','-c:a','aac']),source]);
    const destination = join(temporary,`${name}.sci`);
    const options = [];
    const metadata = JSON.parse(run(cli,['encode',source,destination,...options]));
    const opened = archive(destination);
    assert.deepEqual(metadata,opened.metadata);
    const decoder = await Decoder.open(readFileSync(join(root,'player/web/decoder.wasm')));
    for (const quality of metadata.qualities) {
      const reference = spawnSync('ffmpeg',['-nostdin','-v','error','-filter_threads','1','-threads','2','-i',source,'-frames:v','1','-vf',`scale=${quality.columns}:${quality.rows}:flags=lanczos`,'-pix_fmt','rgb24','-f','rawvideo','pipe:1'],{maxBuffer:8*1024*1024});
      assert.equal(reference.status,0,reference.stderr.toString());
      const expectedColor=[...reference.stdout.subarray(0,3)];
      let frames = 0;
      let lastEnd = 0;
      for (let chunk = 0; chunk < metadata.chunks; chunk++) {
        const record = opened.records.get(`${quality.height}:${chunk}`);
        const packets = asciiPackets(opened.bytes.subarray(record.offset,record.offset+record.length),record,metadata.video.cellBytes,codecFormat(metadata.video));
        for (const [index,packet] of packets.entries()) {
          assert.ok(Math.abs(packet.time-lastEnd)<0.000001);
          const pixels = decoder.decode(packet,quality.columns,quality.rows,codecFormat(metadata.video),index===0);
          assert.equal(pixels.length,quality.columns*quality.rows*4);
          assert.deepEqual([...pixels.subarray(0,3)],expectedColor);
          lastEnd=packet.time+packet.duration; frames++;
        }
        const audio=opened.records.get(`0:${chunk}`);
        assert.equal(audio.decoded,Math.floor(record.endUs*48000/1000000)-Math.floor(record.startUs*48000/1000000));
        validateOpus(opened.bytes.subarray(audio.offset,audio.offset+audio.length),audio.decoded);
      }
      assert.equal(frames,metadata.frames);
      assert.ok(Math.abs(lastEnd-metadata.duration)<0.000001);
      const ppm=join(temporary,`${name}-${quality.height}.ppm`);
      run(cli,['decode',destination,String(metadata.frames-1),ppm,'--height',String(quality.height)]);
      const prefix=Buffer.from(`P6\n${quality.columns} ${quality.rows}\n255\n`);
      assert.deepEqual(readFileSync(ppm).subarray(prefix.length,prefix.length+3),Buffer.from(expectedColor));
    }
    if (name==='native') { assert.equal(metadata.frames,66); assert.equal(metadata.fps,60); assert.deepEqual(metadata.qualities.map(q=>q.height),[360,480,720,1080]); }
    if (name==='nut') { assert.equal(metadata.frames,15); assert.equal(metadata.fps,60); assert.equal(metadata.duration,0.25); }
    if (name==='fractional') { assert.equal(metadata.fpsNumerator,60000); assert.equal(metadata.fpsDenominator,1001); }
    if (name==='capped') assert.equal(metadata.frames,60);
    if (name==='sparse') { assert.equal(metadata.sourceFrames,2); assert.equal(metadata.frames,4); assert.equal(metadata.chunks,4); }
    if (name==='variable') {
      const probed=JSON.parse(run('ffprobe',['-v','error','-select_streams','v:0','-show_frames','-show_entries','frame=best_effort_timestamp_time','-of','json',source]));
      assert.equal(metadata.frames,probed.frames.length);
      const packets=[...opened.records.values()].filter(r=>r.quality===180).flatMap(r=>asciiPackets(opened.bytes.subarray(r.offset,r.offset+r.length),r,28));
      assert.deepEqual(packets.map(p=>Math.round(p.time*1000000)),probed.frames.map(f=>Math.round((Number(f.best_effort_timestamp_time)-Number(probed.frames[0].best_effort_timestamp_time))*1000000)));
      assert.ok(new Set(packets.map(p=>Math.round(p.duration*1000000))).size>1);
    }
    console.log(`Passed ${name}: ${metadata.frames} presentation frames, ${metadata.chunks} seek chunks.`);
  }
  for (const arguments_ of [['--heights','999'],['--fps','30/0'],['--quality','101'],['--layers','5'],['--target-bitrate','0'],['--prediction','v2'],['--prediction','v3'],['--temporal-fit','on'],['--baseline'],['--legacy-v3']]) {
    const result=spawnSync(cli,['encode',join(temporary,'native.mp4'),join(temporary,'invalid.sci'),...arguments_],{encoding:'utf8'});
    assert.notEqual(result.status,0);
  }
} finally { rmSync(temporary,{recursive:true,force:true}); }
