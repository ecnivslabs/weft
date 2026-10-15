import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { buildDocs } from './build-docs.mjs';

const website = resolve(import.meta.dirname, '..');
const fidelity = JSON.parse(readFileSync(join(website, '../docs/assets/fidelity.json')));
const hero = JSON.parse(readFileSync(join(website, 'media/hero.json')));
const heroImage = readFileSync(join(website, 'web/assets/hero-knot.png'));
if (hero.image !== 'hero-knot.png' || hero.width !== 960 || hero.height !== 720 || createHash('sha256').update(heroImage).digest('hex') !== hero.imageSha256) throw new Error('Hero image does not match its SCI preparation.');
const files = [
  'index.html', 'site.css', 'docs.css', 'preview.js', 'hero.js', 'assets/hero-knot.png',
];
const sharedFiles = [
  'base.css', 'frame-theme.css', 'favicon.svg',
  ...['inter', 'space-grotesk', 'geist-mono'].flatMap(font => [`fonts/${font}-latin-wght-normal.woff2`, `fonts/${font}-LICENSE.txt`]),
];
const mediaFiles = ['weft-preview.webp', 'source-preview.webp', 'source-poster.png', 'weft-poster.png'];
for (const [name, expected] of Object.entries(fidelity.assets)) {
  const bytes = readFileSync(join(website, '../docs/assets', name));
  if (bytes.length !== expected.bytes || createHash('sha256').update(bytes).digest('hex') !== expected.sha256) throw new Error(`Preview asset mismatch: ${name}`);
}
if (fidelity.previewWidth !== 400 || fidelity.previewHeight !== 225 || fidelity.previewFps !== 24 || !Number.isInteger(fidelity.previewDurationMs) || fidelity.previewDurationMs < 1000 || fidelity.previewDurationMs > 10000 || ['source','weft'].some(name => fidelity.assets[`${name}-preview.webp`].bytes > 5 * 1024 * 1024)) throw new Error('Invalid prepared preview.');
const domain = readFileSync(join(website, 'CNAME'), 'utf8').trim();
if (domain !== 'weft.ecnivs.com') throw new Error('Unexpected website domain.');

const stage = mkdtempSync(join(website, '.site-build-'));
try {
  for (const file of [...files, ...sharedFiles]) {
    mkdirSync(dirname(join(stage, file)), { recursive: true });
    const source = sharedFiles.includes(file) ? join(website, '../shared/web', file) : join(website, 'web', file);
    cpSync(source, join(stage, file));
  }
  const assets = Object.fromEntries(['base.css','site.css','docs.css','preview.js','hero.js'].map(file => [file, `/${file}?v=${createHash('sha256').update(readFileSync(join(stage,file))).digest('hex').slice(0,12)}`]));
  mkdirSync(join(stage, 'assets'), { recursive: true });
  for (const name of mediaFiles) cpSync(join(website, '../docs/assets', name), join(stage, 'assets', name));
  cpSync(join(website, '../docs/assets/banner.png'), join(stage, 'assets/banner.png'));
  const bannerVersion = createHash('sha256').update(readFileSync(join(stage, 'assets/banner.png'))).digest('hex').slice(0,12);
  const previewVersion = createHash('sha256').update(JSON.stringify(fidelity.assets)).digest('hex').slice(0,12);
  const heroVersion = hero.imageSha256.slice(0,12);
  let html = readFileSync(join(stage,'index.html'),'utf8');
  for (const [file,url] of Object.entries(assets)) html = html.replaceAll(`"/${file}"`, `"${url}"`);
  const media = Object.fromEntries(['source','weft'].map(name => [name, { animation: `/assets/${name}-preview.webp?v=${previewVersion}`, poster: `/assets/${name}-poster.png?v=${previewVersion}` }]));
  for (const entry of Object.values(media)) for (const url of Object.values(entry)) html = html.replaceAll(`"${url.split('?')[0]}"`, `"${url}"`);
  html = html.replace('https://weft.ecnivs.com/assets/banner.png', `https://weft.ecnivs.com/assets/banner.png?v=${bannerVersion}`);
  html = html.replace('"/assets/hero-knot.png"', `"/assets/hero-knot.png?v=${heroVersion}"`);
  html = html.replace('data-media=""', `data-media='${JSON.stringify(media)}'`);
  writeFileSync(join(stage,'index.html'),html);
  const docCount = buildDocs(stage,assets);
  cpSync(join(website, 'CNAME'), join(stage, 'CNAME'));
  writeFileSync(join(stage, '.nojekyll'), '');
  const destination = join(website, 'dist');
  rmSync(destination, { recursive: true, force: true });
  renameSync(stage, destination);
  console.log(`Website built at ${destination}. ${docCount} documentation pages and animated WebP comparisons.`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
