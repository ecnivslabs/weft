import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createReadStream, readFileSync, statSync, openSync, readSync, closeSync, existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { cpus, platform, arch } from 'node:os';
import { parseHeader, parseIndex, asciiPackets, codecFormat } from '../web/sci.js';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const [archive, ...heightTexts] = process.argv.slice(2);
const heights = heightTexts.length ? heightTexts.map(Number) : [360,480,720,1080];
assert.ok(archive && heights.every(height=>[360,480,720,1080].includes(height)), 'Usage: node website/tests/streaming-benchmark.mjs ARCHIVE [HEIGHT...]');
const seconds = Number(process.env.TEST_SECONDS ?? 10);
const iterations = Number(process.env.TEST_ITERATIONS ?? 3);
const latency = Number(process.env.TEST_LATENCY_MS ?? 0);
const throughput = Number(process.env.TEST_BYTES_PER_SECOND ?? -1);
const maximumWallSeconds = Number(process.env.TEST_WALL_SECONDS ?? 120);
assert.ok(seconds>0 && seconds<=120 && Number.isInteger(iterations) && iterations>=1 && iterations<=10 && latency>=0 && throughput>=-1 && maximumWallSeconds>0 && maximumWallSeconds<=600);
const variants = [{name:'candidate',directory:resolve(process.env.TEST_CANDIDATE_WEB ?? resolve(import.meta.dirname,'../web'))}];
if(process.env.TEST_BASELINE_WEB)variants.unshift({name:'baseline',directory:resolve(process.env.TEST_BASELINE_WEB)});
const renderers = (process.env.TEST_RENDERERS ?? 'gpu').split(',');
assert.ok(renderers.length >= 1 && renderers.length <= 3 && new Set(renderers).size === renderers.length && renderers.every(renderer => ['gpu', 'cpu', 'auto'].includes(renderer)));
assert.ok(process.env.TEST_BASELINE_CPU_SUPPORTED === undefined || ['0','1'].includes(process.env.TEST_BASELINE_CPU_SUPPORTED), 'Invalid baseline CPU capability declaration.');
const baselineCpuSupported = process.env.TEST_BASELINE_CPU_SUPPORTED === '1';
assert.ok(variants.length === 1 || renderers.every(renderer => renderer === 'gpu') || (baselineCpuSupported && renderers.every(renderer => renderer === 'cpu')), 'Historical baseline assets do not provide a CPU renderer policy without an explicit capability declaration.');
const assets = new Set(['stream.js','frames.js','sci.js','ascii.js','audio.js','storage.js','renderer.js','worker.js','decoder-worker.js','wasm.js','decoder.wasm','glyphs.json','gpu.js','delivery.js','decode-pool.js','checksum.js','integrity-worker.js','opus.js','calibration.js']);
function fingerprintModules() { return variants.map(variant => {
  const hash = createHash('sha256'); const shared = createHash('sha256');
  for (const name of [...assets].sort()) {
    const path = resolve(variant.directory, name);
    const bytes = existsSync(path) ? readFileSync(path) : Buffer.alloc(0);
    hash.update(name).update('\0').update(String(bytes.length)).update('\0').update(bytes);
    if (name !== 'decoder.wasm') shared.update(name).update('\0').update(String(bytes.length)).update('\0').update(bytes);
  }
  return { name: variant.name, webSha256: hash.digest('hex'), sharedWebSha256: shared.digest('hex'), wasmSha256: createHash('sha256').update(readFileSync(resolve(variant.directory,'decoder.wasm'))).digest('hex') };
}); }
const moduleIdentities = fingerprintModules();
assert.ok(process.env.TEST_MODULE_ONLY === undefined || ['0','1'].includes(process.env.TEST_MODULE_ONLY), 'Invalid module-only comparison declaration.');
const moduleOnly = process.env.TEST_MODULE_ONLY === '1';
if (moduleOnly) { assert.equal(variants.length, 2); assert.equal(moduleIdentities[0].sharedWebSha256, moduleIdentities[1].sharedWebSha256, 'Module-only comparison requires identical other playback assets.'); }
const driverIdentity = () => createHash('sha256').update(readFileSync(import.meta.filename)).digest('hex');
const driverSha256 = driverIdentity();
const size=statSync(archive).size;
const file=openSync(archive,'r');let archiveIdentity;
try {
  const headerBytes=Buffer.alloc(32);assert.equal(readSync(file,headerBytes,0,32,0),32);const header=parseHeader(headerBytes);
  const metadataBytes=Buffer.alloc(header.metadataLength);assert.equal(readSync(file,metadataBytes,0,metadataBytes.length,32),metadataBytes.length);
  const metadata=JSON.parse(metadataBytes);const index=Buffer.alloc(header.count*header.recordBytes);assert.equal(readSync(file,index,0,index.length,header.indexOffset),index.length);
  const records=parseIndex(index,header,metadata);
  archiveIdentity={name:basename(archive),bytes:size,metadata,headerMetadataIndexSha256:createHash('sha256').update(headerBytes).update(metadataBytes).update(index).digest('hex'),
    intersectingRecords:heights.map(height=>{const selected=[...records.values()].filter(record=>record.quality===height&&record.start<seconds);
      const last=selected.at(-1);const payload=Buffer.alloc(last.length);assert.equal(readSync(file,payload,0,payload.length,last.offset),payload.length);
      const packets=asciiPackets(payload,last,metadata.video.cellBytes,codecFormat(metadata.video));
      const elapsedEvents=last.first+packets.filter(packet=>(packet.end??packet.time+packet.duration)<=Math.min(seconds,metadata.duration)).length;
      return {height,sourceEventsFullyElapsedByRequestedTime:elapsedEvents,firstFrame:selected[0].first,lastFrameExclusive:selected.at(-1).first+selected.at(-1).frames,start:selected[0].start,end:selected.at(-1).end,
      frames:selected.reduce((sum,record)=>sum+record.frames,0),visualBytes:selected.reduce((sum,record)=>sum+record.length,0),records:selected.length};})};
} finally {closeSync(file);}

const server=createServer((request,response)=>{
  if(request.url==='/archive.sci'){
    const match=/^bytes=(\d+)-(\d+)$/.exec(request.headers.range??'');
    const start=Number(match?.[1]),end=Number(match?.[2]);
    if(!match || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start<0 || end<start || end>=size || end-start+1>16*1024*1024){response.writeHead(416).end();return;}
    response.writeHead(206,{'Content-Type':'application/octet-stream','Content-Length':end-start+1,'Content-Range':`bytes ${start}-${end}/${size}`});
    const stream=createReadStream(archive,{start,end});
    response.on('close',()=>stream.destroy());stream.on('error',error=>response.destroy(error));stream.pipe(response);
    return;
  }
  if(request.url==='/') {response.writeHead(200,{'Content-Type':'text/html'}).end('<!doctype html><title>SCI sustained playback</title><select id="quality"></select><canvas></canvas>');return;}
  const match=/^\/(baseline|candidate)\/([^/]+)$/.exec(request.url??'');
  const variant=variants.find(variant=>variant.name===match?.[1]);
  if(!variant || !assets.has(match[2])){response.writeHead(404).end();return;}
  try{response.writeHead(200,{'Content-Type':match[2].endsWith('.wasm')?'application/wasm':match[2].endsWith('.json')?'application/json':'text/javascript'}).end(readFileSync(resolve(variant.directory,match[2])));}
  catch{response.writeHead(404).end();}
});
let browser;
const started=new Date().toISOString();
try {
  server.listen(0,'127.0.0.1');await once(server,'listening');
  browser=await chromium.launch({headless:true});
  const base=`http://127.0.0.1:${server.address().port}`;
  const results=[];
  const rendererOrder = iteration => renderers.length === 3 ? [...renderers.slice(iteration % 3), ...renderers.slice(0, iteration % 3)] : iteration % 2 ? renderers.toReversed() : renderers;
  for(let iteration=0;iteration<iterations;iteration++)for(const height of heights)for(const variant of iteration%2?variants.toReversed():variants)for(const renderer of rendererOrder(iteration)){
    const context=await browser.newContext({viewport:{width:1440,height:900}});
    const page=await context.newPage();
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    const network=await context.newCDPSession(page);await network.send('Network.enable');
    if(latency || throughput>=0)await network.send('Network.emulateNetworkConditions',{offline:false,latency,downloadThroughput:throughput,uploadThroughput:-1});
    const transfers=new Map();
    network.on('Network.requestWillBeSent',event=>{if(event.request.url.endsWith('/archive.sci'))transfers.set(event.requestId,{body:0});});
    network.on('Network.dataReceived',event=>{const item=transfers.get(event.requestId);if(item)item.body+=event.encodedDataLength;});
    network.on('Network.loadingFinished',event=>{const item=transfers.get(event.requestId);if(item)item.finished=event.encodedDataLength;});
    try {
      await page.goto(base);
      const result=await page.evaluate(async ({height,variant,renderer,seconds,maximumWallSeconds})=>{
        localStorage.setItem('weft:quality-v4',JSON.stringify(String(height)));
        const {Stream}=await import(`/${variant}/stream.js`);const {PixelRenderer}=await import(`/${variant}/renderer.js`);
        let playbackError=null;
        const stream=new Stream(new PixelRenderer(document.querySelector('canvas')),document.querySelector('select'),(message,error)=>{if(error)playbackError=message;},renderer==='auto'?{renderer:'auto'}:{gpu:renderer==='gpu'});
        const probe=new OffscreenCanvas(1,1).getContext('webgl2');const extension=probe?.getExtension('WEBGL_debug_renderer_info');
        const webgl=probe?{vendor:probe.getParameter(extension?extension.UNMASKED_VENDOR_WEBGL:probe.VENDOR),renderer:probe.getParameter(extension?extension.UNMASKED_RENDERER_WEBGL:probe.RENDERER)}:null;
        probe?.getExtension('WEBGL_lose_context')?.loseContext();
        let waitingEvents=0;stream.addEventListener('waiting',()=>waitingEvents++);
        const startup=performance.now();await stream.load({media:'/archive.sci'});
        if(!stream.metadata || stream.quality!==height)throw new Error('Requested stream was not prepared.');
        const startupMilliseconds=performance.now()-startup;stream.playbackRate=2;
        const playStarted=performance.now();await stream.play();
        const preparationMilliseconds=performance.now()-playStarted;
        const target=Math.min(seconds,stream.duration);const started=performance.now();
        let last=started,bufferingMilliseconds=0,samples=0,maxQueueBytes=0,maxReservedFrameBytes=0,maxCacheBytes=0,maxRequestBytes=0,maxWorkers=0,maxLeases=0,maxUnclampedClockLeadSeconds=0;
        const unclampedClockTime=()=>stream.clock.playing&&!stream.clock.buffering ? stream.clock.position+Math.max(0,stream.clock.context.currentTime-stream.clock.anchor)*stream.clock.rate : stream.clock.position;
        const diagnostics=[];let timedOut=false;
        try {
          while(stream.currentTime<target && !stream.paused){
            await new Promise(resolve=>setTimeout(resolve,10));const now=performance.now();
            if(stream.clock.buffering)bufferingMilliseconds+=now-last;last=now;samples++;
            const frames=stream.frames;const reader=stream.reader;
            if(Number.isFinite(frames?.consumedEnd))maxUnclampedClockLeadSeconds=Math.max(maxUnclampedClockLeadSeconds,unclampedClockTime()-frames.consumedEnd);
            maxQueueBytes=Math.max(maxQueueBytes,frames?.queueBytes??0);
            maxReservedFrameBytes=Math.max(maxReservedFrameBytes,(frames?.queueBytes??0)+(frames?.reservedBytes??((frames?.reservations??0)*(frames?.frameBytes??0))));
            maxCacheBytes=Math.max(maxCacheBytes,reader?.cacheBytes??0);maxRequestBytes=Math.max(maxRequestBytes,reader?.requestBytes??0);
            maxWorkers=Math.max(maxWorkers,frames?.pool?.slots.length??(frames?.decoder?1:0));maxLeases=Math.max(maxLeases,reader?.leases?.size??0);
            if(samples%100===0)diagnostics.push({position:stream.currentTime,buffering:stream.clock.buffering,decoded:frames?.metrics.decoded,queue:frames?.queue.length});
            if(now-started>maximumWallSeconds*1000){timedOut=true;break;}
          }
          const metadata=stream.metadata;
          return {outcome:timedOut?'timeout':playbackError?'error':stream.currentTime>=target?'reached':'paused',playbackError,decoderNextChunk:stream.frames?.chunk,readerWindow:stream.reader?.window,cacheKeys:[...(stream.reader?.cache.keys()??[])],height,codec:metadata.video.codec,nativeFps:metadata.fps,duration:metadata.duration,playbackRate:stream.playbackRate,displayRate:Number.isFinite(stream.displayRate)?stream.displayRate:null,observedVideoSeconds:stream.currentTime,
            startupMilliseconds,preparationMilliseconds,playbackMilliseconds:performance.now()-started,bufferingMilliseconds,waitingEvents,samples,maxQueueBytes,maxReservedFrameBytes,reservationAccountingAvailable:Number.isFinite(stream.frames?.reservedBytes),maxCacheBytes:Number.isFinite(stream.reader?.cacheBytes)?maxCacheBytes:null,maxRequestBytes:Number.isFinite(stream.reader?.requestBytes)?maxRequestBytes:null,maxWorkers,maxLeases,
            contiguousSourceFramesConsumed:stream.frames?.metrics.sourceConsumed??null,contiguousSourceEnd:stream.frames?.consumedEnd??null,
            unclampedClockSeconds:unclampedClockTime(),maxUnclampedClockLeadSeconds,
            decodedFramesConsumedBeforeObservationEnd:(stream.frames?.metrics.consumed??0)+(stream.frames?.metrics.lateDecoded??0),
            frameMetrics:{...stream.frames?.metrics},readerMetrics:{...stream.reader?.metrics},webgl,userAgent:navigator.userAgent,hardwareConcurrency:navigator.hardwareConcurrency,diagnostics};
        } finally {stream.reset();await stream.clock.context.close();}
      },{height,variant:variant.name,renderer,seconds,maximumWallSeconds});
      assert.deepEqual(errors,[]);
      assert.ok(result.maxReservedFrameBytes<=32*1024*1024);assert.ok(result.maxCacheBytes<=64*1024*1024);assert.ok(result.maxRequestBytes<=48*1024*1024);assert.ok(result.maxWorkers<=4);
      if (renderer === 'cpu') {
        const actual = result.frameMetrics.renderers ?? {};
        assert.ok(actual.canvas2d > 0 && actual.canvas2d === result.frameMetrics.reconstructed && Object.keys(actual).every(name => name === 'canvas2d'), 'CPU policy did not reconstruct every image through canvas2d.');
      }
      results.push({iteration,variant:variant.name,rendererPolicy:renderer,...result,transferredSciBytes:[...transfers.values()].reduce((sum,item)=>sum+(item.finished??item.body),0)});
    } finally {await context.close();}
  }
  assert.deepEqual(fingerprintModules(), moduleIdentities, 'Playback assets changed during the measurement window.');
  assert.equal(driverIdentity(), driverSha256, 'Playback driver changed during the measurement window.');
  console.log(JSON.stringify({started,finished:new Date().toISOString(),assetsUnchanged:true,host:{platform:platform(),arch:arch(),cpu:cpus()[0]?.model,logicalCpus:cpus().length},archive:archiveIdentity,
    modules:moduleIdentities,driverSha256,baselineCpuSupported,moduleOnly,
    network:{latencyMilliseconds:latency,downloadBytesPerSecond:throughput},renderers,iterations,maximumWallSecondsPerTrial:maximumWallSeconds,requestedVideoSeconds:seconds,includesAudio:true,includesTransport:true,includesPresentation:true,results},null,2));
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
