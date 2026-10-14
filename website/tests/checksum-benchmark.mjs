import assert from 'node:assert/strict';
import {openSync,readSync,closeSync,readFileSync,fstatSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {basename,resolve} from 'node:path';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {cpus,platform,arch} from 'node:os';
import {parseHeader,parseIndex} from '../web/sci.js';
import {crc32} from '../web/checksum.js';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE??'playwright');
const referenceTable=new Uint32Array(256).map((_,index)=>{
  let value=index;
  for(let bit=0;bit<8;bit++)value=value&1?0xedb88320^(value>>>1):value>>>1;
  return value>>>0;
});
function bytewise(bytes){
  let crc=0xffffffff;
  for(const byte of bytes)crc=referenceTable[(crc^byte)&255]^(crc>>>8);
  return (crc^0xffffffff)>>>0;
}
const baselineSource=`const referenceTable=new Uint32Array(${JSON.stringify([...referenceTable])});${bytewise.toString()};export {bytewise as crc32};`;
const candidatePath=resolve(import.meta.dirname,'../web/checksum.js');

function fixture(path) {
  const file=openSync(path,'r');
  try {
    const headerBytes=Buffer.alloc(32); assert.equal(readSync(file,headerBytes,0,32,0),32);
    const header=parseHeader(headerBytes);
    assert.equal(header.size,fstatSync(file).size,'Archive size differs from its declared header.');
    const metadataBytes=Buffer.alloc(header.metadataLength);
    assert.equal(readSync(file,metadataBytes,0,metadataBytes.length,32),metadataBytes.length);
    const metadata=JSON.parse(metadataBytes);
    const index=Buffer.alloc(header.count*header.recordBytes);
    assert.equal(readSync(file,index,0,index.length,header.indexOffset),index.length);
    const record=[...parseIndex(index,header,metadata).values()].find(record=>record.quality===1080);
    assert.ok(record&&record.length<=16*1024*1024);
    const bytes=Buffer.alloc(record.length);
    assert.equal(readSync(file,bytes,0,bytes.length,record.offset),bytes.length);
    assert.equal(crc32(bytes),record.checksum);assert.equal(bytewise(bytes),record.checksum);
    return {bytes,identity:{archive:basename(path),archiveBytes:header.size,headerMetadataIndexSha256:createHash('sha256').update(headerBytes).update(metadataBytes).update(index).digest('hex'),chunk:record.chunk,offset:record.offset,bytes:record.length,checksum:record.checksum,sha256:createHash('sha256').update(bytes).digest('hex')}};
  } finally {closeSync(file);}
}
const paths=process.argv.slice(2);
assert.ok(paths.length>0&&paths.length<=6,'Usage: node website/tests/checksum-benchmark.mjs ARCHIVE.sci [ARCHIVE.sci...]');
const fixtures=paths.map(fixture);
const sources={...Object.fromEntries([candidatePath,import.meta.filename].map(path=>[basename(path),createHash('sha256').update(readFileSync(path)).digest('hex')])),baselineSourceSha256:createHash('sha256').update(baselineSource).digest('hex')};
function profile(bytes,expected) {
  const samples=[];
  for(let iteration=0;iteration<6;iteration++) {
    const times={};
    for(const name of iteration%2?['candidate','baseline']:['baseline','candidate']) {
      const started=performance.now();
      const checksum=(name==='baseline'?bytewise:crc32)(bytes);
      times[name]=performance.now()-started;assert.equal(checksum,expected);
    }
    if(iteration)samples.push(times);
  }
  return samples;
}
const server=createServer((request,response)=>{
  const match=/^\/fixture\/(\d+)$/.exec(request.url??'');
  if(match&&fixtures[Number(match[1])]) {const {bytes}=fixtures[Number(match[1])];response.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':bytes.length}).end(bytes);return;}
  if(request.url==='/') {response.writeHead(200,{'Content-Type':'text/html'}).end('<!doctype html><title>CRC phase profile</title>');return;}
  if(request.url==='/worker.js') {response.writeHead(200,{'Content-Type':'text/javascript'}).end(`import {crc32 as bytewise} from './baseline.js';import {crc32} from './candidate.js';self.onmessage=({data})=>{const samples=[];for(let iteration=0;iteration<6;iteration++){const times={};for(const name of iteration%2?['candidate','baseline']:['baseline','candidate']){const started=performance.now();const checksum=(name==='baseline'?bytewise:crc32)(data.bytes);times[name]=performance.now()-started;if(checksum!==data.expected)throw new Error('CRC differs');}if(iteration)samples.push(times);}self.postMessage(samples);};`);return;}
  if(request.url==='/baseline.js') {response.writeHead(200,{'Content-Type':'text/javascript'}).end(baselineSource);return;}
  if(request.url==='/candidate.js') {response.writeHead(200,{'Content-Type':'text/javascript'}).end(readFileSync(candidatePath));return;}
  response.writeHead(404).end();
});
let browser;
const started=new Date().toISOString();
try {
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const node=fixtures.map(({bytes,identity})=>({identity,samples:profile(bytes,identity.checksum)}));
  browser=await chromium.launch({headless:true});const page=await browser.newPage();await page.goto('http://127.0.0.1:'+server.address().port);
  const worker=[];
  for(const [index,{identity}] of fixtures.entries()) {
    const samples=await page.evaluate(async ({index,expected})=>{
      const response=await fetch('/fixture/'+index);if(!response.ok)throw new Error('Missing CRC fixture');
      const buffer=new Uint8Array(await response.arrayBuffer());
      return new Promise((resolve,reject)=>{
      const worker=new Worker('/worker.js',{type:'module'});const timer=setTimeout(()=>{worker.terminate();reject(new Error('CRC profile timed out'));},30000);
      worker.onerror=event=>{clearTimeout(timer);worker.terminate();reject(new Error(event.message));};
      worker.onmessage=event=>{clearTimeout(timer);worker.terminate();resolve(event.data);};
      worker.postMessage({bytes:buffer,expected},[buffer.buffer]);
      });
    },{index,expected:identity.checksum});
    worker.push({identity,samples});
  }
  console.log(JSON.stringify({started,finished:new Date().toISOString(),cpu:cpus()[0]?.model,platform:platform(),arch:arch(),sources,nodeVersion:process.version,userAgent:await page.evaluate(()=>navigator.userAgent),warmups:1,iterations:5,alternatingOrder:true,node,worker},null,2));
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
