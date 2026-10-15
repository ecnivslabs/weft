import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, constants, existsSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync, writeSync } from 'node:fs';
import { arch, cpus, platform, tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { parseHeader, parseIndex, asciiPackets, codecFormat, crc32 } from '../web/sci.js';
import { Decoder } from '../web/wasm.js';
import { fileHash, rawInput, rgbMetrics, run, ssim } from './vvc-metrics.mjs';

const [sourceText, archiveText, heightText = '1080', destination] = process.argv.slice(2);
const height = Number(heightText);
assert.ok(sourceText && archiveText && [360, 480, 720, 1080].includes(height),
  'Usage: node player/tests/vvc-benchmark.mjs SOURCE ARCHIVE.sci [HEIGHT] [NEW_OUTPUT.mp4]');
const source = resolve(sourceText);
const archive = resolve(archiveText);
const encoderName = process.env.VVC_FFMPEG ?? (process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const encoder = [resolve(encoderName), ...(process.env.PATH ?? '').split(delimiter).map(path => join(path, encoderName))].find(existsSync);
assert.ok(encoder, 'VVenC-enabled FFmpeg missing. Set VVC_FFMPEG to its path.');
assert.ok(run(encoder, ['-hide_banner', '-encoders']).stdout.includes('libvvenc'), 'Comparison needs FFmpeg built with libvvenc.');
const preset = process.env.VVENC_PRESET ?? 'medium';
const threads = Number(process.env.VVENC_THREADS ?? 8);
assert.ok(['faster', 'fast', 'medium', 'slow', 'slower'].includes(preset));
assert.ok(Number.isInteger(threads) && threads >= 1 && threads <= 64);
assert.ok(!destination || !existsSync(resolve(destination)), 'Comparison output must be a new file.');
const temporary = mkdtempSync(join(tmpdir(), 'weft-vvc-comparison-'));
let archiveFile;
const hash = data => createHash('sha256').update(data).digest('hex');
function range(offset, length) {
  assert.ok(Number.isSafeInteger(length) && length > 0 && length <= 16 * 1024 * 1024);
  const bytes = Buffer.alloc(length);
  assert.equal(readSync(archiveFile, bytes, 0, length, offset), length);
  return bytes;
}
const ffmpeg = arguments_ => run('ffmpeg', ['-nostdin', '-v', 'error', '-filter_threads', '1', '-threads', '2', ...arguments_]);
try {
  archiveFile = openSync(archive, 'r');
  const header = parseHeader(range(0, 32));
  assert.equal(header.size, statSync(archive).size);
  const metadata = JSON.parse(range(32, header.metadataLength));
  const records = parseIndex(range(header.indexOffset, header.count * 48), header, metadata);
  const rendition = metadata.qualities.find(quality => quality.height === height);
  assert.ok(rendition, 'Requested SCI rendition missing.');
  const quality = { width: rendition.columns, height: rendition.rows, frames: metadata.frames,
    duration: metadata.duration, fpsNumerator: metadata.fpsNumerator, fpsDenominator: metadata.fpsDenominator };
  assert.ok(Number.isFinite(metadata.source?.firstPts) && Math.abs(metadata.source.firstPts) <= 0.0000005,
    'This comparison requires a source whose video starts at PTS zero.');
  assert.ok(quality.duration <= 10 && quality.frames <= 600, 'Use unique excerpts of at most ten seconds.');
  assert.equal(quality.width % 2, 0, 'VVenC 4:2:0 comparison requires an even width.');
  const frameBytes = quality.width * quality.height * 3;
  const reference = join(temporary, 'reference.rgb');
  const reconstructed = join(temporary, 'weft.rgb');
  const filter = `fps=${quality.fpsNumerator}/${quality.fpsDenominator}:start_time=0,scale=${quality.width}:${quality.height}:flags=lanczos`;
  ffmpeg(['-i', source, '-map', '0:v:0', '-an', '-vf', filter, '-t', String(quality.duration),
    '-pix_fmt', 'rgb24', '-f', 'rawvideo', reference]);
  assert.equal(statSync(reference).size, frameBytes * quality.frames);
  const wasm = readFileSync(new URL('../web/decoder.wasm', import.meta.url));
  const decoder = await Decoder.open(wasm);
  const output = openSync(reconstructed, 'wx');
  const timeline = createHash('sha256');
  const audio = createHash('sha256');
  const rgb = Buffer.alloc(frameBytes);
  let frames = 0;
  try {
    for (let chunk = 0; chunk < metadata.chunks; chunk++) {
      const record = records.get(`${height}:${chunk}`);
      const payload = range(record.offset, record.length);
      assert.equal(crc32(payload), record.checksum);
      for (const [index, packet] of asciiPackets(payload, record, 28, codecFormat(metadata.video)).entries()) {
        const start = Math.round(packet.time * 1000000);
        const end = Math.round(packet.end * 1000000);
        const nominal = frame => Math.round(frame * quality.fpsDenominator * 1000000 / quality.fpsNumerator);
        assert.ok(Math.abs(start - nominal(frames)) <= 1 && Math.abs(end - nominal(frames + 1)) <= 1,
          'This comparison requires CFR source timing, including the final frame.');
        timeline.update(`${frames}:${start}:${end}:`);
        const pixels = decoder.decode(packet, quality.width, quality.height, 28, index === 0, metadata.video.font);
        for (let pixel = 0; pixel < quality.width * quality.height; pixel++) {
          rgb[pixel * 3] = pixels[pixel * 4];
          rgb[pixel * 3 + 1] = pixels[pixel * 4 + 1];
          rgb[pixel * 3 + 2] = pixels[pixel * 4 + 2];
        }
        assert.equal(writeSync(output, rgb), rgb.length);
        frames++;
      }
      if (metadata.audio) {
        const record = records.get(`0:${chunk}`);
        const payload = range(record.offset, record.length);
        assert.equal(crc32(payload), record.checksum);
        audio.update(payload);
      }
    }
  } finally { closeSync(output); }
  assert.equal(frames, quality.frames);
  const weftMetrics = rgbMetrics(reference, reconstructed, frameBytes, frames);
  assert.ok(weftMetrics.mse > 0, 'Lossless SCI requires a separate lossless comparison.');
  weftMetrics.ssim = ssim(reference, reconstructed, quality);
  const input = join(temporary, 'input.yuv');
  ffmpeg([...rawInput(reference, quality), '-an', '-vf',
    'scale=out_color_matrix=bt709:out_range=tv:in_range=pc', '-pix_fmt', 'yuv420p10le', '-f', 'rawvideo', input]);
  const rate = `${quality.fpsNumerator}/${quality.fpsDenominator}`;
  const intraPeriod = Math.max(16, Math.round(metadata.fps / 16) * 16);
  const encodedAudio = join(temporary, 'audio.ogg');
  if (metadata.audio) ffmpeg(['-copyts', '-i', source, '-map', '0:a:0', '-vn', '-af',
    `asetpts=PTS,aresample=async=1:first_pts=0,apad,aformat=sample_fmts=s16:sample_rates=48000:channel_layouts=stereo,atrim=end_sample=${Math.floor(Math.round(quality.duration * 1000000) * 48000 / 1000000)}`,
    '-c:a', 'libopus', '-b:a', '96k', '-vbr', 'on', '-compression_level', '10', '-ar', '48000', '-ac', '2', encodedAudio]);
  const trials = [];
  function candidate(qp) {
    const videoFile = join(temporary, `qp-${qp}-video.mp4`);
    const mp4 = join(temporary, `qp-${qp}.mp4`);
    const decoded = join(temporary, `qp-${qp}.rgb`);
    const arguments_ = ['-nostdin', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'yuv420p10le',
      '-s', `${quality.width}x${quality.height}`, '-r', rate, '-i', input, '-frames:v', String(frames),
      '-c:v', 'libvvenc', '-preset', preset, '-qp', String(qp), '-threads', String(threads), '-qpa', '1',
      '-vvenc-params', `GOPSize=16:IntraPeriod=${intraPeriod}:DecodingRefreshType=idr_no_radl:POC0IDR=1:ColourDescriptionPresent=1:ColourPrimaries=bt709:TransferCharacteristics=bt709:MatrixCoefficients=bt709`,
      '-tag:v', 'vvc1', '-video_track_timescale', String(quality.fpsNumerator), '-movflags', '+faststart', videoFile];
    const started = performance.now();
    run(encoder, arguments_);
    const diagnosticEncodeSeconds = (performance.now() - started) / 1000;
    ffmpeg(['-i', videoFile, ...(metadata.audio ? ['-i', encodedAudio] : []), '-map', '0:v:0',
      ...(metadata.audio ? ['-map', '1:a:0'] : []), '-c', 'copy', '-tag:v', 'vvc1',
      '-video_track_timescale', String(quality.fpsNumerator), '-movflags', '+faststart', mp4]);
    const probe = JSON.parse(run('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', mp4]).stdout);
    const video = probe.streams.find(stream => stream.codec_type === 'video');
    assert.equal(video?.codec_name, 'vvc');
    assert.equal(video.codec_tag_string, 'vvc1');
    assert.equal(video.width, quality.width); assert.equal(video.height, quality.height);
    assert.equal(Number(video.nb_read_frames), frames);
    const [numerator, denominator] = video.avg_frame_rate.split('/').map(Number);
    assert.equal(numerator * quality.fpsDenominator, quality.fpsNumerator * denominator);
    assert.ok(Math.abs(Number(video.duration) - quality.duration) <= 0.000002);
    assert.ok(probe.format.format_name.split(',').includes('mp4'));
    assert.equal(video.pix_fmt, 'yuv420p10le');
    assert.equal(video.color_space, 'bt709');
    assert.equal(video.color_range, 'tv');
    const presentation = JSON.parse(run('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-show_frames', '-show_entries', 'frame=pts_time,duration_time,key_frame', '-of', 'json', mp4]).stdout).frames;
    assert.equal(presentation.length, frames);
    for (const [index, frame] of presentation.entries()) {
      assert.ok(Math.abs(Number(frame.pts_time) - index * quality.fpsDenominator / quality.fpsNumerator) <= 0.000002,
        'MP4 presentation timestamps differ from source cadence.');
      assert.ok(Math.abs(Number(frame.duration_time) - quality.fpsDenominator / quality.fpsNumerator) <= 0.000002,
        'MP4 frame durations differ from source cadence.');
    }
    const sound = probe.streams.find(stream => stream.codec_type === 'audio');
    assert.equal(Boolean(sound), Boolean(metadata.audio));
    if (sound) {
      assert.equal(sound.codec_name, 'opus');
      assert.equal(Number(sound.sample_rate), 48000); assert.equal(sound.channels, 2);
      assert.ok(Math.abs(Number(sound.duration) - quality.duration) <= 0.001);
    }
    ffmpeg(['-i', mp4, '-map', '0:v:0', '-an', '-fps_mode', 'passthrough', '-pix_fmt', 'rgb24', '-f', 'rawvideo', decoded]);
    const metrics = rgbMetrics(reference, decoded, frameBytes, frames);
    const qualityDifferenceDb = 10 * Math.log10(weftMetrics.mse / metrics.mse);
    const result = { qp, bytes: statSync(mp4).size, ...metrics, qualityDifferenceDb,
      qualityMatched: Math.abs(qualityDifferenceDb) <= 0.5, diagnosticEncodeSeconds,
      mp4, decoded, arguments: arguments_, video, audio: sound,
      keyframeTimes: presentation.filter(frame => frame.key_frame).map(frame => Number(frame.pts_time)) };
    trials.push(result);
    return result;
  }
  let lower = 0; let upper = 63; let best;
  while (lower <= upper) {
    const trial = candidate(Math.floor((lower + upper) / 2));
    if (!best || Math.abs(trial.qualityDifferenceDb) < Math.abs(best.qualityDifferenceDb)) best = trial;
    if (trial.mse < weftMetrics.mse) lower = trial.qp + 1; else upper = trial.qp - 1;
    // Only the best decoded raster is needed for SSIM; compressed candidates remain for selection.
    for (const result of trials) if (result !== best) rmSync(result.decoded, { force: true });
    if (trial.qualityMatched) break;
  }
  const selected = { ...best, ssim: ssim(reference, best.decoded, quality), mp4Sha256: fileHash(best.mp4) };
  if (destination) copyFileSync(best.mp4, resolve(destination), constants.COPYFILE_EXCL);
  const payloads = [...records.values()].filter(record => record.quality === 0 || record.quality === height);
  const payloadBytes = payloads.reduce((sum, record) => sum + record.length, 0);
  const audioBytes = payloads.filter(record => record.quality === 0).reduce((sum, record) => sum + record.length, 0);
  const mediaBodyBytes = 32 + header.metadataLength + header.count * 48 + payloadBytes;
  function compact(result) {
    const { mp4, decoded, arguments: arguments_, ...rest } = result;
    return { ...rest, encoderArguments: arguments_.map(value => value === input ? 'INPUT.yuv' : value.endsWith('-video.mp4') ? 'VIDEO.mp4' : value) };
  }
  console.log(JSON.stringify({ source, archive, sourceSha256: fileHash(source), archiveSha256: fileHash(archive), quality, host: { platform: platform(), arch: arch(),
    cpu: cpus()[0]?.model, logicalCpus: cpus().length, node: process.version },
    tools: { encoder: run(encoder, ['-version']).stdout.split('\n')[0], encoderExecutableSha256: fileHash(encoder),
      ffmpeg: run('ffmpeg', ['-version']).stdout.split('\n')[0], decoderWasmSha256: hash(wasm) },
    method: { comparison: 'H.266/VVC in MP4, encoded from original source RGB, not SCI output',
      preset, threads, qpa: true, pixelFormat: 'yuv420p10le', colorMatrix: 'BT.709 limited range',
      intraPeriod, maximumQualityDifferenceDb: 0.5, qualityProxy: 'RGB MSE, with YUV444 SSIM reported separately',
      audio: metadata.audio ? 'Opus 96 kbit/s, stereo 48 kHz, same source interval; SCI uses independent Ogg chunks' : null,
      size: 'Complete archive and MP4 file bytes, including audio and container overhead; SCI selected media bodies also reported',
      timing: 'Single search encodes are diagnostic only. No comparative speed, browser playback, energy or sustained streaming claim.' },
    weft: { version: header.version, archiveBytes: header.size, mediaBodyBytes, audioBytes, ...weftMetrics,
      timelineSha256: timeline.digest('hex'), encodedAudioSha256: audio.digest('hex') },
    vvc: compact(selected), trials: trials.map(compact),
    archiveSizeRatio: header.size / selected.bytes, mediaBodySizeRatio: mediaBodyBytes / selected.bytes,
    mp4SavedPercent: 100 * (1 - selected.bytes / mediaBodyBytes),
    output: destination ? resolve(destination) : null }, null, 2));
} finally {
  if (archiveFile !== undefined) closeSync(archiveFile);
  rmSync(temporary, { recursive: true, force: true });
}
