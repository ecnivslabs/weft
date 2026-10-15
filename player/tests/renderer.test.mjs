import test from 'node:test';
import assert from 'node:assert/strict';
import { formatTime } from '../web/time.js';

test('time formatting handles hours and missing media metadata', () => {
  assert.equal(formatTime(3661.9), '1:01:01');
  assert.equal(formatTime(59.9), '0:59');
  assert.equal(formatTime(Infinity), '0:00');
  assert.equal(formatTime(NaN), '0:00');
});

import { PixelRenderer } from '../web/renderer.js';
test('renderer presents owned reconstruction and rejects legacy cell drawing',()=>{
 let drawn; const renderer=new PixelRenderer({width:0,height:0,getContext:()=>({createImageData:(w,h)=>({data:new Uint8ClampedArray(w*h*4)}),putImageData:image=>{drawn=image.data;}})});
 const pixels=new Uint8ClampedArray(3*4*4).fill(127);
 renderer.draw({width:3,height:4,pixels});assert.deepEqual(drawn,pixels);
 assert.throws(()=>renderer.draw({width:3,height:4,cells:new Uint8Array(7)}),/reconstructed/);
 assert.throws(()=>renderer.draw({width:3,height:4,pixels:new Uint8Array(3)}),/Invalid/);
});
