import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const recipe = JSON.parse(await readFile(join(root, 'shared/media/sample.json'), 'utf8'));
if (recipe.width !== 1920 || recipe.height !== 1080 || recipe.fpsNumerator !== 24 || recipe.fpsDenominator !== 1 || recipe.frames !== 96 || recipe.duration !== 4 || !Number.isFinite(recipe.startSeconds) || recipe.startSeconds < 0 || new URL(recipe.sourceUrl).protocol !== 'https:') throw new Error('Invalid comparison source recipe.');
const work = join(root, 'videos/fossils-sample');
const originalPath = join(work, 'original.webm');
const sourcePath = join(work, 'source.nut');
const archivePath = join(work, 'maximum.sci');
const cli = process.env.WEFT_CLI ?? join(root, 'target/release', process.platform === 'win32' ? 'weft.exe' : 'weft');
const { width, height, fps, duration } = recipe;
const { frames, fpsNumerator, fpsDenominator } = recipe;
const previewFrames = Math.round(duration * 24);
const previewWidth = 400, previewHeight = 225, previewFps = 24;
const assets = join(root, 'docs/assets');
const web = join(root, 'player/web');

async function command(executable, args) {
  const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const output = [], errors = [];
  child.stdout.on('data', data => output.push(data));
  child.stderr.on('data', data => errors.push(data));
  const [code] = await once(child, 'close');
  if (code !== 0) throw new Error(`${executable} exited ${code}: ${Buffer.concat(errors).toString().trim()}`);
  return Buffer.concat(output);
}

async function ffmpeg(args) {
  return command('ffmpeg', ['-nostdin', '-v', 'error', '-y', ...args]);
}

async function digest(path) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const block of createReadStream(path)) {
    bytes += block.length;
    hash.update(block);
  }
  return { bytes, sha256: hash.digest('hex') };
}

function webpDuration(bytes) {
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP') throw new Error('Invalid WebP output.');
  let durationMs = 0, count = 0;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const length = bytes.readUInt32LE(offset + 4);
    if (offset + 8 + length > bytes.length) throw new Error('Truncated WebP chunk.');
    if (bytes.toString('ascii', offset, offset + 4) === 'ANMF') {
      if (length < 16) throw new Error('Invalid WebP animation frame.');
      durationMs += bytes.readUIntLE(offset + 20, 3);
      count++;
    }
    offset += 8 + length + (length % 2);
  }
  if (count !== previewFrames) throw new Error(`Unexpected WebP frame count: ${count}.`);
  return durationMs;
}

await mkdir(work, { recursive: true });
const stage = await mkdtemp(join(work, '.prepare-'));
const source = join(stage, 'source.nut');
const archive = join(stage, 'maximum.sci');
try {
  if (existsSync(sourcePath)) {
    await cp(sourcePath, source);
  } else {
    const retained = existsSync(originalPath);
    if (retained && (await digest(originalPath)).sha256 !== recipe.upstreamSha256) throw new Error('Retained film does not match the source recipe.');
    const network = retained ? [] : ['-tls_verify', '1', '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_on_http_error', '5xx', '-reconnect_delay_max', '2', '-reconnect_max_retries', '3', '-rw_timeout', '30000000'];
    await ffmpeg([...network, '-ss', String(recipe.startSeconds), '-i', retained ? originalPath : recipe.sourceUrl, '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', String(duration), '-frames:v', String(frames), '-map', '0:v:0', '-map', '1:a:0', '-vf', recipe.sourceFilter, '-c:v', 'ffv1', '-level', '3', '-c:a', 'pcm_s16le', source]);
  }
  const sourceFrames = (await ffmpeg(['-i', source, '-map', '0:v:0', '-an', '-c:v', 'rawvideo', '-pix_fmt', 'rgb24', '-f', 'hash', '-hash', 'sha256', '-'])).toString().trim().replace(/^SHA256=/, '');
  if (!/^[a-f0-9]{64}$/.test(sourceFrames) || (recipe.frameSha256 && recipe.frameSha256 !== sourceFrames)) throw new Error('Source frames do not match the recorded excerpt.');
  await command(cli, ['encode', source, archive, '--heights', '1080', '--fps', 'source', '--quality', '100', '--layers', '4', '--color-bits', '8', '--byte-penalty', '0']);
  const metadata = JSON.parse((await command(cli, ['inspect', archive])).toString());
  if (metadata.frames !== frames || Math.abs(metadata.fps - fps) > 0.000001 || metadata.qualities[0].columns !== width || metadata.qualities[0].height !== height) throw new Error('SCI roundtrip dimensions or timing changed.');
  if (metadata.video.colorBits !== 8 || (!metadata.encoderProfile.startsWith('adaptive-layered-v2:1080:4:') || metadata.encoderProfile.split(':')[4] !== '0')) throw new Error('SCI roundtrip did not use maximum-quality ASCII fitting.');
  if (metadata.audio?.codec !== 'opus' || metadata.audio.channels !== 2 || metadata.audio.sampleRate !== 48000) throw new Error('SCI roundtrip lost synchronized stereo Opus audio.');
  const rgb = join(stage, 'decoded.rgb');
  const ppm = join(stage, 'decoded.ppm');
  const { open } = await import('node:fs/promises');
  const output = await open(rgb, 'w');
  try {
    for (let frame = 0; frame < frames; frame++) {
      await command(cli, ['decode', archive, String(frame), ppm, '--height', String(height)]);
      const bytes = await readFile(ppm), header = Buffer.from(`P6\n${width} ${height}\n255\n`);
      if (!bytes.subarray(0, header.length).equals(header) || bytes.length !== header.length + width * height * 3) throw new Error(`Invalid decoded frame: ${frame}.`);
      await output.writeFile(bytes.subarray(header.length));
    }
  } finally { await output.close(); }

  const raw = ['-f', 'rawvideo', '-pixel_format', 'rgb24', '-video_size', `${width}x${height}`, '-framerate', String(fps), '-i', rgb];
  const sourceInput = ['-i', source];
  const preview = ['-vf', `format=rgb24,scale=${previewWidth}:${previewHeight}:flags=lanczos,fps=${previewFps}`, '-frames:v', String(previewFrames), '-an', '-c:v', 'libwebp_anim', '-lossless', '1', '-compression_level', '6', '-loop', '0'];
  const stillFrame = Math.round(fps);
  for (const [name, input] of [['source', sourceInput], ['weft', raw]]) {
    await ffmpeg([...input, ...preview, join(stage, `${name}-preview.webp`)]);
    await ffmpeg([...input, '-vf', `format=rgb24,select=eq(n\\,${stillFrame})`, '-frames:v', '1', join(stage, `${name}-1080.png`)]);
    await ffmpeg([...input, '-vf', `format=rgb24,scale=${previewWidth}:${previewHeight}:flags=lanczos`, '-frames:v', '1', join(stage, `${name}-poster.png`)]);
  }
  const previewDurationMs = webpDuration(await readFile(join(stage, 'source-preview.webp')));
  if (previewDurationMs !== webpDuration(await readFile(join(stage, 'weft-preview.webp')))) throw new Error('Comparison preview timing differs.');
  const names = ['source-preview.webp', 'weft-preview.webp', 'source-1080.png', 'weft-1080.png', 'source-poster.png', 'weft-poster.png'];
  const prepared = Object.fromEntries(await Promise.all(names.map(async name => [name, await digest(join(stage, name))])));
  if (['source', 'weft'].some(name => prepared[`${name}-preview.webp`].bytes > 5 * 1024 * 1024)) throw new Error('Preview exceeds the website image budget.');
  await command(cli, ['encode', source, join(stage, 'sample.sci'), '--heights', '360', '--fps', 'source']);
  const sample = await digest(join(stage, 'sample.sci'));
  const sampleMetadata = JSON.parse((await command(cli, ['inspect', join(stage, 'sample.sci')])).toString());
  if (sampleMetadata.frames !== frames || Math.abs(sampleMetadata.fps - fps) > 0.000001 || sampleMetadata.qualities.length !== 1 || sampleMetadata.qualities[0].height !== 360) throw new Error('SCI sample dimensions or timing changed.');
  if (sampleMetadata.audio?.codec !== 'opus' || sampleMetadata.audio.channels !== 2 || sampleMetadata.audio.sampleRate !== 48000) throw new Error('SCI sample lost synchronized stereo Opus audio.');
  const encoded = await digest(archive);
  const report = {
    recipe: 'shared/media/sample.json', title: recipe.title, creator: recipe.creator, sourceUrl: recipe.canonicalSourceUrl, licenseEvidence: recipe.licenseEvidence, sourceStartSeconds: recipe.startSeconds, sourceFrameSha256: sourceFrames, sourcePath: 'videos/fossils-sample/source.nut', archivePath: 'videos/fossils-sample/maximum.sci',
    mediaLicense: 'CC0-1.0', frames, duration, width, height, fps, fpsNumerator, fpsDenominator, layers: 4, colorBits: 8, bytePenalty: 0, audio: metadata.audio,
    stillFrame, stillTimeSeconds: stillFrame / fps, previewWidth, previewHeight, previewFps,
    previewFormat: 'lossless animated WebP', previewDurationMs,
    archiveBytes: encoded.bytes, archiveSha256: encoded.sha256,
    sourceSha256: (await digest(source)).sha256, assets: prepared,
  };
  for (const name of names) await cp(join(stage, name), join(assets, name));
  await cp(join(stage, 'sample.sci'), join(web, 'sample.sci'));
  await cp(source, sourcePath);
  await cp(archive, archivePath);
  await writeFile(join(web, 'sample.json'), JSON.stringify({ title: recipe.title, description: `360p, native ${fps.toFixed(3)} FPS. Four-second .sci sample, ${(sample.bytes / 1024 / 1024).toFixed(1)} MiB.`, media: '/sample.sci', ...sample }, null, 2) + '\n');
  await writeFile(join(assets, 'fidelity.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await rm(stage, { recursive: true, force: true });
}
