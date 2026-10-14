import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { crc32,parseHeader,parseIndex,asciiPackets,codecFormat,SciReader } from '../web/sci.js';
import { font,glyphMasks,reflectMask } from '../web/ascii.js';

const archive=new Uint8Array(readFileSync(new URL('../web/sample.sci',import.meta.url)));
const currentHeader=parseHeader(archive.subarray(0,32));
const metadata=JSON.parse(new TextDecoder().decode(archive.subarray(32,32+currentHeader.metadataLength)));
const index=archive.subarray(currentHeader.indexOffset,currentHeader.indexOffset+currentHeader.count*48);
function video(){return {codec:'sci-ascii-scene-v1',packetFormat:'ascii-scene-zlib',cellBytes:28,cellWidth:3,cellHeight:4,font:font.name,glyphTransform:'reflect-xy-v1'};}
function packet(tag,data,duration=33333){
 const compressed=deflateSync(data);const bytes=new Uint8Array(13+compressed.length);const view=new DataView(bytes.buffer);
 view.setUint32(0,duration,true);bytes[4]=tag;view.setUint32(5,data.length,true);view.setUint32(9,compressed.length,true);bytes.set(compressed,13);return bytes;
}

test('current archive index validates and unsupported containers and profiles fail',()=>{
 assert.equal(parseIndex(index,currentHeader,metadata).size,currentHeader.count);
 for(const version of [1,2,3,5]){const header=archive.slice(0,32);new DataView(header.buffer).setUint16(4,version,true);assert.throws(()=>parseHeader(header),/version/);}
 for(const codec of ['sci-ascii-v1','sci-ascii-v2','sci-ascii-scene-v2','sci-ascii-scene-v3','h264']){
  assert.throws(()=>codecFormat({...video(),codec}),/Unsupported/);
  assert.throws(()=>parseIndex(index,currentHeader,{...metadata,video:{...metadata.video,codec}}));
 }
 assert.throws(()=>codecFormat({...video(),font:'ascii-3x4-v1'}));
 const tooLarge=archive.slice(0,32);new DataView(tooLarge.buffer).setBigUint64(24,64n*1024n**3n+1n,true);assert.throws(()=>parseHeader(tooLarge));
 const broken=index.slice();new DataView(broken.buffer).setBigUint64(32,1n,true);assert.throws(()=>parseIndex(broken,currentHeader,metadata));
 assert.throws(()=>parseIndex(index.subarray(1),currentHeader,metadata));
});

test('timed packets preserve integer boundaries and reject removed tags and invalid durations',()=>{
 const first=packet(6,new Uint8Array(28),16667);const second=packet(6,new Uint8Array(28),16666);
 const record={columns:3,rows:4,frames:2,first:21,startUs:350000,endUs:383333};
 const packets=asciiPackets(new Uint8Array([...first,...second]),record);
 assert.equal(packets[0].end,packets[1].time);assert.equal(packets[1].end,.383333);
 for(const tag of [0,1,2,3,5,7,8,9])assert.throws(()=>asciiPackets(packet(tag,new Uint8Array(28)),{...record,frames:1,endUs:383333}));
 assert.throws(()=>asciiPackets(packet(6,new Uint8Array(28),0),{...record,frames:1}));
 assert.throws(()=>asciiPackets(first.subarray(0,first.length-1),{...record,frames:1}));
});

test('font declares exactly 95 printable symbols with fixed reflected masks',()=>{
 assert.equal(glyphMasks.size,1);assert.equal(font.glyphs.length,95);
 assert.deepEqual(font.glyphs.map(([code])=>code).toSorted((a,b)=>a-b),Array.from({length:95},(_,i)=>i+32));
 for(const [,mask]of font.glyphs){assert.equal(reflectMask(reflectMask(mask,1),1),mask);assert.equal(reflectMask(reflectMask(mask,2),2),mask);}
 assert.throws(()=>reflectMask(1,4));assert.equal(crc32(new TextEncoder().encode('123456789')),0xcbf43926);
});

test('SCI range transport bounds oversized bodies and cancels invalid responses', async () => {
  const original=globalThis.fetch;
  const reader=new SciReader('http://localhost/virtual.sci',{});
  let cancelled=false;
  try {
    globalThis.fetch=async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(16));},cancel(){cancelled=true;}}),{status:206,headers:{'Content-Range':'bytes 0-7/8'}});
    await assert.rejects(reader.range(0,8),/exceeds its byte range/);
    assert.equal(cancelled,true);
    globalThis.fetch=async()=>new Response(new Uint8Array(4),{status:206,headers:{'Content-Range':'bytes 0-7/8'}});
    await assert.rejects(reader.range(0,8),/truncated/);
    globalThis.fetch=async()=>new Response(new Uint8Array(8),{status:206,headers:{'Content-Range':'bytes 0-7/8'}});
    assert.equal((await reader.range(0,8)).length,8);
    await assert.rejects(reader.range(0,16*1024*1024+1));
  } finally {globalThis.fetch=original;reader.close();}
});

function cacheReader() {
  const reader=new SciReader('http://localhost/virtual.sci',{});
  const data=new Uint8Array(28);data[3]=32;
  const bytes=packet(6,data);
  reader.metadata={video:video(),audio:null};
  reader.records=new Map(Array.from({length:24},(_,chunk)=>[`4:${chunk}`,{offset:chunk,length:bytes.length,columns:3,rows:4,frames:1,first:chunk,fps:30,timed:true,startUs:chunk*33333,endUs:(chunk+1)*33333,checksum:crc32(bytes)}]));
  return {reader,bytes};
}

test('paused seeks and concurrent loads keep payload and request caches bounded', async () => {
  const {reader,bytes}=cacheReader();
  reader.range=async()=>bytes;
  for (let chunk=0;chunk<24;chunk++) {reader.trim(chunk,4);await reader.load(4,chunk);assert.ok(reader.cache.size<=128);assert.ok(reader.cacheBytes<=64*1024*1024);}
  assert.ok(reader.get(4,23)); assert.equal(reader.get(4,0),undefined);
  reader.close();
  const second=cacheReader().reader;
  second.range=(_,__,signal)=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('Cancelled','AbortError')),{once:true}));
  const pending=[];
  for (let chunk=0;chunk<24;chunk++) {pending.push(second.load(4,chunk).catch(error=>error));assert.ok(second.pending.size<=8);}
  second.trim(23,4,true);assert.equal(second.waiting.size,1);assert.equal(second.pending.size,0);
  second.close(); assert.ok((await Promise.all(pending)).every(error=>error.name==='AbortError'));
  await assert.rejects(second.load(4,0),{name:'AbortError'});
});

test('cancelled loads cannot remove a replacement request with the same key', async () => {
  const {reader}=cacheReader();
  reader.range=(_,__,signal)=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('Cancelled','AbortError')),{once:true}));
  const old=reader.load(4,0).catch(error=>error);
  reader.trim(1,4,true);
  const replacement=reader.load(4,0).catch(error=>error);
  await old;assert.equal(reader.pending.size,1);
  reader.close();assert.equal((await replacement).name,'AbortError');
});
