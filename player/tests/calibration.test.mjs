import test from 'node:test';
import assert from 'node:assert/strict';
import { RendererPolicy, rendererOptions } from '../web/calibration.js';

const packet = { sourceFrame: 7, time: 1 };
function frame(policy, workerId, cost, workload = 'full') {
  const renderDecision = policy.request(packet, 3, 4, 28);
  return { renderDecision, workerId, renderer: renderDecision.gpu ? 'webgl2' : 'canvas2d', renderWorkload: workload,
    timing: { decoderMilliseconds: 1, reconstructionMilliseconds: cost - 1, initializationMilliseconds: 0 }, deliveryMilliseconds: 0 };
}
function epoch(policy, cost, position, workload = 'full') {
  const current = policy.epoch;
  for (let index = 0; index < 30 && current === policy.epoch; index++) policy.observe(frame(policy, index % policy.workers, cost, workload), position, 0, true);
  assert.notEqual(policy.epoch, current);
}

test('automatic rendering is explicit and fixed boolean policies remain fixed', () => {
  assert.deepEqual(rendererOptions(), { gpu: true, automaticRenderer: false });
  assert.deepEqual(rendererOptions({ gpu: false }), { gpu: false, automaticRenderer: false });
  assert.deepEqual(rendererOptions({ renderer: 'auto' }), { gpu: false, automaticRenderer: true });
  for (const options of [{ gpu: 'false' }, { renderer: 'gpu' }, { renderer: 'auto', gpu: true }]) assert.throws(() => rendererOptions(options), /renderer policy/);
  const policy = new RendererPolicy(4);
  assert.equal(policy.request(packet, 3, 4, 28).gpu, false);
  assert.equal(policy.epoch, -1);
  assert.throws(() => policy.request({ sourceFrame: -1 }, 3, 4, 28), /ordinal/);
});

test('two balanced pooled workload wins are required before GPU settles', () => {
  const policy = new RendererPolicy(4); policy.activate(0);
  epoch(policy, 10, 1); assert.equal(policy.mode, 'gpu'); assert.equal(policy.settled, false);
  epoch(policy, 4, 2); assert.equal(policy.mode, 'cpu'); assert.equal(policy.wins, 1);
  epoch(policy, 10, 3); assert.equal(policy.mode, 'gpu');
  epoch(policy, 4, 4); assert.equal(policy.mode, 'gpu'); assert.equal(policy.settled, true);
  assert.equal(policy.metrics.warmups, 16); assert.equal(policy.metrics.epochs.length, 4);
  for (let index = 0; index < 100; index++) policy.observe(frame(policy, index % 4, 4), 4.5, 0, true);
  assert.equal(policy.mode, 'gpu'); assert.ok(policy.records.get('full').length <= policy.limit);
  for (let index = 0; index < 30 && policy.mode === 'gpu'; index++) policy.observe(frame(policy, index % 4, 20), 10, 0, true);
  assert.equal(policy.mode, 'cpu'); assert.equal(policy.metrics.fallbacks, 1);
});

test('unmatched content and incomplete worker coverage cannot select GPU', () => {
  const policy = new RendererPolicy(2); policy.activate(0);
  epoch(policy, 10, 1, 'full'); epoch(policy, 1, 2, 'same');
  assert.equal(policy.mode, 'cpu'); assert.equal(policy.settled, true);
  const single = new RendererPolicy(4); single.activate(0);
  for (let index = 0; index < single.limit && !single.settled; index++) single.observe(frame(single, 0, 10), 1, 0, true);
  assert.equal(single.mode, 'cpu'); assert.equal(single.settled, true);
});

test('a long dependency chain does not end pooled calibration before another worker arrives', () => {
  const policy = new RendererPolicy(4); policy.activate(0);
  for (let index = 0; index <= policy.minimum; index++) policy.observe(frame(policy, 0, 10), .5, 0, true);
  assert.equal(policy.samples, policy.minimum);
  assert.equal(policy.settled, false);
  assert.equal(policy.mode, 'cpu');
  policy.observe(frame(policy, 1, 10), 1, 0, true);
  policy.observe(frame(policy, 0, 10), 1, 0, true);
  assert.equal(policy.mode, 'gpu');
  assert.equal(policy.metrics.epochs.length, 2);
});

test('stale epochs and invalid timestamps never train a false zero-cost result', () => {
  const policy = new RendererPolicy(1); policy.activate(0);
  const stale = frame(policy, 0, 10); epoch(policy, 10, 1);
  policy.observe(stale, 2, 0, true); assert.equal(policy.metrics.staleSamples, 1);
  const invalid = frame(policy, 0, 1); invalid.deliveryMilliseconds = -1;
  policy.observe(invalid, 2, 0, true); assert.equal(policy.metrics.invalidSamples, 1); assert.equal(policy.samples, 0);
  invalid.deliveryMilliseconds = NaN; policy.observe(invalid, 2, 0, true);
  assert.equal(policy.samples, 0);
  for (let index = 0; index < 200; index++) policy.request(packet, 3, 4, 28, false);
  assert.equal(policy.mode, 'gpu');
  for (let index = 0; index < policy.limit * 4 + 1; index++) policy.request(packet, 3, 4, 28);
  assert.equal(policy.mode, 'cpu'); assert.equal(policy.settled, true);
});

test('GPU failures release resources, with bounded timed retries', () => {
  const policy = new RendererPolicy(1); policy.activate(0); epoch(policy, 10, 1);
  const failed = frame(policy, 0, 10); failed.renderer = 'canvas2d'; failed.gpuFailure = 'Lost context';
  policy.observe(failed, 2, 0, true);
  assert.equal(policy.request(packet, 3, 4, 28).releaseGpu, true); assert.equal(policy.metrics.failures, 1);
  for (let retry = 0; retry < 2; retry++) {
    epoch(policy, 10, 13 + retry * 12);
    assert.equal(policy.mode, 'gpu');
    const failed = frame(policy, 0, 10); failed.renderer = 'canvas2d';
    policy.observe(failed, 14 + retry * 12, 0, true);
    assert.equal(policy.mode, 'cpu');
  }
  for (let index = 0; index < 100; index++) policy.observe(frame(policy, 0, 10), 100, 0, true);
  assert.equal(policy.mode, 'cpu'); assert.equal(policy.retries, 2);
});
