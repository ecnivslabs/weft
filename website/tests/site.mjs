import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { createStaticServer } from '../scripts/static-server.mjs';

const directory = resolve(import.meta.dirname, '../dist');
assert.ok(existsSync(directory), 'Build the static site before testing.');
assert.equal(readFileSync(join(directory, 'CNAME'), 'utf8').trim(), 'weft.ecnivs.com');
const files = readdirSync(directory, { recursive: true }).filter(name => statSync(join(directory, name)).isFile());
assert.equal(files.some(name => /\.(mp4|mkv|mov|avi|webm|m4v|nut|sci|wasm)$/i.test(name)), false);
assert.equal(files.includes('player.html'), false);
const hero = JSON.parse(readFileSync(new URL('../media/hero.json', import.meta.url)));
assert.equal(createHash('sha256').update(readFileSync(join(directory, 'assets/hero-knot.png'))).digest('hex'), hero.imageSha256);
const fidelity = JSON.parse(readFileSync(new URL('../../docs/assets/fidelity.json', import.meta.url)));
const bytes = readFileSync(join(directory, 'assets/weft-preview.webp'));
assert.equal(createHash('sha256').update(bytes).digest('hex'), fidelity.assets['weft-preview.webp'].sha256);
assert.equal(files.includes('preview.json'), false, 'Preview metadata stays in the build inputs.');
assert.equal(files.includes('ASSETS.md'), false, 'Asset notices have one hosted documentation page.');

const server = createStaticServer(directory);
let browser;
try {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => requests.push(request.url()));
  await page.goto(base);
  await page.waitForFunction(() => [...document.querySelectorAll('[data-choice]')].every(choice => !choice.disabled));
  assert.equal(await page.title(), 'Weft');
  assert.equal(await page.locator('header .wordmark').textContent(), 'Weft');
  assert.equal(await page.locator('h1').evaluate(element => getComputedStyle(element).textTransform), 'uppercase');
  assert.equal(await page.locator('h1').evaluate(element => getComputedStyle(element).paintOrder), 'stroke');
  assert.equal(await page.locator('video,#player,[data-preview-button],[data-comparison] canvas').count(), 0);
  await page.locator('[data-glyph-art][data-ready]').waitFor();
  await page.waitForFunction(() => document.querySelector('[data-glyph-art]').dataset.view === 'ascii');
  const heroBefore = await page.locator('.hero-art canvas').screenshot();
  let heroMoved = false;
  for (let attempt = 0; attempt < 12 && !heroMoved; attempt++) {
    await page.waitForTimeout(350);
    heroMoved = Buffer.compare(heroBefore, await page.locator('.hero-art canvas').screenshot()) !== 0;
  }
  assert.equal(heroMoved, true, 'Hero must refine visible text into the same detailed shape.');
  await page.waitForFunction(() => document.querySelector('[data-glyph-art]').dataset.view === 'weft');
  const heroPixels = await page.locator('.hero-art').evaluate(artwork => {
    const canvas = artwork.querySelector('canvas');
    const reference = document.createElement('canvas');
    reference.width = canvas.width;
    reference.height = canvas.height;
    const context = reference.getContext('2d');
    context.drawImage(artwork.querySelector('img'), 0, 0, canvas.width, canvas.height);
    const expected = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const actual = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    return actual.every((value, index) => value === expected[index]);
  });
  assert.equal(heroPixels, true, 'The detailed endpoint must be actual decoded SCI pixels.');
  assert.notDeepEqual(heroBefore, await page.locator('.hero-art canvas').screenshot(), 'Readable ASCII and detailed output must look different.');
  await page.waitForFunction(() => document.querySelector('[data-glyph-art]').dataset.view === 'ascii', null, { timeout: 8000 });
  assert.deepEqual(heroBefore, await page.locator('.hero-art canvas').screenshot(), 'The animation must return to the same readable ASCII artwork.');
  assert.equal(await page.locator('h1,h2,h3').evaluateAll(headings => headings.some(heading => heading.textContent.trim().endsWith('.'))), false);
  const comparison = page.locator('[data-comparison]');
  const choices = comparison.locator('[data-choice]');
  assert.equal(await choices.count(), 2);
  assert.deepEqual(await comparison.locator('[data-label]').allTextContents(), ['Clip A', 'Clip B']);
  for (const choice of await choices.all()) {
    const clip = await choice.getAttribute('data-clip');
    assert.equal(new URL(await choice.locator('img').getAttribute('src'), base).pathname, `/assets/${clip}-preview.webp`);
  }
  await comparison.scrollIntoViewIfNeeded();
  const first = await choices.first().locator('img').screenshot();
  await page.waitForTimeout(600);
  const second = await choices.first().locator('img').screenshot();
  assert.notEqual(createHash('sha256').update(first).digest('hex'), createHash('sha256').update(second).digest('hex'), 'Preview must animate without interaction.');
  await comparison.locator('[data-clip="weft"]').click();
  assert.match(await comparison.locator('[role="status"]').textContent(), /^Correct/);
  assert.equal(await comparison.locator('[data-result="correct"]').count(), 1);
  assert.deepEqual((await comparison.locator('[data-label]').allTextContents()).sort(), ['Source', 'Weft']);
  assert.equal(await comparison.locator('button:disabled').count(), 2);
  assert.equal(await comparison.locator('[data-picked]:visible').count(), 1);
  const revealed = await comparison.locator('[role="status"]').textContent();
  const selectedSources = await choices.locator('img').evaluateAll(images => images.map(image => image.src));
  await page.waitForTimeout(5500);
  await page.evaluate(() => { dispatchEvent(new Event('online')); dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); });
  assert.equal(await comparison.locator('[role="status"]').textContent(), revealed, 'Selection persists beyond the old reset and browser restore.');
  assert.deepEqual(await choices.locator('img').evaluateAll(images => images.map(image => image.src)), selectedSources);
  await page.reload();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-choice]')].every(choice => !choice.disabled));
  assert.deepEqual(await comparison.locator('[data-label]').allTextContents(), ['Clip A', 'Clip B']);
  await comparison.locator('[data-clip="source"]').click();
  assert.match(await comparison.locator('[role="status"]').textContent(), /^Incorrect/);
  assert.equal(await comparison.locator('[data-result="incorrect"]').count(), 1);
  assert.equal(await comparison.getAttribute('data-result'), 'incorrect');
  await page.reload();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-choice]')].every(choice => !choice.disabled));
  assert.equal(await page.locator('main').innerText().then(text => /prerender|reconstruction|ecnivs labs|media credits|Winter Drive/i.test(text)), false);
  for (const clip of ['source', 'weft']) assert.ok(requests.some(url => new URL(url).pathname.endsWith(`/assets/${clip}-preview.webp`)), 'Both animations must load automatically.');
  const screenshots = process.env.SCREENSHOT_DIR;
  if (screenshots) mkdirSync(screenshots, { recursive: true });
  for (const [name, width, height] of [['desktop',1440,900],['tablet',768,1024],['mobile',390,844],['small-mobile',320,740]]) {
    await page.setViewportSize({ width, height });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${name} must not overflow.`);
    if (screenshots) await page.screenshot({ path: join(screenshots, `site-${name}.png`), fullPage: true });
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior), 'auto');
  assert.deepEqual(errors, []);
  assert.equal(requests.some(url => /\.(sci|wasm|mp4|webm|mkv)(\?|$)|\/api\//.test(url)), false);

  await page.goto(`${base}/docs/`);
  assert.match(await page.locator('article h1').textContent(), /Introduction/);
  assert.equal(await page.locator('.docs-sidebar a[aria-current="page"]').count(), 1);
  const visited = new Set();
  for (const link of await page.locator('.docs-sidebar a').evaluateAll(links => links.map(link => link.getAttribute('href')))) {
    await page.goto(base + link);
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.locator('article h1').count(), 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Documentation must fit the viewport: ${link}`);
    for (const href of await page.locator('article a').evaluateAll(links => links.map(link => link.getAttribute('href')).filter(href => href.startsWith('/docs/')))) {
      if (visited.has(href)) continue;
      visited.add(href);
      assert.equal((await fetch(base + href)).status, 200, `Documentation link must resolve: ${href}`);
    }
    for (const href of await page.locator('.docs-outline a').evaluateAll(links => links.map(link => link.getAttribute('href')))) assert.equal(await page.locator(href).count(), 1);
  }
  for (const [name,width,height] of [['desktop',1440,900],['mobile',390,844],['small-mobile',320,740]]) {
    await page.setViewportSize({width,height});
    await page.goto(`${base}/docs/sci/`);
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${name} documentation must not overflow.`);
    if (width < 760) {
      await page.locator('.docs-menu summary').click();
      await page.locator('.docs-menu a[href="/docs/encoding/"]').click();
      assert.equal(new URL(page.url()).pathname, '/docs/encoding/');
      assert.ok(await page.locator('article pre').count() > 0);
    }
    if (screenshots) await page.screenshot({path:join(screenshots,`docs-${name}.png`),fullPage:true});
  }
  const cached = await browser.newPage();
  await cached.addInitScript(() => { HTMLImageElement.prototype.decode = () => Promise.reject(new DOMException('Decode unavailable', 'EncodingError')); });
  await cached.goto(base);
  await cached.waitForFunction(() => [...document.querySelectorAll('[data-choice]')].every(choice => !choice.disabled));
  await cached.locator('[data-clip="weft"]').click();
  assert.match(await cached.locator('[role="status"]').textContent(), /^Correct/);

  const reduced = await browser.newPage({ reducedMotion: 'reduce' });
  const reducedRequests = [];
  reduced.on('request', request => reducedRequests.push(request.url()));
  await reduced.goto(base);
  await reduced.waitForFunction(() => [...document.querySelectorAll('[data-choice]')].every(choice => !choice.disabled));
  assert.equal(reducedRequests.some(url => new URL(url).pathname.endsWith('.webp')), false, 'Reduced motion must use still images.');
  assert.equal(await reduced.locator('[data-choice] img').evaluateAll(images => images.every(image => new URL(image.currentSrc).pathname.endsWith('.png'))), true);
  await reduced.locator('[data-glyph-art][data-ready]').waitFor();
  const stillHero = await reduced.locator('.hero-art canvas').screenshot();
  await reduced.waitForTimeout(600);
  assert.equal(Buffer.compare(stillHero, await reduced.locator('.hero-art canvas').screenshot()), 0, 'Reduced motion keeps the glyph artwork still.');
  await reduced.locator('[data-clip="weft"]').click();
  assert.match(await reduced.locator('[role="status"]').textContent(), /^Correct/);

  const failure = await browser.newPage();
  let unavailable = true;
  await failure.route('**/assets/weft-preview.webp*', route => unavailable ? route.fulfill({ status: 503, body: 'Unavailable' }) : route.continue());
  await failure.goto(base);
  await failure.waitForFunction(() => document.querySelector('[data-comparison] [role="status"]').textContent.includes('Couldn’t load'));
  assert.equal(await failure.locator('[data-choice]:disabled').count(), 2);
  unavailable = false;
  await failure.waitForFunction(() => [...document.querySelectorAll('[data-choice]')].every(choice => !choice.disabled));
  await failure.locator('[data-clip="weft"]').click();
  assert.match(await failure.locator('[role="status"]').textContent(), /^Correct/);

  const fallback = await browser.newPage({ viewport: { width: 320, height: 740 } });
  await fallback.route('**/*.woff2', route => route.abort());
  for (const path of ['/', '/docs/sci/', '/docs/contributing/']) {
    await fallback.goto(base + path);
    await fallback.evaluate(() => document.fonts.ready);
    assert.equal(await fallback.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Fallback fonts must fit the viewport: ${path}`);
  }

  const embedded = await browser.newPage();
  await embedded.route(`${base}/**`, async route => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), 'access-control-allow-origin': '*' } });
  });
  const embeddedErrors = [];
  embedded.on('pageerror', error => embeddedErrors.push(error.message));
  await embedded.setContent(`<iframe src="${base}" sandbox="allow-scripts" width="1440" height="900"></iframe>`);
  await embedded.frameLocator('iframe').locator('[data-glyph-art][data-ready]').waitFor();
  assert.deepEqual(embeddedErrors, [], 'The hero must work inside the ecnivs card with an opaque sandbox origin.');
  await embedded.close();

  const plain = await browser.newPage({ javaScriptEnabled: false });
  await plain.goto(base);
  assert.match(await plain.locator('noscript').textContent(), /source is on the left/);
  assert.equal(await plain.locator('.hero-art img').isVisible(), true);
  assert.equal(await plain.locator('picture img').evaluateAll(images => images.every(image => image.complete && image.naturalWidth === 400)), true);
  console.log('Static site passed: automatic WebP motion, honest randomized comparisons, both guess outcomes, persistent selection, glyph animation, image failure recovery, no-script fallback, documentation links, reduced motion and responsive layouts.');
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
