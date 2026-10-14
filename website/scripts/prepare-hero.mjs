import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const work = join(root, 'videos/hero');
const width = 960, height = 720;
mkdirSync(work, { recursive: true });
const pixels = Buffer.alloc(width * height * 3);
const depth = new Float64Array(width * height).fill(Infinity);
for (let index = 0; index < pixels.length; index += 3) pixels.set([15, 13, 14], index);
const add = (a, b) => a.map((value, index) => value + b[index]);
const subtract = (a, b) => a.map((value, index) => value - b[index]);
const multiply = (a, factor) => a.map(value => value * factor);
const dot = (a, b) => a.reduce((sum, value, index) => sum + value * b[index], 0);
const normalize = a => multiply(a, 1 / Math.hypot(...a));
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const center = t => [(2 + Math.cos(3 * t)) * Math.cos(2 * t), (2 + Math.cos(3 * t)) * Math.sin(2 * t), Math.sin(3 * t)];
function rotate([x, y, z]) {
  const tilt = -0.62, turn = 0.34;
  const vertical = y * Math.cos(tilt) - z * Math.sin(tilt);
  const forward = y * Math.sin(tilt) + z * Math.cos(tilt);
  return [x * Math.cos(turn) + forward * Math.sin(turn), vertical, -x * Math.sin(turn) + forward * Math.cos(turn)];
}
const light = normalize([-0.5, 0.8, 1]);
const rim = normalize([0.8, -0.2, 0.4]);
function triangle(vertices) {
  const [a, b, c] = vertices;
  const area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  if (Math.abs(area) < 0.001) return;
  const minX = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x))), maxX = Math.min(width - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
  const minY = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y))), maxY = Math.min(height - 1, Math.ceil(Math.max(a.y, b.y, c.y)));
  for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
    const u = ((b.x - x) * (c.y - y) - (b.y - y) * (c.x - x)) / area;
    const v = ((c.x - x) * (a.y - y) - (c.y - y) * (a.x - x)) / area;
    const w = 1 - u - v;
    if (u < 0 || v < 0 || w < 0) continue;
    const distance = a.z * u + b.z * v + c.z * w, index = y * width + x;
    if (distance >= depth[index]) continue;
    depth[index] = distance;
    const normal = normalize(a.normal.map((value, axis) => value * u + b.normal[axis] * v + c.normal[axis] * w));
    const diffuse = Math.max(0, dot(normal, light));
    const edge = Math.max(0, dot(normal, rim));
    const highlight = Math.pow(Math.max(0, dot(normal, normalize(add(light, [0, 0, 1])))), 55);
    const broad = Math.pow(Math.max(0, dot(normal, normalize(add(rim, [0, 0, 1])))), 9);
    const rib = 0.94 + 0.06 * Math.cos((a.t * u + b.t * v + c.t * w) * 180);
    const base = [205, 145, 83];
    for (let channel = 0; channel < 3; channel++) pixels[index * 3 + channel] = Math.min(255, Math.round(base[channel] * (0.14 + 0.76 * diffuse + 0.22 * edge) * rib + [255, 244, 220][channel] * (0.85 * highlight + 0.35 * broad)));
  }
}
const segments = 720, sides = 64;
const mesh = Array.from({ length: segments + 1 }, (_, index) => {
  const t = index / segments * Math.PI * 2;
  const origin = center(t), tangent = normalize(subtract(center(t + 0.0001), center(t - 0.0001)));
  const normal = normalize(cross(tangent, [0, 0, 1])), binormal = cross(tangent, normal);
  return Array.from({ length: sides + 1 }, (_, side) => {
    const angle = side / sides * Math.PI * 2;
    const outward = add(multiply(normal, Math.cos(angle)), multiply(binormal, Math.sin(angle)));
    const [x, y, z] = rotate(add(origin, multiply(outward, 0.46)));
    return { x: width / 2 + x * 860 / (9 - z), y: height / 2 - y * 860 / (9 - z), z: 9 - z, normal: rotate(outward), t };
  });
});
for (let segment = 0; segment < segments; segment++) for (let side = 0; side < sides; side++) {
  triangle([mesh[segment][side], mesh[segment + 1][side], mesh[segment][side + 1]]);
  triangle([mesh[segment + 1][side], mesh[segment + 1][side + 1], mesh[segment][side + 1]]);
}
const stage = mkdtempSync(join(work, '.prepare-'));
try {
  writeFileSync(join(stage, 'source.ppm'), Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), pixels]));
  function command(executable, args) {
    const result = spawnSync(executable, args, { encoding: 'utf8' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr || `${executable} exited ${result.status}`);
  }
  command('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-framerate', '1', '-i', join(stage, 'source.ppm'), '-frames:v', '1', '-c:v', 'ffv1', join(stage, 'source.mkv')]);
  const cli = process.env.WEFT_CLI ?? join(root, 'target/release', process.platform === 'win32' ? 'weft.exe' : 'weft');
  command(cli, ['encode', join(stage, 'source.mkv'), join(stage, 'knot.sci'), '--heights', '720', '--fps', 'source', '--quality', '100', '--layers', '4', '--color-bits', '8', '--byte-penalty', '0']);
  command(cli, ['decode', join(stage, 'knot.sci'), '0', join(stage, 'decoded.ppm'), '--height', '720']);
  const image = join(stage, 'hero-knot.png');
  command('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', join(stage, 'decoded.ppm'), '-frames:v', '1', '-compression_level', '9', image]);
  const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
  for (const name of ['source.ppm', 'source.mkv', 'knot.sci']) copyFileSync(join(stage, name), join(work, name));
  copyFileSync(image, join(root, 'website/web/assets/hero-knot.png'));
  writeFileSync(join(root, 'website/media/hero.json'), JSON.stringify({
    recipe: 'website/scripts/prepare-hero.mjs', width, height,
    sourceSha256: hash(join(stage, 'source.ppm')),
    archiveSha256: hash(join(stage, 'knot.sci')),
    image: 'hero-knot.png', imageSha256: hash(image),
  }, null, 2) + '\n');
  console.log('Prepared the original knot through the Weft encoder and decoder.');
} finally {
  rmSync(stage, { recursive: true, force: true });
}
