import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { deflateSync } from 'node:zlib';
import { FRAME_BYTES } from '../web/delivery.js';
import { setTimeout as delay } from 'node:timers/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const root = resolve(import.meta.dirname, '../..');
const webDirectory = resolve(process.env.TEST_WEB_DIR ?? join(root, 'player/web'));
const binary = resolve(process.env.TEST_PLAYER_BINARY ?? join(root, 'target/release', process.platform === 'win32' ? 'weft-player.exe' : 'weft-player'));
const temporary = mkdtempSync(join(tmpdir(), 'weft-native-player-'));
const port = Number(process.env.TEST_PORT ?? 18011);
function sceneFixture(variant) {
  const columns = 4; const rows = 4; const count = columns * rows;
  const cells = new Uint8Array(count * 28);
  for (let index = 0; index < count; index++) {
    const cell = cells.subarray(index * 28, (index + 1) * 28);
    cell.set([0, 0, 0, 32, (index * 37 + variant * 19) % 256, (113 + index * 29) % 256, (253 + index * 43) % 256, index % 5]);
    for (let layer = 0; layer < cell[7]; layer++) cell.set([32 + (index * 17 + layer * 13) % 95, (index + layer) % 4, (index * 11 + layer * 41 + variant * 17) % 256, (index * 31 + layer * 67) % 256, (index * 59 + layer * 83) % 256], 8 + layer * 5);
  }
  const data = new Uint8Array(cells.length);
  for (let channel = 0; channel < 28; channel++) {
    for (let index = 0; index < count; index++) {
      const left = index % columns ? cells[(index - 1) * 28 + channel] : 0;
      const above = index >= columns ? cells[(index - columns) * 28 + channel] : 0;
      const corner = index >= columns && index % columns ? cells[(index - columns - 1) * 28 + channel] : 0;
      const prediction = left + above - corner;
      const distances = [Math.abs(prediction - left), Math.abs(prediction - above), Math.abs(prediction - corner)];
      const paeth = distances[0] <= distances[1] && distances[0] <= distances[2] ? left : distances[1] <= distances[2] ? above : corner;
      data[channel * count + index] = (cells[index * 28 + channel] - paeth + 256) % 256;
    }
  }
  return { width: columns * 3, height: rows * 4, cells: [...cells], packet: { tag: 6, decoded: data.length, bytes: [...deflateSync(data)] } };
}

function colorFixtures() {
  let previous;
  return [0, 2, 1].map((mode, variant) => {
    const fixture = sceneFixture(variant);
    const cells = fixture.cells;
    const count = cells.length / 28;
    const fields = [0, 7, 5, 4, 6, 8, 9, 11, 10, 12, 13, 14, 16, 15, 17, 18, 19, 21, 20, 22, 23, 24, 26, 25, 27];
    const value = (frame, index, channel) => {
      const green = channel === 4 || channel === 6 ? 5 : channel >= 10 && (channel - 10) % 5 === 0 ? channel + 1 : channel >= 10 && (channel - 10) % 5 === 2 ? channel - 1 : null;
      return (frame[index * 28 + channel] - (green === null ? 0 : frame[index * 28 + green]) + 256) % 256;
    };
    const raw = [mode, count, 0, 0, 0];
    for (const channel of fields) {
      let prior = 0;
      for (let index = 0; index < count; index++) {
        if (channel >= 8 && (channel - 8) / 5 >= cells[index * 28 + 7]) continue;
        const current = value(cells, index, channel);
        const prediction = mode === 1 ? prior : mode === 2 && channel !== 0 && channel !== 7 ? value(previous, index, channel) : 0;
        raw.push((current - prediction + 256) % 256); prior = current;
      }
    }
    previous = cells;
    return { ...fixture, reset: mode !== 2, packet: { tag: mode === 2 ? 11 : 10, decoded: raw.length, bytes: [...deflateSync(Uint8Array.from(raw))] } };
  });
}

function paintedFixtures() {
  const count = 128 * 24;
  const first = new Uint8Array(count * 28);
  for (let index = 0; index < count; index++) first.set([0, 0, 0, 32, 23, 141, 97], index * 28);
  const deferred = first.slice(); deferred[33 * 28 + 4]++;
  const selected = first.slice(); selected[100 * 28 + 6]++;
  const dense = selected.slice();
  for (let index = 0; index < count; index++) dense[index * 28 + 5] += 7;
  const encode = (cells, previous) => {
    const prefix = previous ? 4 : 0;
    const data = new Uint8Array(prefix + cells.length);
    for (let channel = 0; channel < 28; channel++) for (let index = 0; index < count; index++) {
      let prediction=previous?.[index*28+channel] ?? 0;
      if(!previous) {
        const left=index%128?cells[(index-1)*28+channel]:0;const above=index>=128?cells[(index-128)*28+channel]:0;const corner=index>=128&&index%128?cells[(index-129)*28+channel]:0;
        const value=left+above-corner;const a=Math.abs(value-left),b=Math.abs(value-above),c=Math.abs(value-corner);
        prediction=a<=b&&a<=c?left:b<=c?above:corner;
      }
      data[prefix+channel*count+index]=(cells[index*28+channel]-prediction+256)%256;
    }
    return { tag: previous ? 7 : 6, decoded: data.length, bytes: [...deflateSync(data)] };
  };
  return [encode(first), encode(deferred, first), encode(selected, deferred), encode(selected), encode(dense)];
}

let server; let browser; let page;
try {
  cpSync(webDirectory, join(temporary, 'player/web'), {recursive:true});
  const source = join(temporary, 'Native 60 FPS.mp4');
  const result = spawnSync('ffmpeg', ['-nostdin','-v','error','-f','lavfi','-i','color=c=0x238d61:size=1920x1080:rate=60','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','3','-c:v','libx264','-preset','ultrafast','-c:a','aac',source], {encoding:'utf8'});
  if (result.error) throw result.error;
  assert.equal(result.status,0,result.stderr);
  server = spawn(binary, [source,'--port',String(port)], {cwd:temporary,stdio:['ignore','pipe','pipe']});
  let log = ''; server.stdout.on('data',bytes=>{log+=bytes;}); server.stderr.on('data',bytes=>{log+=bytes;});
  const base = `http://127.0.0.1:${port}`;
  let listening = false;
  for (let attempt=0;attempt<600;attempt++) {
    assert.equal(server.exitCode,null,log);
    try { if ((await fetch(`${base}/health`)).ok) {listening=true;break;} } catch {}
    await delay(100);
  }
  assert.ok(listening,log);
  browser = await chromium.launch({headless:true});
  page = await browser.newPage();
  await page.route(`${base}/tests/gpu-verify.mjs`, route => route.fulfill({status:200,contentType:'text/javascript',body:readFileSync(join(root,'player/tests/gpu-verify.mjs'),'utf8').replaceAll('../web/','/')}));
  const errors = []; page.on('pageerror',error=>errors.push(error.message));
  const sample = { ...(await (await fetch(`${base}/api/queue`)).json()).queue[0], description: 'Native fixture' };
  await page.route('**/sample.json', route => route.fulfill({ json: sample }));
  await page.goto(base);
  await page.evaluate(async()=>{window.testPlayer=(await import('/app.js')).player;});
  await page.waitForFunction(()=>window.testPlayer.loaded);
  const dirtyGpuVerification=await page.evaluate(async()=> (await import('/tests/gpu-verify.mjs')).verifyGpu());
  assert.equal(dirtyGpuVerification.exactSparseUpdates,true);assert.equal(dirtyGpuVerification.identicalUploadBytes,0);assert.ok(dirtyGpuVerification.cases>=10);
  assert.equal(await page.evaluate(()=>window.testPlayer.stream.metadata.frames),180);
  assert.equal(await page.evaluate(()=>window.testPlayer.stream.metadata.fps),60);
  assert.deepEqual(await page.locator('#resolution option').allTextContents(),['Auto (360p)','1080p','720p','480p','360p']);
  const workerVerification = await page.evaluate(async () => {
    const { WorkerDecoder } = await import('/worker.js');
    const { Decoder } = await import('/wasm.js');
    const { codecFormat } = await import('/sci.js');
    const stream = window.testPlayer.stream;
    const metadata = stream.metadata;
    const cpu = await Decoder.open(await (await fetch('/decoder.wasm')).arrayBuffer());
    const worker = new WorkerDecoder({ gpu: true, nativeInflation: true });
    const verified = [];
    const hash = async pixels => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', pixels)), value => value.toString(16).padStart(2, '0')).join('');
    try {
      for (const quality of metadata.qualities) {
        for (const chunk of [0, metadata.chunks - 1, 0]) {
          const packets = await stream.reader.load(quality.height, chunk);
          for (const [index, packet] of packets.slice(0, 2).entries()) {
            const expected = cpu.decode(packet, quality.columns, quality.rows, codecFormat(metadata.video), index === 0, metadata.video.font);
            const decoded = await worker.decode(packet, quality.columns, quality.rows, codecFormat(metadata.video), index === 0, metadata.video.font);
            if (decoded.renderer !== 'webgl2') throw new Error('GPU worker verification used a fallback renderer.');
            const output = new OffscreenCanvas(quality.columns, quality.rows);
            const context = output.getContext('2d', { alpha: false });
            try { context.drawImage(decoded.bitmap, 0, 0); } finally { decoded.bitmap.close(); }
            const actual = context.getImageData(0, 0, quality.columns, quality.rows).data;
            if (await hash(actual) !== await hash(expected)) throw new Error('GPU worker reconstructed different ASCII pixels.');
            verified.push({ height: quality.height, chunk, packet: index });
          }
        }
      }
    } finally { worker.close(); }
    return verified;
  });
  assert.equal(workerVerification.length, 24);
  const poolVerification = await page.evaluate(async () => {
    const { DecoderPool, decoderModule, partition } = await import('/decode-pool.js');
    const { Decoder } = await import('/wasm.js');
    const { codecFormat } = await import('/sci.js');
    const stream = window.testPlayer.stream; const metadata = stream.metadata;
    const module = await decoderModule(); const reference = await Decoder.open(module);
    const hash = async pixels => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', pixels)), value => value.toString(16).padStart(2,'0')).join('');
    let verified = 0; let peak = 0;
    for (const quality of metadata.qualities) {
      const packets = (await stream.reader.load(quality.height, 0)).slice(0, 12);
      const expected = new Map();
      for (const [index, packet] of packets.entries()) expected.set(packet.time, await hash(reference.decode(packet,quality.columns,quality.rows,codecFormat(metadata.video),index===0,metadata.video.font)));
      let reservations = 0; const checks = [];
      const segments = partition(packets,0); let remaining = segments.length;
      let done, failed; const ready = new Promise((resolve,reject) => {done=resolve;failed=reject;});
      const pool = new DecoderPool(4,{module}, {
        reserve: () => { if(reservations>=4)return false;reservations++;peak=Math.max(peak,reservations);return true; },
        release: () => reservations--,
        accept: (frame,packet) => {
          const canvas=new OffscreenCanvas(quality.columns,quality.rows);const context=canvas.getContext('2d',{alpha:false});
          try {context.drawImage(frame.bitmap,0,0);}finally{frame.bitmap.close();}
          checks.push(hash(context.getImageData(0,0,quality.columns,quality.rows).data).then(actual => {if(actual!==expected.get(packet.time))throw new Error('Parallel decoder changed ASCII pixels.');verified++;}));
        },
        complete: () => {if(!--remaining)done();}, fail: failed,
      });
      try { pool.add(segments);pool.pump(0,10,quality.columns,quality.rows,codecFormat(metadata.video),metadata.video.font);await ready;await Promise.all(checks); }
      finally {pool.close();}
    }
    return {verified,peak};
  });
  assert.equal(poolVerification.verified,48);assert.ok(poolVerification.peak<=4);
  const recovery = await page.evaluate(async () => {
    const { FrameDecoder } = await import('/decoder-worker.js');
    const { Decoder } = await import('/wasm.js');
    const { codecFormat } = await import('/sci.js');
    const stream = window.testPlayer.stream;
    const metadata = stream.metadata;
    const quality = metadata.qualities.find(quality => quality.height === 1080);
    const packets = await stream.reader.load(1080, 0);
    const module = await (await fetch('/decoder.wasm')).arrayBuffer();
    const cpu = await Decoder.open(module);
    const manager = new FrameDecoder(await Decoder.open(module));
    const hash = async pixels => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', pixels)), value => value.toString(16).padStart(2, '0')).join('');
    let recovered = 0;
    try {
      for (const [index, packet] of packets.slice(0, 3).entries()) {
        const expected = cpu.decode(packet, quality.columns, quality.rows, codecFormat(metadata.video), index === 0, metadata.video.font);
        const decoded = await manager.decode(packet, quality.columns, quality.rows, codecFormat(metadata.video), index === 0, metadata.video.font);
        if (index === 0) {
          if (decoded.renderer !== 'webgl2') throw new Error('Recovery test did not initialize GPU reconstruction.');
          const extension = manager.gpu.gl.getExtension('WEBGL_lose_context');
          if (!extension) throw new Error('GPU context loss testing is unavailable.');
          extension.loseContext();
          await new Promise(resolve => setTimeout(resolve, 0));
        } else {
          if (decoded.renderer !== 'canvas2d' || !decoded.gpuFailure) throw new Error('GPU failure did not continue through CPU reconstruction.');
          recovered++;
        }
        const output = new OffscreenCanvas(quality.columns, quality.rows);
        const context = output.getContext('2d', { alpha: false });
        try { context.drawImage(decoded.bitmap, 0, 0); } finally { decoded.bitmap.close(); }
        if (await hash(context.getImageData(0, 0, quality.columns, quality.rows).data) !== await hash(expected)) throw new Error('Recovery changed reconstructed ASCII pixels.');
      }
    } finally { manager.close(); }
    if (manager.decoder.exports.frame_length() !== 0 || manager.decoder.exports.pixels_length() !== 0) throw new Error('Closed frame decoder retained output.');
    const pendingManager = new FrameDecoder(await Decoder.open(module), { gpu: false, nativeInflation: true });
    const pending = pendingManager.decode(packets[0], quality.columns, quality.rows, codecFormat(metadata.video), true, metadata.video.font);
    pendingManager.close();
    try { await pending; throw new Error('Closed pending decode completed.'); } catch (error) { if (error.name !== 'AbortError') throw error; }
    if (pendingManager.decoder.exports.frame_length() !== 0 || pendingManager.decoder.exports.pixels_length() !== 0) throw new Error('Pending close retained decoder output.');
    return { recovered, pendingClose: true };
  });
  assert.deepEqual(recovery, { recovered: 2, pendingClose: true });
  const sceneVerification = await page.evaluate(async fixtures => {
    const { WorkerDecoder } = await import('/worker.js');
    const { Decoder } = await import('/wasm.js');
    const module = await (await fetch('/decoder.wasm')).arrayBuffer();
    const hash = async pixels => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', pixels)), value => value.toString(16).padStart(2, '0')).join('');
    let verified = 0;
    for (const gpu of [false, true]) for (const nativeInflation of [false, true]) {
      const worker = new WorkerDecoder({ gpu, nativeInflation });
      const reference = await Decoder.open(module);
      try {
        for (const [index, fixture] of fixtures.entries()) {
          const reset = fixture.reset ?? index !== 1;
          const packet = { ...fixture.packet, bytes: new Uint8Array(fixture.packet.bytes) };
          const expectedCells = reference.decodeCells(packet, fixture.width, fixture.height, 28, reset);
          if (JSON.stringify([...expectedCells]) !== JSON.stringify(fixture.cells)) throw new Error('Scene attributes changed source ASCII cells.');
          const expected = reference.renderCurrentCells(fixture.width, fixture.height);
          const decoded = await worker.decode(packet, fixture.width, fixture.height, 28, reset, 'ascii-3x4-v2');
          if (decoded.renderer !== (gpu ? 'webgl2' : 'canvas2d')) throw new Error('Spatial packet used an unexpected renderer.');
          const canvas = new OffscreenCanvas(fixture.width, fixture.height);
          const context = canvas.getContext('2d', { alpha: false });
          try { context.drawImage(decoded.bitmap, 0, 0); } finally { decoded.bitmap.close(); }
          if (await hash(context.getImageData(0, 0, fixture.width, fixture.height).data) !== await hash(expected)) throw new Error('Spatial packet changed rendered ASCII pixels.');
          verified++;
        }
      } finally { worker.close(); }
    }
    return { verified, codec: 'sci-ascii-scene-v1', tags: [6, 10, 11], priorReferenceIgnored: true, seekReset: true };
  }, [sceneFixture(0), sceneFixture(1), sceneFixture(0), ...colorFixtures()]);
  assert.equal(sceneVerification.verified, 24);
  const deferredVerification = await page.evaluate(async fixtures => {
    const {WorkerDecoder}=await import('/worker.js');const {Decoder}=await import('/wasm.js');
    const module=await WebAssembly.compile(await (await fetch('/decoder.wasm')).arrayBuffer());
    const hash=async pixels=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',pixels)),value=>value.toString(16).padStart(2,'0')).join('');
    let consumed=0,painted=0;
    for(const gpu of [false,true]) {
      const worker=new WorkerDecoder({module,gpu,deferredRendering:true});const cpu=await Decoder.open(module);
      try {
        for(const [index,fixture] of fixtures.entries()) {
          const packet={...fixture.packet,bytes:new Uint8Array(fixture.packet.bytes)};
          const expected=cpu.decode(packet,fixture.width,fixture.height,28,index===0,'ascii-3x4-v2');
          const present=index!==1;
          const result=await worker.decode(packet,fixture.width,fixture.height,28,index===0,'ascii-3x4-v2',present);
          if(!present) {if(!result.consumed||result.bitmap||result.pixels)throw new Error('Consumed event allocated presentation pixels.');consumed++;continue;}
          const canvas=new OffscreenCanvas(fixture.width,fixture.height);const context=canvas.getContext('2d',{alpha:false});
          try {context.drawImage(result.bitmap,0,0);}finally{result.bitmap.close();}
          if(await hash(context.getImageData(0,0,fixture.width,fixture.height).data)!==await hash(expected))throw new Error('Deferred event lost the temporal ASCII reference.');
          painted++;
        }
      } finally {worker.close();}
    }
    return {consumed,painted,referenceAfterDeferred:true};
  },[sceneFixture(0),sceneFixture(1),{width:12,height:16,packet:{tag:7,decoded:4+16*28,bytes:[...deflateSync(new Uint8Array(4+16*28))]}},sceneFixture(2)]);
  assert.deepEqual(deferredVerification,{consumed:2,painted:6,referenceAfterDeferred:true});
  const paintedVerification = await page.evaluate(async packets => {
    const { WorkerDecoder } = await import('/worker.js');
    const { Decoder } = await import('/wasm.js');
    const module = await WebAssembly.compile(await (await fetch('/decoder.wasm')).arrayBuffer());
    const cpu = await Decoder.open(module);
    if (!cpu.supportsPaintedPlan) throw new Error('Native painted planning ABI is missing.');
    const worker = new WorkerDecoder({ module, gpu: true, deferredRendering: true });
    const hash = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].join(',');
    const metrics = []; let verified = 0;
    try {
      for (const [index, item] of packets.entries()) {
        const packet = { ...item, bytes: new Uint8Array(item.bytes) };
        const reset = index === 0 || index === 3;
        const expected = cpu.decode(packet, 384, 96, 28, reset);
        const frame = await worker.decode(packet, 384, 96, 28, reset, 'ascii-3x4-v2', index !== 1);
        if (index === 1) { if (!frame.consumed || frame.bitmap) throw new Error('Deferred source event was presented.'); continue; }
        if (frame.renderer !== 'webgl2') throw new Error('Native painted planning used a fallback renderer.');
        const canvas = new OffscreenCanvas(384, 96); const context = canvas.getContext('2d', { alpha: false });
        try { context.drawImage(frame.bitmap, 0, 0); } finally { frame.bitmap.close(); }
        if (await hash(context.getImageData(0, 0, 384, 96).data) !== await hash(expected)) throw new Error('Native dirty plan changed ASCII pixels.');
        metrics.push(frame.gpuMetrics); verified++;
      }
    } finally { worker.close(); }
    if (metrics[1].changedCells !== 1 || metrics[1].full || metrics[1].reconstructedPixels !== 32 * 8 * 12) throw new Error('Sparse plan did not compare the last painted reference.');
    if (metrics[2].uploadedBytes !== 0 || metrics[2].reconstructedPixels !== 0) throw new Error('Ordinary decode reset invalidated identical painted pixels.');
    if (!metrics[3].full || metrics[3].changedCells !== null) throw new Error('Sampled dense fallback claimed an exact count.');
    if (metrics.some(metric => metric.retainedAttributeBytes !== 0)) throw new Error('Native plan retained a duplicate JS snapshot.');
    return { verified, sparseChanges: metrics[1].changedCells, identicalUploadBytes: metrics[2].uploadedBytes, deferredReference: true, duplicateJsSnapshot: false };
  }, paintedFixtures());
  assert.deepEqual(paintedVerification, { verified: 4, sparseChanges: 1, identicalUploadBytes: 0, deferredReference: true, duplicateJsSnapshot: false });
  const automaticVerification = await page.evaluate(async packets => {
    const { FrameDecoder } = await import('/decoder-worker.js');
    const { Decoder } = await import('/wasm.js');
    const module = await (await fetch('/decoder.wasm')).arrayBuffer();
    const expected = await Decoder.open(module);
    const manager = new FrameDecoder(await Decoder.open(module), { gpu: false, deferredRendering: true, automaticRenderer: true });
    const width = 384, height = 96, format = 28, font = 'ascii-3x4-v2';
    const decoded = packets.map((packet, sourceFrame) => ({ ...packet, sourceFrame, bytes: new Uint8Array(packet.bytes) }));
    const decision = (packet, gpu, epoch, releaseGpu = false) => ({ sourceFrame: packet.sourceFrame, width, height, format, gpu, epoch, releaseGpu });
    const hash = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].join(',');
    let verified = 0;
    const check = async (packet, gpu, epoch, reset, present = true, release = false) => {
      const pixels = expected.decode(packet, width, height, format, reset, font);
      const result = await manager.decode(packet, width, height, format, reset, font, present, decision(packet, gpu, epoch, release));
      if (!present) { if (!result.consumed) throw new Error('Automatic deferred source event produced a bitmap.'); return result; }
      const canvas = new OffscreenCanvas(width, height), context = canvas.getContext('2d', { alpha: false });
      try { context.drawImage(result.bitmap, 0, 0); } finally { result.bitmap.close(); }
      if (await hash(context.getImageData(0, 0, width, height).data) !== await hash(pixels)) throw new Error('Automatic renderer changed ASCII pixels.');
      if (!Number.isFinite(result.producedAt) || result.producedAt > performance.timeOrigin + performance.now()) throw new Error('Renderer timestamp has a different monotonic origin.');
      verified++; return result;
    };
    try {
      const first = await check(decoded[0], true, 0, true); if (first.renderer !== 'webgl2') throw new Error('Automatic GPU probe fell back.');
      await check(decoded[1], false, 1, false, false);
      const cpu = await check(decoded[2], false, 1, false); if (cpu.renderer !== 'canvas2d') throw new Error('Automatic CPU epoch retained GPU presentation.');
      const synchronized = await check(decoded[3], true, 2, true);
      if (!synchronized.gpuMetrics.full || synchronized.gpuMetrics.uploadedBytes !== 128 * 24 * 28) throw new Error('GPU return used a stale partial reference after CPU presentation.');
      const released = await check(decoded[3], false, 3, true, true, true);
      if (released.renderer !== 'canvas2d' || manager.gpu !== null) throw new Error('Settled CPU policy retained GPU resources.');
      await check(decoded[4], true, 4, true);
      manager.gpu.gl.getExtension('WEBGL_lose_context').loseContext(); await new Promise(resolve => setTimeout(resolve, 0));
      const fallback = await check(decoded[3], true, 4, true);
      if (fallback.renderer !== 'canvas2d' || !fallback.gpuFailure) throw new Error('Automatic context failure did not preserve CPU continuation.');
      const before = await hash(manager.decoder.currentCells(width, height, format));
      for (const invalid of [{ ...decision(decoded[3], true, 5), width: 6 }, { ...decision(decoded[3], true, 5), sourceFrame: -1 }, { ...decision(decoded[3], true, 5), epoch: NaN }]) {
        let rejected = false; try { await manager.decode(decoded[3], width, height, format, true, font, true, invalid); } catch { rejected = true; }
        if (!rejected || await hash(manager.decoder.currentCells(width, height, format)) !== before) throw new Error('Malformed automatic ownership changed reference state.');
      }
      await check(decoded[3], false, 5, true, true, true);
      const retried = await check(decoded[3], true, 6, true);
      if (retried.renderer !== 'webgl2' || !retried.gpuMetrics.full) throw new Error('Automatic GPU retry did not restore a full reference.');
      return { verified, deferredEvents: 1, fullReturn: true, releasedGpu: true, contextRecovery: true, malformedOwnership: 3 };
    } finally { manager.close(); }
  }, paintedFixtures());
  assert.equal(automaticVerification.verified, 8);
  const cpuStreamVerification = await page.evaluate(async () => {
    const { Stream } = await import('/stream.js');
    const { PixelRenderer } = await import('/renderer.js');
    const { Decoder } = await import('/wasm.js');
    const { codecFormat } = await import('/sci.js');
    const canvas = document.createElement('canvas');
    const stream = new Stream(new PixelRenderer(canvas), document.createElement('select'), (message, error) => { if (error) throw new Error(message); }, { gpu: false });
    stream.preference = '1080';
    try {
      await stream.load({ media: window.testPlayer.stream.reader.url });
      if (stream.frames.metrics.renderers?.canvas2d < 1 || stream.frames.pool.slots.some(slot => slot.decoder.gpu)) throw new Error('CPU Stream policy did not reach pooled workers.');
      const decoder = await Decoder.open(await (await fetch('/decoder.wasm')).arrayBuffer());
      const packet = (await stream.reader.load(1080, 0))[0];
      const expected = decoder.decode(packet, 1920, 1080, codecFormat(stream.metadata.video), true, stream.metadata.video.font);
      const actual = canvas.getContext('2d').getImageData(0, 0, 1920, 1080).data;
      const hash = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].join(',');
      if (await hash(actual) !== await hash(expected)) throw new Error('CPU Stream policy changed selected ASCII pixels.');
      return { exactPixels: true, workerPolicy: 'cpu', renderers: { ...stream.frames.metrics.renderers } };
    } finally { stream.reset(); await stream.clock.context.close(); }
  });
  assert.equal(cpuStreamVerification.exactPixels, true);
  const autoStreamVerification = await page.evaluate(async () => {
    const { Stream } = await import('/stream.js');
    const { PixelRenderer } = await import('/renderer.js');
    const { FRAME_BYTES } = await import('/delivery.js');
    const canvas = document.createElement('canvas'); document.body.append(canvas);
    const quality = document.createElement('select');
    let failure;
    const stream = new Stream(new PixelRenderer(canvas), quality, (message, error) => { if (error) failure = message; }, { renderer: 'auto' });
    stream.preference = '360';
    const cpuPreparation = () => {
      if (!stream.frames.policy.enabled || stream.frames.policy.mode !== 'cpu' || stream.frames.metrics.renderers?.webgl2 || stream.frames.pool.slots.some(slot => !slot.decoder.automaticRenderer)) throw new Error('Auto preparation did not publish a CPU image before pooled calibration.');
    };
    try {
      await stream.load({ media: window.testPlayer.stream.reader.url }); cpuPreparation();
      const initial = stream.frames;
      await stream.seek(.5); cpuPreparation();
      if (!initial.closed || initial.policy === stream.frames.policy || stream.currentTime !== .5) throw new Error('Auto seek reused stale policy ownership.');
      const seeking = stream.frames;
      await stream.switchQuality(480); cpuPreparation();
      if (!seeking.closed || seeking.policy === stream.frames.policy || canvas.height !== 480 || stream.currentTime !== .5) throw new Error('Auto quality preparation changed clock or retained old policy ownership.');
      quality.value = '360'; await stream.seek(0); stream.playbackRate = 2;
      await stream.play();
      const ended = new Promise(resolve => stream.addEventListener('ended', resolve, { once: true }));
      let timer;
      try { await Promise.race([ended, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(failure || 'Auto Stream correctness playback timed out.')), 30000); })]); }
      finally { clearTimeout(timer); }
      const frames = stream.frames;
      if (failure || frames.nextOrdinal !== 180 || frames.metrics.skippedSeekFrames !== 0 || frames.metrics.lateDecoded !== 0 || frames.metrics.sourceConsumed !== 180) throw new Error(failure || 'Auto policy omitted source events.');
      if (frames.policy.metrics.samples < 1 || frames.policy.metrics.epochs.length < 2 || frames.metrics.visibleDrawMilliseconds === undefined || frames.metrics.presentationQueueMilliseconds === undefined) throw new Error(`Auto policy did not observe the live pooled visible-canvas path: ${JSON.stringify({ metrics: frames.metrics, policy: frames.policy.metrics, hidden: document.hidden })}`);
      if (frames.queueBytes + frames.reservedBytes > FRAME_BYTES) throw new Error('Auto policy exceeded presentation reservations.');
      return { sourceEvents: frames.metrics.sourceConsumed, visibleDraws: frames.metrics.painted, epochs: frames.policy.metrics.epochs.length, selected: frames.policy.mode, measuredSamples: frames.policy.metrics.samples, seekOwnership: true, qualityOwnership: true };
    } finally { stream.reset(); await stream.clock.context.close(); canvas.remove(); }
  });
  assert.equal(autoStreamVerification.sourceEvents, 180);
  const singleCell = new Uint8Array(28); singleCell[3] = 32; singleCell.set([78, 90, 123], 4);
  const compressedCell = deflateSync(singleCell);
  const nativeInflation = await page.evaluate(async ({ valid, truncated, trailing, excessive }) => {
    const { Decoder } = await import('/wasm.js');
    const decoder = await Decoder.open(await (await fetch('/decoder.wasm')).arrayBuffer());
    const decode = bytes => decoder.decodeNative({ tag: 6, decoded: 28, bytes: new Uint8Array(bytes) }, 3, 4, 28, true);
    const pixels = await decode(valid);
    if (pixels[0] !== 78 || pixels[1] !== 90 || pixels[2] !== 123 || pixels.length !== 48) throw new Error('Native inflation changed cell reconstruction.');
    let rejected = 0;
    for (const bytes of [truncated, trailing, excessive]) {
      try { await decode(bytes); } catch { rejected++; }
    }
    if (rejected !== 3) throw new Error('Native inflation accepted malformed zlib input.');
    await decode(valid);
    return { rejected, recovered: true };
  }, {
    valid: [...compressedCell],
    truncated: [...compressedCell.subarray(0, compressedCell.length - 2)],
    trailing: [...compressedCell, 88],
    excessive: [...deflateSync(Buffer.alloc(16384, 255))],
  });
  assert.deepEqual(nativeInflation, { rejected: 3, recovered: true });
  for (const [height,width] of [[480,852],[720,1281],[1080,1920],[360,639]]) {
    await page.evaluate(height=>{const stream=window.testPlayer.stream;stream.qualityControl.value=String(height);stream.changeQuality(String(height));},height);
    await page.waitForFunction(height=>window.testPlayer.stream.renderer.canvas.height===height,height);
    assert.equal(await page.evaluate(()=>document.querySelector('canvas').width),width);
    assert.equal(await page.evaluate(()=>window.testPlayer.stream.currentTime),0);
  }
  await page.evaluate(async()=>{const stream=window.testPlayer.stream;await stream.seek(stream.duration);});
  assert.equal(await page.evaluate(()=>window.testPlayer.stream.currentTime),3);
  await page.evaluate(()=>{const stream=window.testPlayer.stream;stream.qualityControl.value='1080';stream.changeQuality('1080');});
  await page.waitForFunction(()=>window.testPlayer.stream.renderer.canvas.height===1080);
  assert.equal(await page.evaluate(()=>window.testPlayer.stream.currentTime),3);
  await page.locator('#settings-toggle').click();
  await page.locator('#speed').selectOption('2');
  assert.equal(await page.evaluate(()=>window.testPlayer.stream.playbackRate),2);
  await page.locator('#close-settings').click();
  await page.evaluate(async()=>{const stream=window.testPlayer.stream;await stream.seek(0);await stream.play();});
  await page.waitForFunction(()=>window.testPlayer.stream.currentTime>0.25);
  await page.evaluate(async()=>{
    const stream=window.testPlayer.stream;
    stream.qualityControl.value='1080';stream.changeQuality('1080');
    await stream.seek(1.25);
  });
  await page.waitForFunction(()=>window.testPlayer.stream.renderer.canvas.height===1080 && window.testPlayer.stream.currentTime>1.5);
  const metrics = await page.evaluate(()=>({height:document.querySelector('canvas').height, ...window.testPlayer.stream.frames.metrics}));
  assert.ok(metrics.frameBytes<=FRAME_BYTES);
  await page.waitForFunction(()=>window.testPlayer.stream.ended);
  const finalFrontier = await page.evaluate(() => {
    const stream = window.testPlayer.stream;
    return { sourceFrame: stream.frames.nextOrdinal, frames: stream.metadata.frames, time: stream.currentTime, sourceEnd: stream.frames.consumedEnd };
  });
  assert.equal(finalFrontier.sourceFrame, finalFrontier.frames);
  assert.ok(finalFrontier.time <= finalFrontier.sourceEnd + 1e-9);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({nativeFps:60,frames:180,qualities:[360,480,720,1080],gpuWorkerVerifiedPackets:workerVerification.length,poolVerification,dirtyGpuVerification,recovery,nativeInflation,sceneVerification,deferredVerification,paintedVerification,automaticVerification,cpuStreamVerification,autoStreamVerification,finalFrontier,metrics}));
} catch (error) {
  if (page && !page.isClosed()) console.error(JSON.stringify(await page.evaluate(() => {
    const stream = window.testPlayer?.stream;
    return stream && { time: stream.currentTime, ended: stream.ended, paused: stream.paused, buffering: stream.clock.buffering,
      quality: stream.quality, frames: stream.frames?.metrics, policy: stream.frames?.policy?.metrics,
      nextOrdinal: stream.frames?.nextOrdinal, consumedEnd: stream.frames?.consumedEnd, error: document.querySelector('#status')?.textContent };
  }).catch(() => null)));
  throw error;
} finally {
  await browser?.close();
  if (server?.exitCode===null) {const stopped=once(server,'exit');server.kill();await stopped;}
  rmSync(temporary,{recursive:true,force:true});
}
