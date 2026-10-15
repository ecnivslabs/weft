import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { compareConventional } from './conventional.mjs';

const [source, startText = '0', durationText = '2', heightText = '360'] = process.argv.slice(2);
if (!source || !Number.isFinite(Number(startText)) || Number(startText) < 0 || !Number.isFinite(Number(durationText)) || Number(durationText) <= 0 || Number(durationText) > 10 || ![360,480,720,1080].includes(Number(heightText))) throw new Error('Usage: node player/tests/benchmark.mjs SOURCE [START_SECONDS] [DURATION_SECONDS] [HEIGHT]');
const root = resolve(import.meta.dirname, '../..');
const binary = join(root, 'target/release', process.platform === 'win32' ? 'weft.exe' : 'weft');
const temporary = mkdtempSync(join(tmpdir(), 'weft-benchmark-'));
function run(program, arguments_) {
  const result = spawnSync(program, arguments_, { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
try {
  const fixture = join(temporary, 'source.nut');
  run('ffmpeg', ['-nostdin', '-v', 'error', '-ss', startText, '-i', resolve(source), '-t', durationText, '-c:v', 'ffv1', '-c:a', 'pcm_s16le', fixture]);
  const times = [[], []];
  const outputs = [];
  for (let iteration = 0; iteration < 4; iteration++) {
    for (const profile of iteration % 2 ? [1, 0] : [0, 1]) {
      const destination = join(temporary, `${iteration}-${profile}.sci`);
      const started = performance.now();
      run(binary, ['encode', fixture, destination, '--heights', heightText, ...(profile === 0 ? ['--layers','1'] : [])]);
      const seconds = (performance.now() - started) / 1000;
      if (iteration > 0) times[profile].push(seconds);
      outputs[profile] = destination;
    }
  }
  const comparison = JSON.parse(run(process.execPath, [join(root, 'player/tests/fidelity.mjs'), fixture, ...outputs]));
  const metadata = JSON.parse(run(binary, ['inspect', outputs[1]]));
  const conventional = ['H.264','AV1'].map(codec => compareConventional(fixture, {...comparison.results[1], fpsNumerator:metadata.fpsNumerator, fpsDenominator:metadata.fpsDenominator}, comparison.results[1].mse, codec));
  console.log(JSON.stringify({ source: resolve(source), startSeconds: Number(startText), fixtureBytes: statSync(fixture).size,
    profiles: ['one foreground layer','default four layers'], warmups: 1, measuredIterations: 3, seconds: times,
    medianSeconds: times.map(values => values.toSorted((a,b)=>a-b)[1]), ...comparison, conventional }, null, 2));
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
