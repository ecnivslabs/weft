# Benchmarking

Performance claims need comparable inputs and controlled runs. Use release builds, run one benchmark at a time, and pause other encoding or rendering jobs. Record host, tool versions, source hashes, warm-ups, individual runs and any uncontrolled conditions.

## Build once

```sh
cargo build --workspace --release --locked
rustup target add wasm32-unknown-unknown
npm run build:web --prefix website
npm ci --prefix website
npx --prefix website playwright install chromium
```

## Fidelity and archive size

```sh
node website/tests/benchmark.mjs SOURCE START_SECONDS DURATION_SECONDS HEIGHT
node website/tests/fidelity.mjs SOURCE BASELINE.sci CURRENT.sci
```

The benchmark compares one-layer and default four-layer fitting within the same supported codec. It stages a lossless ingestion fixture, checks matching timelines and dimensions, measures alternating encodes and reconstructs output through the production WASM decoder. Reports include RGB error, PSNR, total archive size, audio and timing costs. SSIM and VMAF depend on the installed FFmpeg filters.

Keep source timing, dimensions, duration, audio and quality equivalent. Count audio, metadata, index and delivery overhead. Conventional codecs belong in an explicit comparison baseline, never inside SCI or in the player's visual path. Matching RGB error is a diagnostic proxy, not proof of equal perceived quality.

High-resolution fixtures must be short enough for the runner's 128 MiB RGB reference bound. Use longer unique excerpts for whole-playback claims; repeating a short clip does not establish broader content coverage.

## Encoder and decoder changes

```sh
node website/tests/encode-benchmark.mjs SHORT_SOURCE HEIGHT BEFORE_BINARY AFTER_BINARY
node website/tests/playback-benchmark.mjs ARCHIVE HEIGHT BEFORE_WASM AFTER_WASM
```

The encoder runner alternates three measured encodes after a warm-up and checks pixels and presentation times. The decoder runner alternates five measured passes after a warm-up and checks every reconstructed pixel hash.

The native `profile` example separates inflation, composition decoding and RGB rendering in one delivery chunk. It diagnoses costs; it is not a complete playback benchmark.

## Browser and delivery

```sh
node website/tests/browser-playback-benchmark.mjs ARCHIVE 360 480 720 1080
node website/tests/streaming-benchmark.mjs ARCHIVE 360 480 720 1080
npm run test:native --prefix website
npm run test:e2e --prefix website
npm run test:site --prefix website
```

The browser decoder comparison checks CPU and WebGL output hashes and completed graphics work. Its short decoder sample excludes network, audio scheduling and presentation, so it cannot pass a sustained streaming gate.

Streaming reports must include first-frame delay, cold seeking, total transferred bytes, buffering, audio synchronization, source events consumed and resource cost. Fix manual quality during a tier test. At 60 FPS and 2x speed the pipeline must consume 120 source events per wall-clock second; display refresh is a separate limit.

Native player and end-to-end tests verify SCI playback. Public-site tests exercise image previews and documentation; they do not measure SCI streaming. Short sample tests do not establish maximum-speed performance for long videos, every resolution or mobile hardware.

## Evidence

[Research status](research.md) links the historical reports and states which targets remain unverified. Include failed comparisons and regressions. Do not present a single fast run, selected content or a changed quality setting as an efficiency win.
