import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, mkdirSync, writeFileSync, existsSync, statSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, delimiter, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createConnection } from 'node:net';
import { once } from 'node:events';
import { parseHeader, parseIndex, asciiPackets, crc32 } from '../web/sci.js';
import { Decoder } from '../web/wasm.js';
import { verifyRustDecoder } from './cli.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const root = resolve(import.meta.dirname, '../..');
const webDirectory = resolve(process.env.TEST_WEB_DIR ?? join(root, 'player/web'));
const temporary = mkdtempSync(join(tmpdir(), 'weft-tests-'));
const binary = resolve(root, 'target/release', process.platform === 'win32' ? 'weft-player.exe' : 'weft-player');
const port = Number(process.env.TEST_PORT ?? 18010);
const base = `http://127.0.0.1:${port}`;
const data = join(temporary, 'data');
const bin = join(temporary, 'bin');
const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
const downloadLog = join(temporary, 'downloads.jsonl');
const downloadCount = () => existsSync(downloadLog) ? readFileSync(downloadLog, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(arguments_ => arguments_.includes('--no-playlist')).length : 0;
let server;
let browser;
let page;
let log = '';

async function launch(seed = false, library = data) {
  server = spawn(binary, [...(seed ? [first] : []), '--port', String(port), '--data-dir', library, '--heights', '360'], {
    cwd: temporary, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, [pathKey]: `${bin}${delimiter}${process.env[pathKey] ?? ''}`, WEFT_TEST_DOWNLOAD_SOURCE: first, WEFT_TEST_DOWNLOAD_LOG: downloadLog },
  });
  server.stdout.on('data', chunk => { log += chunk; });
  server.stderr.on('data', chunk => { log += chunk; });
  for (let attempt = 0; attempt < 600; attempt++) {
    if (server.exitCode !== null) throw new Error(`Server exited: ${log}`);
    try { if ((await fetch(`${base}/health`)).ok) return; } catch {}
    await delay(100);
  }
  throw new Error(`Server startup timed out: ${log}`);
}

async function stop() {
  if (server && server.exitCode === null) {
    const exited = once(server, 'exit');
    server.kill();
    await exited;
  }
}

async function post(path, payload) {
  return fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
}

async function rawRequest(request) {
  const socket = createConnection(port, '127.0.0.1');
  let response = '';
  socket.on('data', data => { response += data.toString(); });
  await once(socket, 'connect');
  socket.write(request);
  await once(socket, 'close');
  return response;
}

const first = join(temporary, 'Color study.mp4');
const second = join(temporary, 'Night "scene" café.webm');
try {
  cpSync(webDirectory, join(temporary, 'player/web'), { recursive: true });
  mkdirSync(bin);
  if (process.platform === 'win32') {
    writeFileSync(join(bin, 'yt-dlp.cmd'), `@"${process.execPath}" "${join(root, 'player/tests/download_fixture.mjs')}" %*\r\n`);
  } else {
    writeFileSync(join(bin, 'yt-dlp'), `#!/usr/bin/env node\nimport ${JSON.stringify(pathToFileURL(join(root, 'player/tests/download_fixture.mjs')).href)};\n`, { mode: 0o755 });
  }
  for (const [filename, color, codec] of [[first, 'testsrc2=size=1280x720:rate=30', 'libx264'], [second, 'testsrc2=size=240x360:rate=24', 'libvpx-vp9']]) {
    const result = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', color, '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '10', '-c:a', codec === 'libx264' ? 'aac' : 'libopus', '-c:v', codec, '-pix_fmt', 'yuv420p', filename], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  await launch(true);
  let result = await (await fetch(`${base}/api/queue`)).json();
  assert.equal(result.queue.length, 1);
  assert.equal(result.queue[0].duration, 10);
  assert.equal(result.queue[0].status, 'ready', 'Startup must convert discovered sources before serving.');
  assert.equal('source' in result.queue[0], false);
  const id = result.queue[0].id;
  if (process.platform !== 'win32') assert.equal(id, createHash('sha256').update(realpathSync(first) + statSync(first).size + Math.floor(statSync(first).mtimeMs / 1000)).digest('hex').slice(0, 20), 'Rust migration must preserve existing local video IDs.');
  const preparations = await Promise.all([post(`/api/videos/${id}/prepare`, {}), post(`/api/videos/${id}/prepare`, {})]);
  assert.ok(preparations.every(response => [200, 409].includes(response.status)));
  assert.ok(preparations.some(response => response.status === 200));
  assert.equal((await post('/api/videos/missing/prepare', {})).status, 404);
  assert.equal((await post('/api/queue/add', { video: second })).status, 201);
  assert.equal((await post('/api/queue/add', { video: second })).status, 201);
  result = await (await fetch(`${base}/api/queue`)).json();
  assert.equal(result.queue.length, 2);
  const secondId = result.queue[1].id;
  const prepared = await post(`/api/videos/${secondId}/prepare`, {});
  assert.equal(prepared.status, 200, await prepared.text());
  result = await (await fetch(`${base}/api/queue`)).json();
  assert.deepEqual(result.queue.map(video => video.status), ['ready', 'ready']);
  const stored = JSON.parse(readFileSync(join(data, 'catalog.json'), 'utf8'));
  for (const video of stored) {
    assert.equal(video.format, 'sci-v6');
    assert.ok(video.path.endsWith('.sci'));
    const archive = readFileSync(video.path);
    assert.equal(archive.subarray(0, 4).toString(), 'SCIV');
    assert.equal(archive.readUInt16LE(4), 6);
  }
  assert.ok(stored.every(video => video.path.startsWith(join(temporary, 'videos', 'sci'))));
  const mediaDirectory = dirname(stored[0].path);
  assert.ok(readdirSync(mediaDirectory).every(name => !name.endsWith('.mp4')));
  await stop();
  await launch();
  result = await (await fetch(`${base}/api/queue`)).json();
  assert.equal(result.queue.length, 2, 'All ready entries must survive restart.');
  assert.deepEqual(result.queue.map(video => video.status), ['ready', 'ready']);
  assert.deepEqual(JSON.parse(readFileSync(join(data, 'catalog.json'), 'utf8')).map(video => video.path), stored.map(video => video.path));
  assert.equal((await post('/api/queue/add', { video: '/missing.mp4' })).status, 400);
  assert.equal((await post('/api/queue/add', { video: 123 })).status, 400);
  assert.equal((await post('/api/queue/add', { video: 'https://example.org/video' })).status, 400);
  const malformed = await fetch(`${base}/api/queue/add`, { method: 'POST', body: '{' });
  assert.equal(malformed.status, 400);
  const crossOrigin = await fetch(`${base}/api/queue/add`, { method: 'POST', headers: { Origin: 'https://example.org' }, body: '{}' });
  assert.equal(crossOrigin.status, 403);
  assert.match(await rawRequest('GET /health HTTP/1.1\r\nHost: evil.test\r\n\r\n'), /^HTTP\/1.1 403/);
  assert.match(await rawRequest('POST /api/queue/add HTTP/1.1\r\nHost: localhost\r\nContent-Length: 1\r\nContent-Length: 2\r\n\r\n{}'), /^HTTP\/1.1 400/);
  assert.match(await rawRequest('POST /api/queue/add HTTP/1.1\r\nHost: localhost\r\nContent-Length: 99999\r\n\r\n'), /^HTTP\/1.1 413/);
  const entry = result.queue[0];
  assert.deepEqual(entry.qualities, [360]);
  const response = await fetch(`${base}${entry.media}`);
  assert.equal(response.headers.get('content-type'), 'application/vnd.weft.sci');
  assert.match(response.headers.get('cache-control'), /immutable/);
  const sourceBytes = new Uint8Array(await response.arrayBuffer());
  const header = parseHeader(sourceBytes.subarray(0, 32));
  const metadata = JSON.parse(new TextDecoder().decode(sourceBytes.subarray(32, 32 + header.metadataLength)));
  const records = parseIndex(sourceBytes.subarray(header.indexOffset, header.indexOffset + header.count * header.recordBytes), header, metadata);
  assert.equal(metadata.frames, 300);
  assert.equal(metadata.audio.codec, 'opus');
  const variants = {};
  for (const height of [360]) {
    let bytes = 32 + header.metadataLength + header.count * header.recordBytes;
    for (let chunk = 0; chunk < metadata.chunks; chunk++) {
      const record = records.get(`${height}:${chunk}`);
      const payload = sourceBytes.subarray(record.offset, record.offset + record.length);
      assert.equal(crc32(payload), record.checksum);
      const frames = asciiPackets(payload, record, metadata.video.cellBytes);
      assert.equal(frames.length, 30);
      assert.equal(record.rows, height);
      const audio = records.get(`0:${chunk}`);
      assert.equal(audio.decoded, 48000);
      bytes += record.length + audio.length;
    }
    variants[height] = bytes;
  }
  assert.equal(metadata.version, 6);
  assert.equal(metadata.video.codec, 'sci-ascii-scene-v1');
  await verifyRustDecoder(root, temporary, first, stored[0].path, sourceBytes, metadata, records);
  const decoder = await Decoder.open(readFileSync(join(webDirectory, 'decoder.wasm')));
  const firstRecord = records.get('360:0');
  for (const [index, packet] of asciiPackets(sourceBytes.subarray(firstRecord.offset, firstRecord.offset + firstRecord.length), firstRecord, metadata.video.cellBytes).entries()) {
    const pixels = decoder.decode(packet, firstRecord.columns, firstRecord.rows, metadata.video.cellBytes, index === 0);
    assert.equal(pixels.length, firstRecord.columns * firstRecord.rows * 4);
  }
  assert.ok(variants[360] > 0);
  console.log(`10-second motion fixture with audio: SCI 360p ${variants[360]} bytes, original MP4 ${readFileSync(first).length} bytes.`);
  const segmentUrl = `${base}${entry.media}`;
  const range = await fetch(segmentUrl, { headers: { Range: 'bytes=10-109' } });
  assert.equal(range.status, 206);
  assert.match(range.headers.get('content-range'), /^bytes 10-109\//);
  assert.equal((await range.arrayBuffer()).byteLength, 100);
  assert.equal((await fetch(segmentUrl, { headers: { Range: 'bytes=999999999-' } })).status, 416);
  const rangeBytes = new Uint8Array(await (await fetch(segmentUrl, { headers: { Range: 'bytes=0-255' } })).arrayBuffer());
  assert.deepEqual(rangeBytes, sourceBytes.subarray(0, 256));
  const head = await fetch(segmentUrl, { method: 'HEAD' });
  assert.equal(Number(head.headers.get('content-length')), sourceBytes.length);
  assert.equal((await head.text()).length, 0);
  const mediaBase = entry.media.replace('video.sci', '');
  for (const path of ['../catalog.json', '%2e%2e%2fcatalog.json', 'master.m3u8', 'video.mp4']) {
    assert.equal((await fetch(`${base}${mediaBase}${path}`)).status, 404);
  }
  const etag = head.headers.get('etag');
  assert.ok(etag);
  const unchanged = await fetch(segmentUrl, { headers: { 'If-None-Match': etag } });
  assert.equal(unchanged.status, 304);
  assert.equal((await unchanged.text()).length, 0);
  assert.equal((await fetch(segmentUrl, { headers: { Range: 'bytes=0-31', 'If-Range': etag } })).status, 206);
  assert.equal((await fetch(segmentUrl, { headers: { Range: 'bytes=0-31', 'If-Range': 'stale' } })).status, 200);
  const concurrent = await Promise.all(Array.from({ length: 16 }, () => fetch(`${base}/api/queue`).then(r => r.json())));
  assert.ok(concurrent.every(r => r.queue.length === 2));
  browser = await chromium.launch({ headless: true });
  let sample = { ...result.queue[0], description: "Integration fixture" };
  const context = await browser.newContext();
  await context.route("**/sample.json", route => route.fulfill({ json: sample }));
  await context.addInitScript(() => { globalThis.VideoDecoder = undefined; globalThis.EncodedVideoChunk = undefined; });
  page = await context.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  const requests = [];
  page.on('request', request => { requests.push({ url: request.url(), range: request.headers().range }); });
  const startupStarted = performance.now();
  await page.goto(base);
  await page.evaluate(async () => { window.testPlayer = (await import('/app.js')).player; });
  await page.waitForFunction(() => window.testPlayer.stream.metadata && window.testPlayer.loaded && !document.querySelector('#big-play').hidden);
  await page.waitForFunction(() => document.querySelector('canvas').height === window.testPlayer.stream.renderer.canvas.height && document.querySelector('canvas').height > 0);
  console.log(`Loopback navigation to first rendered ASCII frame: ${(performance.now() - startupStarted).toFixed(1)} ms.`);
  assert.equal(await page.locator('#video-title').textContent(), 'Color study');
  assert.equal(await page.locator('#queue, #search, #open-add, #add-dialog').count(), 0);
  assert.equal(await page.evaluate(() => window.testPlayer.stream.reader.get(0, 0).length), 48000);
  const analyser = await page.evaluateHandle(() => {
    const analyser = window.testPlayer.stream.clock.context.createAnalyser();
    window.testPlayer.stream.clock.gain.connect(analyser);
    return analyser;
  });
  await page.locator('#big-play').click();
  await page.waitForFunction(() => window.testPlayer.stream.currentTime > 0.3);
  await page.waitForFunction(analyser => {
    const samples = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(samples);
    return samples.some(value => Math.abs(value) > 0.01);
  }, analyser);
  await page.locator('#play').click();
  const before = await page.evaluate(() => ({ time: window.testPlayer.stream.currentTime, source: window.testPlayer.stream.reader?.url, pixels: document.querySelector('canvas').toDataURL() }));
  await page.locator('#settings-toggle').click();
  assert.equal(await page.locator('#palette, #contrast, #brightness, #saturation, #loop, #autoplay').count(), 0);
  assert.deepEqual((await page.locator('#resolution option').allTextContents()).slice(1), ['360p']);
  await page.locator('#resolution').selectOption('360');
  await page.waitForFunction(() => document.querySelector('canvas').height === 360);
  assert.equal(await page.evaluate(() => window.testPlayer.stream.reader.url), before.source);
  assert.equal(await page.evaluate(() => window.testPlayer.stream.paused), true);
  assert.ok(Math.abs(await page.evaluate(() => window.testPlayer.stream.currentTime) - before.time) < 0.1);
  assert.equal(await page.locator('video, audio').count(), 0);
  assert.equal(await page.evaluate(() => {
    const stream = window.testPlayer.stream;
    const canvas = stream.renderer.canvas;
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    const colors = new Set();
    let black = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] || pixels[i + 1] || pixels[i + 2]) colors.add(`${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`);
      else black++;
    }
    return colors.size > 1000 && black < canvas.width * canvas.height / 2;
  }), true);
  await page.locator('#close-settings').click();
  await page.locator('#seek').fill('500');
  await page.waitForFunction(() => Math.abs(window.testPlayer.stream.currentTime - 5) < 0.1);
  await page.locator('#player').focus();
  await page.keyboard.press('m');
  assert.equal(await page.evaluate(() => window.testPlayer.stream.muted), true);
  await page.locator('#settings-toggle').click();
  await page.locator('#speed').selectOption('1.5');
  assert.equal(await page.evaluate(() => window.testPlayer.stream.playbackRate), 1.5);
  await page.locator('#close-settings').click();
  await page.locator('#theater').click();
  assert.equal(await page.locator('body').evaluate(body => body.classList.contains('theater-mode')), true);
  await page.locator('#theater').click();
  await page.locator('#fullscreen').click();
  await page.waitForFunction(() => document.fullscreenElement?.id === 'player');
  await page.locator('#fullscreen').click();
  await page.waitForFunction(() => !document.fullscreenElement);
  const secondEntry = result.queue.find(video => video.id === secondId);
  await page.evaluate(entry => window.testPlayer.load(entry), secondEntry);
  await page.waitForFunction(() => window.testPlayer.loaded && window.testPlayer.stream.renderer.canvas.width === 240);
  assert.equal(await page.evaluate(() => window.testPlayer.stream.playbackRate), 1.5);
  await page.evaluate(entry => window.testPlayer.load(entry), sample);
  await page.waitForFunction(() => window.testPlayer.loaded && window.testPlayer.stream.renderer.canvas.width === 639);
  await page.locator('#seek').fill('990');
  await page.locator('#play').click();
  await page.waitForFunction(() => window.testPlayer.stream.ended);
  assert.equal(await page.locator('#video-title').textContent(), 'Color study');
  assert.equal(await page.evaluate(() => window.testPlayer.stream.paused), true);
  await page.locator('#play').click();
  await page.waitForFunction(() => window.testPlayer.stream.currentTime < 1 && !window.testPlayer.stream.paused);
  await page.locator('#play').click();
  const screenshots = process.env.SCREENSHOT_DIR;
  if (screenshots) { mkdirSync(screenshots, { recursive: true }); await page.screenshot({ path: join(screenshots, 'desktop.png'), fullPage: true }); }
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  if (screenshots) await page.screenshot({ path: join(screenshots, 'mobile.png'), fullPage: true });
  await page.reload();
  await page.evaluate(async () => { window.testPlayer = (await import('/app.js')).player; });
  await page.waitForFunction(() => window.testPlayer.stream.metadata && window.testPlayer.loaded);
  assert.equal(await page.locator('#resolution').inputValue(), '360');
  assert.equal(await page.locator('#speed').inputValue(), '1.5');
  const constrained = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await constrained.addInitScript(() => localStorage.setItem('weft:quality-v4', '"360"'));
  await constrained.route('**/sample.json', route => route.fulfill({ json: sample }));
  const slow = await constrained.newPage();
  const network = await constrained.newCDPSession(slow);
  await network.send('Network.enable');
  await network.send('Network.emulateNetworkConditions', { offline: false, latency: 100, downloadThroughput: 187500, uploadThroughput: 187500 });
  const transfers = new Map();
  network.on('Network.requestWillBeSent', event => { if (event.request.url.endsWith('.sci')) transfers.set(event.requestId, {body:0}); });
  network.on('Network.dataReceived', event => { const transfer=transfers.get(event.requestId); if (transfer) transfer.body+=event.encodedDataLength; });
  network.on('Network.loadingFinished', event => { const transfer=transfers.get(event.requestId); if (transfer) transfer.finished=event.encodedDataLength; });
  const transferred = () => [...transfers.values()].reduce((sum,transfer)=>sum+(transfer.finished ?? transfer.body),0);
  let fetched = 0;
  slow.on('response', response => { if (response.url().endsWith('.sci')) fetched += Number(response.headers()['content-length'] ?? 0); });
  const constrainedStartup = performance.now();
  await slow.goto(base, { waitUntil: 'domcontentloaded' });
  await slow.evaluate(async () => { window.testPlayer = (await import('/app.js')).player; });
  await slow.waitForFunction(() => window.testPlayer.loaded);
  const constrainedStartupMs = performance.now() - constrainedStartup;
  await slow.evaluate(() => {
    window.playbackMeasurements = { samples: 0, bufferingSamples: 0, maxQueuedFrames: 0, maxChunks: 0 };
    window.measurementTimer = setInterval(() => {
      const stream = window.testPlayer.stream;
      const measurements = window.playbackMeasurements;
      measurements.samples++;
      measurements.bufferingSamples += Number(stream.clock.buffering);
      measurements.maxQueuedFrames = Math.max(measurements.maxQueuedFrames, stream.frames?.queue.length ?? 0);
      measurements.maxChunks = Math.max(measurements.maxChunks, stream.reader?.cache.size ?? 0);
    }, 50);
  });
  await slow.locator('#big-play').click();
  await slow.waitForFunction(() => window.testPlayer.stream.currentTime >= 4, null, { timeout: 120000 });
  const measurements = await slow.evaluate(() => { clearInterval(window.measurementTimer); return window.playbackMeasurements; });
  assert.ok(measurements.maxQueuedFrames <= 9);
  console.log(JSON.stringify({ latencyMs:100, throughputBytesPerSecond:187500, startupMs:constrainedStartupMs, transferredSciBytes:transferred(), requestedSciBodyBytes:fetched, observedThroughVideoSeconds:4, ...measurements }));
  assert.equal(await slow.evaluate(() => window.testPlayer.stream.paused), false);
  assert.ok(fetched < sourceBytes.length);
  assert.equal(await slow.locator('#picture').getAttribute('height'), '360');
  await slow.evaluate(() => window.testPlayer.stream.pause());
  const seekStarted=performance.now();
  const beforeSeek=transferred();
  await slow.evaluate(async () => { await window.testPlayer.stream.seek(8.25); });
  console.log(JSON.stringify({coldSeekSeconds:8.25,seekMs:performance.now()-seekStarted,transferredSciBytes:transferred()-beforeSeek,latencyMs:100,throughputBytesPerSecond:187500}));
  await constrained.close();
  assert.equal((await post('/api/queue/remove', { id })).status, 200);
  assert.equal((await post('/api/queue/remove', { id: secondId })).status, 200);
  assert.equal((await (await fetch(`${base}/api/queue`)).json()).queue.length, 0);
  await page.evaluate(() => window.testPlayer.reset());
  assert.equal(await page.evaluate(() => window.testPlayer.stream.reader), null);
  assert.equal((await post('/api/queue/remove', { id: 'missing' })).status, 404);
  assert.equal((await post('/api/queue/remove', { id: 123 })).status, 400);
  assert.ok(requests.filter(request => request.url.endsWith('.sci')).every(request => request.range));
  assert.equal(requests.some(request => /\.(mp4|m3u8|ts|mp3)(?:$|\?)/.test(request.url)), false);
  const silent = join(temporary, 'Quiet scene.mp4');
  const silentEncode = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x238d61:size=320x180:rate=12', '-t', '2.25', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', silent], { encoding: 'utf8' });
  assert.equal(silentEncode.status, 0, silentEncode.stderr);
  assert.equal((await post('/api/queue/add', { video: silent })).status, 201);
  sample = { ...(await (await fetch(`${base}/api/queue`)).json()).queue[0], description: 'Integration fixture' };
  await page.reload();
  await page.evaluate(async () => { window.testPlayer = (await import('/app.js')).player; });
  await page.waitForFunction(() => window.testPlayer.loaded);
  assert.equal(await page.evaluate(() => window.testPlayer.stream.metadata.audio), null);
  assert.equal(await page.evaluate(() => window.testPlayer.stream.metadata.frames), 27);
  assert.equal(await page.evaluate(() => window.testPlayer.stream.reader.records.get('180:2').frames), 3);
  await page.locator('#big-play').click();
  await page.waitForFunction(() => window.testPlayer.stream.currentTime > 0.3);
  await page.locator('#seek').fill('990');
  await page.waitForFunction(() => window.testPlayer.stream.ended);
  assert.equal((await post('/api/queue/remove', { id: sample.id })).status, 200);
  const fractional = join(temporary, 'Fractional clock.mp4');
  const fractionalEncode = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=321x180:rate=30000/1001', '-f', 'lavfi', '-i', 'sine=frequency=550:sample_rate=48000', '-t', '2.2', '-c:v', 'libx264', '-c:a', 'aac', fractional], { encoding: 'utf8' });
  assert.equal(fractionalEncode.status, 0, fractionalEncode.stderr);
  assert.equal((await post('/api/queue/add', { video: fractional })).status, 201);
  sample = { ...(await (await fetch(`${base}/api/queue`)).json()).queue[0], description: 'Integration fixture' };
  await page.reload();
  await page.evaluate(async () => { window.testPlayer = (await import('/app.js')).player; });
  await page.waitForFunction(() => window.testPlayer.loaded);
  assert.equal(await page.evaluate(() => window.testPlayer.stream.metadata.fpsNumerator), 30000);
  assert.equal(await page.evaluate(() => window.testPlayer.stream.metadata.fpsDenominator), 1001);
  assert.equal(await page.evaluate(() => window.testPlayer.stream.reader.records.get('0:0').decoded), 48048);
  await page.locator('#big-play').click();
  await page.waitForFunction(() => window.testPlayer.stream.currentTime > 0.3);
  await page.locator('#seek').fill('990');
  await page.waitForFunction(() => window.testPlayer.stream.ended);
  assert.equal((await post('/api/queue/remove', { id: sample.id })).status, 200);
  assert.deepEqual(errors, []);
  await browser.close();
  browser = null;
  await stop();
  await launch();
  result = await (await fetch(`${base}/api/queue`)).json();
  assert.equal(result.queue.length, 0, 'Removed videos must not return on restart.');
  const pending = post('/api/queue/add', { video: first });
  for (let attempt = 0; attempt < 300; attempt++) {
    const queue = (await (await fetch(`${base}/api/queue`)).json()).queue;
    if (queue[0]?.status === 'preparing') break;
    await delay(10);
  }
  assert.equal((await post('/api/queue/remove', { id })).status, 200);
  const replacement = post('/api/queue/add', { video: first });
  assert.equal((await pending).status, 409, 'Old preparation must not overwrite a re-added entry.');
  assert.equal((await replacement).status, 201);
  const reencodedEntry = (await (await fetch(`${base}/api/queue`)).json()).queue[0];
  const reencodedBytes = await (await fetch(`${base}${reencodedEntry.media}`)).arrayBuffer();
  const regenerated = new Uint8Array(reencodedBytes);
  const regeneratedHeader = parseHeader(regenerated.subarray(0, 32));
  assert.deepEqual(JSON.parse(new TextDecoder().decode(regenerated.subarray(32, 32 + regeneratedHeader.metadataLength))), metadata);
  await stop();
  const catalogPath = join(data, 'catalog.json');
  const saved = JSON.parse(readFileSync(catalogPath, 'utf8'));
  const completed = saved[0].path;
  const abandoned = join(mediaDirectory, `${id}.123e4567-e89b-42d3-a456-426614174000.sci.tmp`);
  writeFileSync(abandoned, 'interrupted encoding');
  await launch();
  result = await (await fetch(`${base}/api/queue`)).json();
  assert.equal(result.queue[0].status, 'ready');
  assert.equal(existsSync(completed), true);
  assert.equal(existsSync(abandoned), false);
  await stop();
  saved[0].status = 'preparing';
  writeFileSync(catalogPath, JSON.stringify(saved));
  await launch();
  result = await (await fetch(`${base}/api/queue`)).json();
  assert.equal(result.queue[0].status, 'ready', 'Interrupted preparation must finish during startup.');
  assert.equal((await post(`/api/videos/${id}/prepare`, {})).status, 200);
  const finalEntry = (await (await fetch(`${base}/api/queue`)).json()).queue[0];
  const finalBytes = await (await fetch(`${base}${finalEntry.media}`)).arrayBuffer();
  const restored = new Uint8Array(finalBytes);
  const restoredHeader = parseHeader(restored.subarray(0, 32));
  assert.deepEqual(JSON.parse(new TextDecoder().decode(restored.subarray(32, 32 + restoredHeader.metadataLength))), metadata);
  const legacyDirectory = join(data, 'media');
  mkdirSync(legacyDirectory, { recursive: true });
  await stop();
  const legacySaved = JSON.parse(readFileSync(catalogPath, 'utf8'));
  const legacyArchive = join(legacyDirectory, `${id}.${legacySaved[0].revision}.sci`);
  cpSync(legacySaved[0].path, legacyArchive);
  cpSync(legacySaved[0].path.replace(/\.sci$/, '.jpg'), legacyArchive.replace(/\.sci$/, '.jpg'));
  rmSync(legacySaved[0].path);
  rmSync(legacySaved[0].path.replace(/\.sci$/, '.jpg'));
  legacySaved[0].path = legacyArchive;
  writeFileSync(catalogPath, JSON.stringify(legacySaved));
  await launch();
  const relocated = JSON.parse(readFileSync(catalogPath, 'utf8'))[0];
  assert.equal(relocated.path, join(mediaDirectory, `${id}.${legacySaved[0].revision}.sci`));
  assert.equal(existsSync(legacyArchive), false);
  assert.deepEqual(readFileSync(relocated.path), Buffer.from(finalBytes));

  const youtubeId = createHash('sha256').update('youtube:abc_def-123').digest('hex').slice(0, 20);
  assert.equal((await post('/api/queue/add', { video: 'youtu.be/abc_def-123' })).status, 201);
  let downloaded = JSON.parse(readFileSync(catalogPath, 'utf8')).find(video => video.id === youtubeId);
  const original = join(temporary, 'videos', 'youtube-abc_def-123.mp4');
  assert.equal(downloaded.original, original);
  assert.equal(downloaded.status, 'ready');
  assert.deepEqual(readFileSync(original), readFileSync(first));
  assert.ok(downloaded.path.startsWith(mediaDirectory));
  assert.equal(downloadCount(), 1);
  const cachedPath = downloaded.path;
  await stop();
  await launch();
  downloaded = JSON.parse(readFileSync(catalogPath, 'utf8')).find(video => video.id === youtubeId);
  assert.equal(downloaded.path, cachedPath);
  assert.equal(downloadCount(), 1, 'Ready startup must reuse the stored SCI and original.');
  await stop();
  rmSync(cachedPath);
  await launch();
  downloaded = JSON.parse(readFileSync(catalogPath, 'utf8')).find(video => video.id === youtubeId);
  assert.equal(downloaded.status, 'ready');
  assert.notEqual(downloaded.path, cachedPath);
  assert.equal(downloadCount(), 1, 'Missing SCI must rebuild from the retained original without downloading again.');
  await stop();
  const interrupted = JSON.parse(readFileSync(catalogPath, 'utf8'));
  const interruptedVideo = interrupted.find(video => video.id === youtubeId);
  const legacyOriginal = join(legacyDirectory, `${youtubeId}.${interruptedVideo.revision}.source.mp4`);
  cpSync(original, legacyOriginal);
  rmSync(original);
  interruptedVideo.status = 'preparing';
  writeFileSync(catalogPath, JSON.stringify(interrupted));
  const staging = join(temporary, 'videos', '.staging');
  const abandonedDownload = join(staging, readdirSync(staging)[0], `${youtubeId}.123e4567-e89b-42d3-a456-426614174000.source.mp4`);
  writeFileSync(abandonedDownload, 'interrupted download');
  await launch();
  downloaded = JSON.parse(readFileSync(catalogPath, 'utf8')).find(video => video.id === youtubeId);
  assert.equal(downloaded.status, 'ready');
  assert.deepEqual(readFileSync(original), readFileSync(first));
  assert.equal(existsSync(legacyOriginal), false);
  assert.equal(existsSync(abandonedDownload), false);
  assert.equal(downloadCount(), 1, 'Completed legacy download must survive interrupted SCI preparation.');
  await stop();
  const previousProfile = JSON.parse(readFileSync(catalogPath, 'utf8'));
  previousProfile.find(video => video.id === youtubeId).encoderProfile = 'rgb-threshold-v1';
  writeFileSync(catalogPath, JSON.stringify(previousProfile));
  await launch();
  const improved = JSON.parse(readFileSync(catalogPath, 'utf8')).find(video => video.id === youtubeId);
  assert.notEqual(improved.revision, downloaded.revision);
  assert.equal(improved.encoder, 'adaptive-layered-v2');
  assert.equal(downloadCount(), 1, 'Higher-fidelity fitting must reuse the retained original.');
  assert.equal((await fetch(`${base}/videos/youtube-abc_def-123.mp4`)).status, 404);
  assert.equal((await post('/api/queue/add', { video: 'youtu.be/fail_fail12' })).status, 400);
  assert.ok(readdirSync(staging).every(library => readdirSync(join(staging, library)).length === 0));
  assert.equal(existsSync(join(temporary, 'videos', 'youtube-fail_fail12.mp4')), false);
  await stop();
  const count = downloadCount();
  await launch(false, join(temporary, 'second-library'));
  const discovered = (await (await fetch(`${base}/api/queue`)).json()).queue;
  assert.equal(discovered.length, 1);
  assert.equal(discovered[0].id, youtubeId, 'Managed downloads must retain their YouTube identity during discovery.');
  assert.equal(discovered[0].status, 'ready');
  assert.equal(downloadCount(), count);
  assert.equal(existsSync(improved.path), true, 'One library must not delete another library archives.');
  console.log('Passed: SCI ASCII codec, printable glyphs, 360p reconstruction without WebCodecs, embedded audio, rational frame rates, silent and partial chunks, chunk checksums, retained downloads, startup conversion, SCI storage under videos, archive relocation, re-encoding and cached replay, measured archive size, constrained network playback, HTTP binary ranges, validation, concurrency, durable removal, removal/preparation race, recovery, full color, live quality switching, seeking, single-sample playback, controls, fullscreen, and mobile layout.');
} catch (error) {
  if (page && !page.isClosed()) console.error(await page.evaluate(() => ({ title: document.title, message: document.querySelector('#message-text').textContent, time: window.testPlayer.stream.currentTime, paused: window.testPlayer.stream.paused, size: [document.querySelector('canvas').width, document.querySelector('canvas').height] })));
  console.error(log);
  throw error;
} finally {
  await browser?.close();
  await stop();
  rmSync(temporary, { recursive: true, force: true });
}
