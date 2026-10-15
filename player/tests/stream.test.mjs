import test from 'node:test';
import assert from 'node:assert/strict';
import { Stream } from '../web/stream.js';

Object.defineProperty(globalThis, 'localStorage', { value: {getItem:()=>null,setItem(){}}, configurable:true });

class AudioStub {
  constructor() {this.currentTime=0;this.sampleRate=48000;}
  async resume() {}
  createGain(){return {gain:{setValueAtTime(){}},connect(){}};}
}

test('play and resume reuse prepared decoder ownership and wait for bounded lead', async () => {
  const oldAudio = globalThis.AudioContext;
  globalThis.AudioContext = AudioStub;
  try {
    const { stream } = fixture();
    let prepared = 0, closed = 0;
    const frames = stream.frames = { quality: 360, chunk: 1, async catchup(position, rate, lead) {
      prepared++; assert.equal(position, .5); assert.equal(rate, 2); assert.equal(lead, 16 / 60);
    }, close() { closed++; } };
    stream.clock.position = .5; stream.clock.rate = 2; stream.clock.context.currentTime = 10;
    stream.metadata.fps = 1; stream.clock.rate = 100;
    assert.equal(stream.playbackLead(), 1);
    stream.metadata.fps = 60; stream.clock.rate = 2;
    stream.seek = () => assert.fail('Prepared playback restarted its decoder');
    await stream.play(); assert.equal(stream.frames, frames); assert.equal(stream.clock.buffering, false);
    stream.pause(); await stream.play();
    assert.equal(prepared, 2); assert.equal(closed, 0);
    stream.reset(); assert.equal(closed, 1);
  } finally { globalThis.AudioContext = oldAudio; }
});
class WorkerStub {
  static messages=[];
  postMessage(data) {WorkerStub.messages.push(data);queueMicrotask(()=>this.onmessage({data:{id:data.id,prepared:data.type==='prepare',pixels:new Uint8ClampedArray(4),renderDecision:data.renderDecision}}));}
  terminate(){}
}
function fixture(options) {
  const quality=new EventTarget();quality.value='360';quality.options=[{}];
  const drawn=[];const messages=[];
  const stream=new Stream({draw:frame=>drawn.push(frame.height),clear(){}},quality,value=>messages.push(value),options);
  stream.quality=360;
  stream.metadata={version:4,duration:10,chunks:1,fps:60,audio:null,video:{codec:'sci-ascii-scene-v1',cellBytes:28,font:'ascii-3x4-v2',glyphTransform:'reflect-xy-v1'},qualities:[{height:360,columns:3,rows:360},{height:480,columns:3,rows:480}]};
  const records=new Map([360,480].map(height=>[`${height}:0`,{chunk:0,start:0,end:10,length:16}]));
  const packets=[{sourceFrame:0,tag:6,time:0,duration:10,decoded:28,bytes:Uint8Array.of(1)}];
  stream.reader={metadata:stream.metadata,records,timelines:new Map([360,480].map(height=>[height,[records.get(`${height}:0`)]])),cache:new Map(),pending:new Map(),waiting:new Map(),
    recordAt:height=>records.get(`${height}:0`),trim(first,quality,_,last){this.window={quality,first,last};},
    retain:()=>({value:packets,release(){}}),get:()=>packets,close(){}};
  stream.prefetch=()=>{};stream.schedule=()=>{};stream.tick=()=>{};
  const requests=[];stream.ensure=(chunk,quality)=>new Promise((resolve,reject)=>requests.push({chunk,quality,resolve,reject}));
  return {stream,requests,drawn,messages};
}

test('FPS changes immediately cap active and preparing renderers without touching playback or source timing', () => {
  const oldAudio = globalThis.AudioContext;
  globalThis.AudioContext = AudioStub;
  try {
    const { stream } = fixture();
    stream.frames = { close() {} }; stream.preparingFrames = { close() {} };
    stream.clock.position = 2.25; stream.clock.rate = 2;
    const reader = stream.reader, epoch = stream.epoch, operation = stream.operation;
    stream.displayRate = 144; stream.frameRate = 30;
    assert.equal(stream.frames.displayRate, 30); assert.equal(stream.preparingFrames.displayRate, 30);
    stream.displayRate = 24; stream.frameRate = 60;
    assert.equal(stream.displayRate, 24); assert.equal(stream.frames.displayRate, 24);
    stream.displayRate = Infinity;
    assert.equal(stream.displayRate, 60); assert.equal(stream.preparingFrames.displayRate, 60);
    for (const invalid of [0, 45, NaN, '30']) assert.throws(() => { stream.frameRate = invalid; }, /30 or 60 FPS/);
    assert.equal(stream.frameRate, 60); assert.equal(stream.metadata.fps, 60);
    assert.equal(stream.currentTime, 2.25); assert.equal(stream.playbackRate, 2);
    assert.equal(stream.reader, reader); assert.equal(stream.epoch, epoch); assert.equal(stream.operation, operation);
    stream.reset();
  } finally { globalThis.AudioContext = oldAudio; }
});

test('quality preparation freezes playback position and publishes one complete tier', async () => {
  const oldAudio=globalThis.AudioContext,oldWorker=globalThis.Worker,oldFetch=globalThis.fetch;
  globalThis.AudioContext=AudioStub;globalThis.Worker=WorkerStub;
  globalThis.fetch=async()=>new Response(Uint8Array.of(0,97,115,109,1,0,0,0));
  try {
    const {stream,requests,drawn}=fixture();stream.clock.playing=true;stream.clock.context.currentTime=1;
    const pending=stream.switchQuality(480);
    assert.equal(stream.clock.buffering,true);assert.equal(stream.currentTime,1);assert.equal(stream.quality,360);
    stream.clock.context.currentTime=5;assert.equal(stream.currentTime,1);
    requests[0].resolve();await pending;
    assert.equal(stream.quality,480);assert.deepEqual(drawn,[480]);assert.equal(stream.currentTime,1);
    assert.equal(stream.clock.buffering,false);stream.reset();
  } finally {globalThis.AudioContext=oldAudio;globalThis.Worker=oldWorker;globalThis.fetch=oldFetch;}
});

test('renderer policy propagates to pooled workers through preparation and seek', async () => {
  const oldAudio=globalThis.AudioContext,oldWorker=globalThis.Worker,oldFetch=globalThis.fetch;
  globalThis.AudioContext=AudioStub;globalThis.Worker=WorkerStub;
  globalThis.fetch=async()=>new Response(Uint8Array.of(0,97,115,109,1,0,0,0));
  WorkerStub.messages=[];
  try {
    assert.throws(()=>fixture({gpu:'false'}),/renderer policy/);
    const {stream,requests}=fixture({gpu:false});
    const prepared=stream.switchQuality(480);requests[0].resolve();await prepared;
    const seeking=stream.seek(2);requests[1].resolve();await seeking;
    assert.ok(WorkerStub.messages.length>=2);
    assert.ok(WorkerStub.messages.every(message=>message.gpu===false&&message.deferredRendering===true));
    assert.ok(stream.frames.pool.slots.every(slot=>slot.decoder.gpu===false));
    stream.reset();
  } finally {globalThis.AudioContext=oldAudio;globalThis.Worker=oldWorker;globalThis.fetch=oldFetch;}
});

test('new seek cancels a pending quality switch and ignores its later failure', async () => {
  const oldAudio=globalThis.AudioContext,oldWorker=globalThis.Worker;
  globalThis.AudioContext=AudioStub;globalThis.Worker=WorkerStub;
  try {
    const {stream,requests,drawn,messages}=fixture();
    const switching=stream.switchQuality(480);const seeking=stream.seek(3.25);
    requests[0].reject(new Error('Stale request failed'));await switching;
    requests[1].resolve();await seeking;
    assert.equal(stream.quality,360);assert.equal(stream.currentTime,3.25);assert.deepEqual(drawn,[360]);
    assert.ok(!messages.includes('Stale request failed'));assert.equal(stream.frames.closed,false);stream.reset();
  } finally {globalThis.AudioContext=oldAudio;globalThis.Worker=oldWorker;}
});

test('automatic renderer starts each atomic preparation on CPU and activates only after publishing', async () => {
  const oldAudio = globalThis.AudioContext, oldWorker = globalThis.Worker, oldFetch = globalThis.fetch;
  globalThis.AudioContext = AudioStub; globalThis.Worker = WorkerStub;
  globalThis.fetch = async () => new Response(Uint8Array.of(0,97,115,109,1,0,0,0));
  WorkerStub.messages = [];
  try {
    const { stream, requests } = fixture({ renderer: 'auto' });
    const prepared = stream.switchQuality(480); requests[0].resolve(); await prepared;
    const previous = stream.frames;
    assert.equal(previous.policy.enabled, true); assert.equal(previous.policy.mode, 'cpu');
    const seeking = stream.seek(2); requests[1].resolve(); await seeking;
    assert.equal(previous.closed, true); assert.notEqual(stream.frames.policy, previous.policy);
    assert.ok(WorkerStub.messages.filter(message => message.type !== 'prepare').every(message => message.automaticRenderer && message.renderDecision.epoch === -1 && !message.renderDecision.gpu));
    stream.reset();
  } finally { globalThis.AudioContext = oldAudio; globalThis.Worker = oldWorker; globalThis.fetch = oldFetch; }
});

test('delivery follows an uncached required chunk and advances while playback is frozen', () => {
  const oldAudio=globalThis.AudioContext,oldDocument=globalThis.document,oldRaf=globalThis.requestAnimationFrame,oldCancel=globalThis.cancelAnimationFrame;
  globalThis.AudioContext=AudioStub;globalThis.document={hidden:false};
  let callback;globalThis.requestAnimationFrame=value=>{callback=value;return 1;};globalThis.cancelAnimationFrame=()=>{};
  try {
    const {stream}=fixture();const timeline=Array.from({length:200},(_,chunk)=>({chunk,start:chunk*.02,end:(chunk+1)*.02,length:1024}));
    stream.reader.timelines=new Map([[360,timeline]]);stream.reader.recordAt=(_,position)=>timeline[Math.min(199,Math.floor(position/.02))];
    stream.clock.position=.5;stream.clock.playing=true;stream.clock.buffering=true;
    stream.frames={quality:360,chunk:22,pump(){},draw(){},ready:()=>true,close(){}};
    let prefetched=0;stream.prefetch=()=>prefetched++;
    Stream.prototype.tick.call(stream);callback();
    assert.equal(stream.window.first,22);assert.ok(stream.window.last>=25);assert.equal(prefetched,1);
    stream.frames.chunk=24;callback();assert.equal(stream.window.first,24);assert.equal(prefetched,2);
    stream.frames.chunk=30;callback();assert.equal(stream.window.first,25);
    stream.reset();
  } finally {globalThis.AudioContext=oldAudio;globalThis.document=oldDocument;globalThis.requestAnimationFrame=oldRaf;globalThis.cancelAnimationFrame=oldCancel;}
});

test('playback waits for the final source frame and paints it before ending', () => {
  const oldAudio=globalThis.AudioContext,oldDocument=globalThis.document,oldRaf=globalThis.requestAnimationFrame,oldCancel=globalThis.cancelAnimationFrame;
  globalThis.AudioContext=AudioStub;globalThis.document={hidden:false};
  let callback;globalThis.requestAnimationFrame=value=>{callback=value;return 1;};globalThis.cancelAnimationFrame=()=>{};
  try {
    const {stream}=fixture();let ready=false,buffered=0,painted=0;
    stream.clock.position=10;stream.clock.playing=true;
    stream.frames={quality:360,chunk:1,pump(){},draw(position){assert.equal(position,10-.000001);painted++;},ready:()=>ready,close(){}};
    stream.buffer=async()=>{buffered++;stream.clock.buffering=true;};
    Stream.prototype.tick.call(stream);callback();
    assert.equal(stream.ended,false);assert.equal(buffered,1);assert.equal(painted,0);
    ready=true;callback();assert.equal(stream.ended,true);assert.equal(stream.paused,true);assert.equal(painted,1);
    stream.reset();
  } finally {globalThis.AudioContext=oldAudio;globalThis.document=oldDocument;globalThis.requestAnimationFrame=oldRaf;globalThis.cancelAnimationFrame=oldCancel;}
});
