# Contributing to Weft

Weft is a Rust ASCII video codec from ecnivs. Contributions can improve glyph fitting, archive delivery, source ingestion, browser playback or documentation. Support changes with agreement tests and measurements appropriate to the claim.

## Before changing code

Read [the introduction](docs/introduction.md), [architecture](docs/architecture.md), and [SCI](formats/SCI.md). Check the affected callers and tests before choosing a design.

The core crate must stay independent of FFmpeg, HTTP, catalog storage and browser assets. Source ingestion belongs in `weft-media`; application behavior belongs in `player/server`. Removed experiments and their measurements remain available in repository history. New research must establish correctness and cost before entering production.

Visual packets must describe ASCII symbols and their attributes. A conventional video stream, source pixel payload or playback fallback does not meet the project design.

## Development setup

Use Rust 1.89 or newer and Node.js 22 or newer. Install FFmpeg with libopus, FFprobe, and the browser build target:

```sh
rustup target add wasm32-unknown-unknown
npm ci --prefix player
npx --prefix player playwright install chromium
cargo build --workspace --release --locked
npm run build --prefix player
```

The reusable codec does not need Node.js or media tools. Those dependencies support ingestion and browser validation.

## Code and format changes

Match the surrounding Rust or JavaScript conventions. Keep modules focused, propagate errors at the right boundary, and write comments only for constraints or reasoning the code does not explain.

When changing encoding, define the format rules before optimizing the implementation. Test encoder and decoder agreement, malformed input, independent seeks and compatibility. Use a new codec or font identifier when old readers cannot interpret the new representation. Earlier readers must reject unsupported profiles explicitly.

`crates/weft/src/glyphs.json` is the normative font. `npm run build --prefix player` copies it into the browser assets alongside the WebAssembly decoder. Edit the normative font and rebuild; tests require exact agreement. Browser reconstruction must match Rust output pixel for pixel, including the WebGL2 path and CPU recovery.

Do not commit source footage, private catalogs, retained library archives or build output. The licensed `player/web/sample.sci`, sample posters and WebP previews are intentional public assets. Preserve applicable media licenses and update the recorded hashes when replacing them. The current CC0 comparison images require no attribution; the film soundtrack is excluded. Keep one canonical set in `docs/assets/`, with source and license evidence in `shared/media/sample.json`.

## Verification

Run the checks relevant to the change, then the affected integration suites:

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
cargo build --workspace --release --locked
npm run build --prefix player
npm test --prefix player
npm run test:ingestion --prefix player
npm run test:native --prefix player
npm run test:e2e --prefix player
npm ci --prefix website
npm run build --prefix website
npm test --prefix website
```

CI runs Rust checks on Linux, macOS and Windows and checks the minimum Rust version separately. Avoid platform-specific paths and shell assumptions. Browser changes need desktop and phone checks, controls, seeking, audio, failure handling and cached playback. The static site suite checks preview playback, comparison guesses and persistent results, docs navigation and responsive layouts. SCI playback is verified separately by the native player and end-to-end suites.

## Performance work

Run one benchmark at a time, without other preparation jobs. Keep source frames, timing, resolution, audio and quality comparable. Record warm-ups, individual measurements, host details and limitations. Include total delivered bytes, startup, seeking, buffering and resource cost when the claim concerns streaming.

[Benchmarking](docs/benchmarking.md) describes the existing runners. A lower median in a short decoder test is not evidence of uninterrupted playback. A PSNR match is not proof of equal perceived quality. Report regressions and failed targets alongside improvements.

## Pull requests

Open against `master`. Explain the problem, resulting behavior and validation. Include before and after measurements for performance changes and update documentation when behavior changes. Keep unrelated cleanup separate.

Commit subjects should be short, imperative and specific. Existing history uses ordinary descriptions; a type prefix is optional. Do not add creator attribution to project artifacts.

Report ordinary bugs through [GitHub issues](https://github.com/ecnivslabs/weft/issues). For vulnerabilities, use [private reporting](https://github.com/ecnivslabs/weft/security/advisories/new) if enabled, or contact the maintainer through [ecnivs](https://ecnivs.com) before sharing sensitive details publicly.

The [software license](LICENSE) restricts commercial use. Contributions do not automatically assign copyright or grant rights held by third parties.
