import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openSync, readSync, closeSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const [archive, ...heightTexts] = process.argv.slice(2);
const heights = heightTexts.length ? heightTexts.map(Number) : [360, 480, 720, 1080];
assert.ok(archive && heights.every(height => [360, 480, 720, 1080].includes(height)), 'Usage: node player/tests/browser-playback-benchmark.mjs ARCHIVE [HEIGHT...]');
const maximumFrames = Number(process.env.TEST_FRAMES ?? 60);
assert.ok(Number.isInteger(maximumFrames) && maximumFrames >= 1 && maximumFrames <= 240);
const file = openSync(archive, 'r');
const size = statSync(archive).size;
const startedUtc = new Date().toISOString();
const sourcePaths = ['../web/gpu.js', '../web/wasm.js', '../web/ascii.js', '../web/sci.js', '../web/checksum.js', '../web/delivery.js', '../web/integrity-worker.js', '../web/glyphs.json', '../web/decoder.wasm', 'gpu-verify.mjs', 'browser-playback-benchmark.mjs'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceHashes = Object.fromEntries(sourcePaths.map(path => [path, digest(readFileSync(resolve(import.meta.dirname, path)))]));
const archiveIdentity = { bytes: size, sha256: size <= 128 * 1024 * 1024 ? digest(readFileSync(archive)) : null };
const baselineGpu = process.env.TEST_BASELINE_GPU ? readFileSync(process.env.TEST_BASELINE_GPU) : null;
const gpuSources = {
  candidateSha256: createHash('sha256').update(readFileSync(resolve(import.meta.dirname, '../web/gpu.js'))).digest('hex'),
  ...(baselineGpu ? { baselineSha256: createHash('sha256').update(baselineGpu).digest('hex') } : {}),
};
const server = createServer((request, response) => {
  if (request.url === '/baseline-gpu.js' && baselineGpu) {
    response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(baselineGpu);
  } else if (request.url === '/archive.sci') {
    const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '');
    if (!match) { response.writeHead(400).end(); return; }
    const start = Number(match[1]); const end = Number(match[2]);
    if (start < 0 || end < start || end >= size || end - start + 1 > 16 * 1024 * 1024) { response.writeHead(416).end(); return; }
    const bytes = Buffer.alloc(end - start + 1);
    assert.equal(readSync(file, bytes, 0, bytes.length, start), bytes.length);
    response.writeHead(206, { 'Content-Type': 'application/octet-stream', 'Content-Range': `bytes ${start}-${end}/${size}` }).end(bytes);
  } else if (request.url === '/tests/gpu-verify.mjs') {
    response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(readFileSync(resolve(import.meta.dirname, 'gpu-verify.mjs')));
  } else if (['/sci.js', '/ascii.js', '/opus.js', '/wasm.js', '/glyphs.json', '/decoder.wasm', '/gpu.js', '/checksum.js', '/delivery.js', '/integrity-worker.js', '/web/ascii.js', '/web/gpu.js', '/web/glyphs.json'].includes(request.url)) {
    response.writeHead(200, { 'Content-Type': request.url.endsWith('.js') ? 'text/javascript' : request.url.endsWith('.wasm') ? 'application/wasm' : 'application/json' }).end(readFileSync(resolve(import.meta.dirname, '../web', request.url.replace(/^\/(web\/)?/, ''))));
  } else if (request.url === '/') response.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>SCI decoder benchmark</title>');
  else response.writeHead(404).end();
});
let browser;
try {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const report = await page.evaluate(async ({ heights, maximumFrames, compareBaselineGpu }) => {
    const { SciReader, codecFormat } = await import('/sci.js');
    const { Decoder } = await import('/wasm.js');
    const { AsciiGpu } = await import('/gpu.js');
    const BaselineAsciiGpu = compareBaselineGpu ? (await import('/baseline-gpu.js')).AsciiGpu : null;
    const { verifyGpu } = await import('/tests/gpu-verify.mjs');
    const gpuVerification = verifyGpu();
    const reader = new SciReader('/archive.sci', {});
    const metadata = await reader.open();
    const module = await (await fetch('/decoder.wasm')).arrayBuffer();
    const results = [];
    const probe = new OffscreenCanvas(1, 1).getContext('webgl2');
    const extension = probe?.getExtension('WEBGL_debug_renderer_info');
    const webgl = probe ? { vendor: probe.getParameter(extension ? extension.UNMASKED_VENDOR_WEBGL : probe.VENDOR), renderer: probe.getParameter(extension ? extension.UNMASKED_RENDERER_WEBGL : probe.RENDERER) } : null;
    probe?.getExtension('WEBGL_lose_context')?.loseContext();
    for (const height of heights) {
      const quality = metadata.qualities.find(quality => quality.height === height);
      if (!quality) throw new Error('Requested quality is missing.');
      const chunks = []; let frames = 0;
      for (let index = 0; index < metadata.chunks && frames < maximumFrames; index++) {
        const packets = await reader.load(height, index);
        const selected = packets.slice(0, maximumFrames - frames);
        chunks.push(selected); frames += selected.length;
      }
      const modes = [{ nativeInflation: false, gpu: false, milliseconds: [] }, { nativeInflation: true, gpu: false, milliseconds: [] }, { nativeInflation: false, gpu: true, milliseconds: [] }, { nativeInflation: true, gpu: true, milliseconds: [] }];
      if (BaselineAsciiGpu) modes.push({ nativeInflation: false, gpu: true, baselineGpu: true, milliseconds: [] }, { nativeInflation: true, gpu: true, baselineGpu: true, milliseconds: [] });
      let expected;
      for (let iteration = 0; iteration < 4; iteration++) for (const mode of iteration % 2 ? modes.toReversed() : modes) {
        const decoder = await Decoder.open(module);
        const gpu = mode.gpu ? new (mode.baselineGpu ? BaselineAsciiGpu : AsciiGpu)(new OffscreenCanvas(quality.columns, quality.rows)) : null;
        const hashes = []; let elapsed = 0; let decodeElapsed = 0; let renderElapsed = 0;
        let uploadedBytes = 0; let reconstructedPixels = 0; let fullUpdates = 0;
        for (const packets of chunks) for (const [index, packet] of packets.entries()) {
          const started = performance.now();
          const decoded = await decoder[mode.gpu ? (mode.nativeInflation ? 'decodeCellsNative' : 'decodeCells') : (mode.nativeInflation ? 'decodeNative' : 'decode')](packet, quality.columns, quality.rows, codecFormat(metadata.video), index === 0, metadata.video.font, false);
          const decodedAt = performance.now();
          decodeElapsed += decodedAt - started;
          if (gpu) {
            const plan = mode.baselineGpu ? null : decoder.paintedPlan?.();
            const cells = plan ? decoder.currentCells(quality.columns, quality.rows, codecFormat(metadata.video), false) : decoded;
            gpu.draw(cells, quality.columns, quality.rows, plan); gpu.gl.finish();
            if (!mode.baselineGpu && plan) decoder.commitPainted();
            mode.nativeChanges = Boolean(plan);
          }
          if (gpu) {
            uploadedBytes += gpu.metrics?.uploadedBytes ?? decoded.length;
            reconstructedPixels += gpu.metrics?.reconstructedPixels ?? quality.columns * quality.rows;
            fullUpdates += Number(gpu.metrics?.full ?? true);
          }
          renderElapsed += performance.now() - decodedAt;
          elapsed += performance.now() - started;
          let pixels = decoded;
          if (gpu) {
            const raw = new Uint8Array(quality.columns * quality.rows * 4);
            gpu.gl.readPixels(0, 0, quality.columns, quality.rows, gpu.gl.RGBA, gpu.gl.UNSIGNED_BYTE, raw);
            pixels = new Uint8Array(raw.length);
            const rowBytes = quality.columns * 4;
            for (let y = 0; y < quality.rows; y++) pixels.set(raw.subarray((quality.rows - y - 1) * rowBytes, (quality.rows - y) * rowBytes), y * rowBytes);
          }
          const digest = await crypto.subtle.digest('SHA-256', pixels);
          hashes.push(Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join(''));
        }
        gpu?.close();
        const fingerprint = JSON.stringify(hashes);
        if (expected && expected !== fingerprint) throw new Error('Decoders reconstructed different pixels.');
        expected = fingerprint;
        if (iteration) {
          mode.milliseconds.push(elapsed); (mode.decodeMilliseconds ??= []).push(decodeElapsed); (mode.reconstructionMilliseconds ??= []).push(renderElapsed);
          if (gpu) (mode.attributeUpdates ??= []).push({ uploadedBytes, reconstructedPixels, fullUpdates });
        }
      }
      results.push({ height, width: quality.columns, frames, framePixelSha256: JSON.parse(expected), results: modes.map(mode => ({ ...mode, medianMillisecondsPerFrame: mode.milliseconds.toSorted((a, b) => a - b)[1] / frames })) });
      reader.trim(metadata.chunks, height);
    }
    reader.close();
    return { userAgent: navigator.userAgent, webgl, gpuVerification, codec: metadata.video.codec, nativeFps: metadata.fps, warmups: 1, measuredIterations: 3, includesPresentation: false, includesGpuCompletion: true, results };
  }, { heights, maximumFrames, compareBaselineGpu: Boolean(baselineGpu) });
  for (const [path, hash] of Object.entries(sourceHashes)) assert.equal(digest(readFileSync(resolve(import.meta.dirname, path))), hash, 'Benchmark source changed during measurement.');
  console.log(JSON.stringify({ ...report, gpuSources, sourceHashes, archiveIdentity, startedUtc, finishedUtc: new Date().toISOString() }, null, 2));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  closeSync(file);
}
