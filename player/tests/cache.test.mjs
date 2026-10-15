import test from 'node:test';
import assert from 'node:assert/strict';
import { SciReader } from '../web/sci.js';
import { CACHE_BYTES, REQUEST_BYTES } from '../web/delivery.js';

const settle = () => new Promise(resolve => setImmediate(resolve));

test('weighted request reservations include cancelled active work until it settles', async () => {
  const reader = new SciReader('/fixture', {});
  reader.records = new Map(Array.from({length: 6}, (_, chunk) => [`360:${chunk}`, { length: 16*1024*1024 }]));
  const active = new Map();
  reader.readEntry = entry => new Promise(resolve => active.set(entry.key, () => resolve([])));
  const promises = Array.from({length:6}, (_, chunk) => reader.load(360, chunk));
  assert.equal(reader.active.size, 3); assert.equal(reader.requestBytes, REQUEST_BYTES);
  assert.equal(reader.waiting.size, 3);
  reader.trim(3, 360, true, 5);
  assert.equal(reader.active.size, 3); assert.equal(reader.pending.size, 0);
  assert.equal(reader.requestBytes, REQUEST_BYTES);
  for (const finish of [...active.values()]) finish(); await settle();
  assert.equal(reader.pending.size, 3); assert.equal(reader.requestBytes, REQUEST_BYTES);
  for (const key of ['360:3','360:4','360:5']) active.get(key)();
  await Promise.all(promises); await settle();
  assert.equal(reader.requestBytes, 0); reader.close();
});

test('leased packet backing stores remain accounted while cache admission waits', async () => {
  const reader = new SciReader('/fixture', {});
  const entry = key => ({ key, controller: new AbortController() });
  const cost = 16 * 1024 * 1024;
  const slots = CACHE_BYTES / cost;
  const leases = [];
  for (let chunk=0;chunk<slots;chunk++) {
    await reader.publish(entry(`360:${chunk}`), [{chunk}], cost);
    leases.push(reader.retain(360, chunk));
  }
  reader.trim(slots, 360, false, slots);
  assert.equal(reader.cacheBytes, CACHE_BYTES); assert.equal(reader.cache.size, slots);
  let admitted = false;
  const pending = reader.publish(entry(`360:${slots}`), [{}], cost).then(() => {admitted=true;});
  await settle(); assert.equal(admitted,false);
  leases[0].release(); await pending;
  assert.equal(reader.cacheBytes,CACHE_BYTES); assert.equal(reader.cache.size,slots);
  assert.equal(reader.get(360,0),undefined);
  for (const lease of leases) lease.release();
  assert.equal(reader.cacheBytes,cost); assert.equal(reader.leases.size,0);
  reader.close(); assert.equal(reader.cacheBytes,0);
});

test('cancelling a waiting cache admission releases its waiter and never publishes stale data', async () => {
  const reader = new SciReader('/fixture', {});
  await reader.publish({key:'360:0',controller:new AbortController()}, [{}], CACHE_BYTES);
  const lease=reader.retain(360,0);
  const controller=new AbortController();
  const pending=reader.publish({key:'360:1',controller}, [{}], 1);
  assert.equal(reader.cacheWaiters.size,1); controller.abort();
  await assert.rejects(pending,{name:'AbortError'});
  assert.equal(reader.cacheWaiters.size,0); assert.equal(reader.cache.has('360:1'),false);
  lease.release();reader.close();
});
