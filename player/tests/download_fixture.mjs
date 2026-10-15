import assert from 'node:assert/strict';
import { appendFileSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const arguments_ = process.argv.slice(2);
appendFileSync(process.env.WEFT_TEST_DOWNLOAD_LOG, `${JSON.stringify(arguments_)}\n`);
const source = new URL(arguments_.at(-1));
assert.ok(['www.youtube.com', 'youtu.be'].includes(source.hostname));
const id = source.hostname === 'youtu.be' ? source.pathname.slice(1) : source.searchParams.get('v');
assert.ok(['abc_def-123', 'fail_fail12'].includes(id));
if (arguments_.includes('--dump-single-json')) {
  console.log(JSON.stringify({ id, title: 'Retained original', duration: 10 }));
} else {
  assert.ok(arguments_.includes('--no-playlist'));
  const template = arguments_[arguments_.indexOf('-o') + 1];
  const destination = template.replace('%(ext)s', 'mp4');
  mkdirSync(dirname(destination), { recursive: true });
  if (id === 'fail_fail12') {
    writeFileSync(destination, 'incomplete download');
    console.error('Fixture download failure.');
    process.exitCode = 1;
  } else {
    copyFileSync(process.env.WEFT_TEST_DOWNLOAD_SOURCE, destination);
  }
}
