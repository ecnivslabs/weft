# Benchmarking

Performance claims need comparable inputs and controlled runs. Use release builds, run one benchmark at a time, and pause other encoding or rendering jobs. Record host, tool versions, source hashes, warm-ups, individual runs and any uncontrolled conditions.

## Build once

```sh
cargo build --workspace --release --locked
rustup target add wasm32-unknown-unknown
npm run build --prefix player
npm ci --prefix player
npx --prefix player playwright install chromium
```

## Fidelity and archive size

```sh
node player/tests/benchmark.mjs SOURCE START_SECONDS DURATION_SECONDS HEIGHT
node player/tests/fidelity.mjs SOURCE BASELINE.sci CURRENT.sci
```

The benchmark compares one-layer and default four-layer fitting within the same supported codec. It stages a lossless ingestion fixture, checks matching timelines and dimensions, measures alternating encodes and reconstructs output through the production WASM decoder. Reports include RGB error, PSNR, total archive size, audio and timing costs. SSIM and VMAF depend on the installed FFmpeg filters.

Keep source timing, dimensions, duration, audio and quality equivalent. Count audio, metadata, index and delivery overhead. Conventional codecs belong in an explicit comparison baseline, never inside SCI or in the player's visual path. Matching RGB error is a diagnostic proxy, not proof of equal perceived quality.

High-resolution fixtures must be short enough for the runner's 128 MiB RGB reference bound. Use longer unique excerpts for whole-playback claims; repeating a short clip does not establish broader content coverage.

## H.266 in MP4

```sh
VVC_FFMPEG=/path/to/vvc-enabled-ffmpeg node player/tests/vvc-benchmark.mjs SOURCE ARCHIVE.sci 1080 NEW_OUTPUT.mp4
node --test player/tests/vvc-metrics.test.mjs
```

This external comparison needs an FFmpeg build with `libvvenc` for encoding and a system FFmpeg with VVC decoding, MP4 muxing and Opus support. The executable is selected by `VVC_FFMPEG`, or defaults to FFmpeg on PATH. Missing VVC support fails explicitly. No H.265 substitution is permitted. The optional output path must be new. It receives a genuine `vvc1` MP4 with synchronized Opus audio, never a renamed elementary stream or SCI playback fallback.

Use a retained original source and its matching SCI archive. The runner accepts constant-rate excerpts of at most ten seconds and 600 frames, with source video starting at PTS zero. It reads bounded SCI ranges and reconstructs the selected rendition with the production WASM decoder. Raw RGB references and reconstructions use temporary disk files, with two frame buffers for error measurement. Each SCI presentation event must match the declared cadence, including the final frame, within one microsecond. Variable-rate comparisons need a separate timestamp-preserving runner. VVenC 4:2:0 input requires even width; odd-width SCI renditions fail without changing dimensions.

VVC receives the exact original RGB reference, converted to ten-bit 4:2:0 with a declared BT.709 limited-range matrix. It does not encode the SCI reconstruction. The default preset is medium with eight threads and perceptual QP adaptation enabled. `VVENC_PRESET` and `VVENC_THREADS` permit explicit overrides. Closed IDR refresh uses a 16-frame GOP and the nearest positive multiple of 16 to one second. Actual keyframe times are recorded. SCI keeps its existing independent chunk boundaries, which can be shorter or longer; this is not an identical seek-structure experiment.

An integer QP search selects the closest tested RGB MSE and stops once the match is within 0.5 dB. If no match is found, the report preserves that failure. Both reconstructions receive the same YUV444 SSIM measurement. Matching MSE is only a diagnostic proxy, not equal perceived quality. VVenC's 4:2:0 conversion can impose a quality floor; that is a property of this encoder configuration, not every H.266 implementation.

Every MP4 must independently decode to the expected frame count, dimensions, cadence, presentation timestamps, durations and declared VVC pixel format. Audio uses the same source interval, stereo 48 kHz Opus at 96 kbit/s; SCI stores independent Ogg chunks while MP4 stores one continuous audio track. The report includes complete file bytes, selected SCI media body bytes, audio bytes, source and reconstruction hashes, executable hashes and all search trials. Requested SCI media bodies include actual metadata and the complete index, excluding padding and HTTP headers. Complete MP4 bytes include audio and container overhead.

Search encode times are single-run diagnostics. They are not a controlled encode-speed comparison. This runner does not measure browser support, startup, buffering, energy use or sustained playback. Use the playback runners for those questions. Benchmark tools remain external: do not vendor their source, binaries or license requirements into the product. VVenC's software license includes redistribution notices and expressly grants no patent rights; using it for this comparison does not establish product patent clearance.

## Encoder and decoder changes

```sh
node player/tests/encode-benchmark.mjs SHORT_SOURCE HEIGHT BEFORE_BINARY AFTER_BINARY
node player/tests/playback-benchmark.mjs ARCHIVE HEIGHT BEFORE_WASM AFTER_WASM
```

The encoder runner alternates three measured encodes after a warm-up and checks pixels and presentation times. The decoder runner alternates five measured passes after a warm-up and checks every reconstructed pixel hash.

The native `profile` example separates inflation, composition decoding and RGB rendering in one delivery chunk. It diagnoses costs; it is not a complete playback benchmark.

## Lossless packet packing

```sh
cargo build -p weft --example repack --release --locked
cargo run -p weft --example repack --release --locked -- INPUT.sci legacy.sci 4
cargo run -p weft --example repack --release --locked -- INPUT.sci compact.sci 5
cargo run -p weft --example repack --release --locked -- INPUT.sci color-fields.sci 6
node player/tests/packing-benchmark.mjs legacy.sci compact.sci HEIGHT BEFORE.wasm AFTER.wasm cells
node player/tests/packing-benchmark.mjs legacy.sci compact.sci HEIGHT BEFORE.wasm AFTER.wasm pixels
```

Repacking preserves the original fitted ASCII compositions, presentation durations, audio payloads and seek boundaries. It does not download or refit source media. Output paths must not exist. The example rejects output chunks over 16 MiB; it does not silently change seek boundaries. All versions use the same production level-3 compressor. Compare versions 5 and 6 to isolate reversible color-field packing from the earlier compact-field change. Its one-run wall time is diagnostic, not controlled encoder-performance evidence.

The packing runner reads bounded ranges, checks every chunk checksum, alternates one warm-up and five measured passes, and requires identical complete output and presentation hashes. It also checks exact audio bytes and synchronized boundaries. Results include all stored archive bytes and requested media body bytes, with audio, actual metadata and the complete index. Requested body bytes exclude HTTP headers and unrequested padding. The runner reports median decode cost, per-pass p95 frame cost and first-frame decoding; first-frame decoding excludes network and renderer setup and is not startup delay. Use the streaming runner for those costs and sustained playback.

For a large archive correctness audit, set `TEST_CORRECTNESS_ONLY=1` on the same packing command. It verifies one complete paired pass and reports output, timing, audio and byte counts, with `performanceComparison: false` and zero measured iterations. It emits no decoding-cost comparison and cannot establish a speed improvement.

Save the baseline WASM before rebuilding. Compare WASM inflation and browser playback before enabling a packing change by default. A candidate must reduce delivered bytes without more than five percent regression in median or p95 decoding on the declared corpus. Keep unchanged existing packets when they compress better. Corpus excerpts and failed gates must remain visible in the report.

## Browser and delivery

```sh
node player/tests/browser-playback-benchmark.mjs ARCHIVE 360 480 720 1080
TEST_RENDERERS=default TEST_REQUIRE_UNINTERRUPTED=1 node player/tests/streaming-benchmark.mjs ARCHIVE 360 480 720 1080
npm run test:native --prefix player
npm run test:e2e --prefix player
npm ci --prefix website
npm run build --prefix website
npm test --prefix website
```

The browser decoder comparison checks CPU and WebGL output hashes and completed graphics work. Its short decoder sample excludes network, audio scheduling and presentation, so it cannot pass a sustained streaming gate.

Streaming reports must include first-frame delay, cold seeking, total transferred bytes, buffering, audio synchronization, source events consumed and resource cost. Fix manual quality during a tier test. At 60 FPS and 2x speed the pipeline must consume 120 source events per wall-clock second; display refresh is a separate limit.

`TEST_PLAYBACK_RATE` selects a speed from 0.25 through 2; its default is 2. The streaming runner accepts `default`, `cpu`, `gpu` and `auto` renderer policies through `TEST_RENDERERS`. The default policy exercises the product default rather than forcing a renderer. `TEST_REQUIRE_UNINTERRUPTED=1` fails unless every trial reaches its requested source time with zero waiting events, zero sampled buffering time, complete contiguous source consumption and wall time within five percent plus 250 ms of the requested playback speed. The JSON report is emitted before a failed gate. Startup and play preparation remain separate measurements. A passed short excerpt is not evidence for every network, device or longer source.

Native player and end-to-end tests verify SCI playback. Public-site tests exercise image previews and documentation; they do not measure SCI streaming. Short sample tests do not establish maximum-speed performance for long videos, every resolution or mobile hardware.

## Evidence

[Research status](research.md) links the historical reports and states which targets remain unverified. Include failed comparisons and regressions. Do not present a single fast run, selected content or a changed quality setting as an efficiency win.
