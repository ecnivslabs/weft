import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, linkSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const recipe = JSON.parse(readFileSync(new URL('./reel.json', import.meta.url)));
const destination = resolve(process.argv[2] ?? join(root, 'videos/mixed-detail-1080p60.mkv'));
const inputs = process.argv[3] && resolve(process.argv[3]);
assert.ok(!existsSync(destination), 'Destination already exists.');
mkdirSync(join(root, 'videos/.staging'), {recursive:true});
const temporary = mkdtempSync(join(root, 'videos/.staging/reel-'));
function run(program, arguments_) {
  const result = spawnSync(program, arguments_, {encoding:'utf8', maxBuffer: 4 * 1024 * 1024});
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
async function digest(path) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}
try {
  const parts = [];
  for (const [index, source] of recipe.sources.entries()) {
    const path = inputs ? join(inputs, source.file) : join(temporary, source.file);
    if (!inputs) {
      const response = await fetch(source.url, {signal:AbortSignal.timeout(600000)});
      assert.ok(response.ok && response.body, `Download failed: ${response.status}`);
      let received = 0;
      const bound = new Transform({transform(bytes, _, callback) {
        received += bytes.length;
        callback(received > source.bytes ? new Error('Download exceeds pinned size.') : null, bytes);
      }});
      await pipeline(response.body, bound, createWriteStream(path, {flags:'wx'}));
    }
    assert.equal(statSync(path).size, source.bytes, `Source size changed: ${source.file}`);
    assert.equal(await digest(path), source.sha256, `Source checksum changed: ${source.file}`);
    const probe = JSON.parse(run('ffprobe', ['-v','error','-select_streams','v:0','-show_entries','stream=avg_frame_rate','-of','json',path]));
    const [numerator,denominator] = probe.streams[0].avg_frame_rate.split('/').map(Number);
    assert.equal(numerator / denominator, 60, 'Reel inputs must contain native 60 FPS motion.');
    const part = join(temporary, `${index}.mkv`);
    run('ffmpeg', ['-nostdin','-v','error','-filter_threads','1','-threads','2', ...(source.loop ? ['-stream_loop','-1'] : []), '-ss', String(source.start), '-i', path,
      ...(!source.audio ? ['-f','lavfi','-i','anullsrc=r=48000:cl=stereo'] : []), '-t','20','-map','0:v:0','-map',source.audio ? '0:a:0' : '1:a:0',
      '-vf','scale=1920:1080:flags=lanczos,setpts=N/(60*TB)','-fps_mode','passthrough','-pix_fmt','bgr0','-c:v','ffv1','-level','3','-threads','2',
      '-af','asetpts=PTS-STARTPTS,aresample=48000,apad','-c:a','pcm_s16le','-ar','48000','-ac','2',part]);
    parts.push(part);
  }
  const screen = join(temporary,'5.mkv');
  const font = process.env.WEFT_REEL_FONT;
  const fontOption = font ? `fontfile='${font.replaceAll('\\','/').replaceAll(':','\\:').replaceAll("'","\\'")}'` : 'font=monospace';
  const lines = join(temporary,'text.txt');
  writeFileSync(lines, 'Detail and timing study\n\nABCDEFGHIJKLMNOPQRSTUVWXYZ\nabcdefghijklmnopqrstuvwxyz\n0123456789  ! @ # $ % & * ( )\n\nSphinx of black quartz, judge my vow.\n\nNative 60 FPS animation, no interpolation.');
  const textPath = lines.replaceAll('\\','/').replaceAll(':','\\:').replaceAll("'","\\'");
  run('ffmpeg', ['-nostdin','-v','error','-filter_threads','1','-f','lavfi','-i','color=c=0x101a28:size=1920x1080:rate=60','-f','lavfi','-i','sine=frequency=220:sample_rate=48000','-t','20',
    '-vf',`drawtext=${fontOption}:textfile='${textPath}':expansion=none:fontcolor=white:fontsize=38:x=80:y=80,drawbox=x=80:y=650:w=1600:h=2:color=0x3fbca4:t=fill,drawtext=${fontOption}:text='60 FPS moving text':fontcolor=0x3fbca4:fontsize=24:x='80+mod(t*70,1200)':y=720,drawtext=${fontOption}:text='%{n}':fontcolor=white:fontsize=18:x=80:y=830`,
    '-fps_mode','passthrough','-pix_fmt','bgr0','-c:v','ffv1','-level','3','-threads','2','-af','volume=0.15','-c:a','pcm_s16le','-ar','48000','-ac','2',screen]);
  parts.push(screen);
  const list = join(temporary,'concat.txt');
  writeFileSync(list, parts.map(path => `file '${path.replaceAll("'","'\\''")}'`).join('\n'));
  const result = join(temporary,'reel.mkv');
  run('ffmpeg',['-nostdin','-v','error','-f','concat','-safe','0','-i',list,'-map','0','-c','copy',result]);
  const probe = JSON.parse(run('ffprobe',['-v','error','-count_frames','-show_entries','stream=codec_type,width,height,avg_frame_rate,nb_read_frames:format=duration','-of','json',result]));
  const video = probe.streams.find(stream => stream.codec_type === 'video');
  assert.equal(video.width,1920); assert.equal(video.height,1080); assert.equal(Number(video.nb_read_frames),7200);
  assert.equal(Number(probe.format.duration),120);
  linkSync(result,destination);
  console.log(JSON.stringify({path:destination,sha256:await digest(destination),bytes:statSync(destination).size,...probe},null,2));
} finally { rmSync(temporary,{recursive:true,force:true}); }
