import { spawnSync } from 'node:child_process';
import { copyFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const result = spawnSync('cargo', ['build', '-p', 'weft-wasm', '--target', 'wasm32-unknown-unknown', '--release', '--locked'], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const target = resolve(root, process.env.CARGO_TARGET_DIR ?? 'target');
copyFileSync(resolve(target, 'wasm32-unknown-unknown/release/weft_wasm.wasm'), resolve(root, 'website/web/decoder.wasm'));
copyFileSync(resolve(root, 'crates/weft/src/glyphs.json'), resolve(root, 'website/web/glyphs.json'));
