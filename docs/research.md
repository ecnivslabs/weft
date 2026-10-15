# Research status

Weft implements a custom ASCII visual codec, synchronized SCI archives and browser playback. Its goal remains faithful 1080p60 delivery with substantially lower bandwidth and resource cost than conventional video.

That goal is not met. Historical quality-matched comparisons favor the tested conventional codecs in size, preparation is expensive, and difficult detail remains visibly lossy. No completed blinded perception study or controlled hardware-decoder resource comparison establishes indistinguishable quality or lower CPU, memory or energy use.

## Current default

The production profile is `sci-ascii-scene-v1`, with adaptive layered glyph fitting and eight-bit RGB attributes. It preserves source timing up to 60 FPS and supports 360p, 480p, 720p and 1080p renditions.

Experimental scene versions and temporal fitting were removed from production. They did not establish the efficiency goal. The current encoder and decoder support one visual representation.

Bounded delivery, independent seeking, persistent cache reuse and Rust/browser agreement are implemented and tested. Uninterrupted 2x playback has not been achieved at every tier; the latest mixed-detail trials still fail that target. Short tests and median decoder timings cannot establish that target.

## Compact field packing measurements

Version 5 adds independent and temporal streams containing composition origins and active attributes. The glyph font, scene-v1 representation, fitted cells, eight-bit RGB values and presentation timing are unchanged. Existing command and plane packets remain candidates. Version 4 archives stay readable and reusable.

The [raw packing report](measurements/compact-fields.json) contains source hashes, decoder module hashes, host information, all measured runs, exact output and audio hashes, and an initial failed comparison. Reproduction uses the [packing benchmark](benchmarking.md#lossless-packet-packing).

Four complete 1080p archives were repacked with the same production level-3 compressor. Cartoon contains 96 events over 4.004 seconds; fossils contains 96 events over four seconds; weave contains 240 events over four seconds; detail contains 120 events over two seconds. A separate all-tier sample contains only the first three shared chunks of a retained source, 15 events over 0.25 seconds at each tier. This small sample checks tier coverage, not sustained performance.

Each case alternates a warm-up and five measured passes for both cell output and CPU pixel output. Every decoded ASCII byte, rendered pixel and presentation duration matched its baseline. Encoded audio and synchronized seek boundaries also matched exactly. Negative decode changes mean lower cost.

| Case | Requested media bodies | Median cell decoding | p95 cell decoding |
| :--- | ---: | ---: | ---: |
| all-tiers, 1080p | 9.05% smaller | -24.42% | -47.79% |
| all-tiers, 360p | 4.53% smaller | +2.98% | -24.91% |
| all-tiers, 480p | 5.20% smaller | -1.87% | -32.58% |
| all-tiers, 720p | 6.76% smaller | -8.52% | -42.30% |
| cartoon, 1080p | 5.05% smaller | -4.07% | -30.35% |
| detail, 1080p | 18.16% smaller | -22.48% | -29.37% |
| fossils, 1080p | 14.50% smaller | -4.33% | -17.23% |
| weave, 1080p | 13.04% smaller | -21.30% | -20.33% |

Requested media bodies include audio, header, actual metadata and the complete seek index. They exclude HTTP headers, decoder assets and unrequested padding. Whole archive size and these body sizes are both retained in the raw report. Complete 1080p archive savings range from 5.05 to 18.16 percent. The separate short tier checks save 4.53 through 9.05 percent of media bodies. The largest median regression across both output modes is 2.98 percent, within the five percent gate; p95 decoding improves in every measured case.

The first field decoder failed the gate: fossils saved bytes but increased median cell decoding by 42.7 percent. Profiling identified composition decoding as the regression. Gathering fields into one composition at a time, specializing prediction modes, and avoiding a duplicate raster validation resolved it. Geometry coverage, overlap, bounds, symbols and reflections still validate before output. Followers are constructed from validated origins. Malformed-stream mutation and truncation tests check agreement with the full frame validator, including release builds.

The [browser report](measurements/compact-fields-browser.json) verifies exact CPU and WebGL output for 12 complex 1080p events using both WASM and browser-native inflation. The full native-player correctness test also covers version 5 playback, all four tiers, seeking, deferred events, error recovery and renderer changes. Compact dependency chains exposed premature automatic-renderer calibration; the player now waits within its existing bounded observation window for samples from another worker.

Three loopback streaming trials requested four seconds of the cartoon excerpt at 1080p and 2x. Chromium used SwiftShader software WebGL. Median startup was 422.9 ms, but median buffering was 8.64 seconds. The largest reserved presentation buffer was 33177600 bytes, below 32 MiB. These trials reached the requested source frontier but **failed uninterrupted maximum-speed playback**. They provide no sustained all-tier claim. The packing comparison counts each required media range once; the browser report separately records actual transferred SCI bytes, including repeated requests.

These results do not establish indistinguishable source fidelity, lower bandwidth than conventional video codecs, sustained 2x playback at all tiers, or lower energy use. The all-tier excerpt is particularly short. Those packing trials did not measure local encoding speed or source-download time; the newer encoding measurements below are separate. The new packer adds no dependency, copied third-party implementation, font or media asset.

## H.266 in MP4 comparison

The current version 5 archives were compared with genuine H.266/VVC MP4 files on two retained 1920 by 1080 excerpts. Each contains 96 source presentation events: cartoon runs for 4.004 seconds at 24000/1001 FPS; fossils runs for four seconds at 24 FPS. The [raw report](measurements/vvc-mp4.json) records sources, hashes, tool versions, every QP search trial and independent MP4 verification. The [benchmark guide](benchmarking.md#h-266-in-mp4) describes reproduction.

VVenC 1.14.0, medium preset, eight threads and perceptual QP adaptation encode the original source RGB reference after conversion to ten-bit 4:2:0. SCI retains its full eight-bit RGB composition attributes. The comparison does not encode SCI output with VVC. Both containers include stereo 48 kHz Opus audio, although these excerpts contain silence. All complete-file byte counts below include audio and container overhead. MB means one million bytes.

| Excerpt | SCI v5 MB | H.266 MP4 MB | SCI RGB PSNR | VVC RGB PSNR | SCI SSIM | VVC SSIM |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| cartoon | 27.566 | 2.197 | 35.575 dB | 35.268 dB | 0.987282 | 0.975806 |
| fossils | 68.155 | 9.398 | 41.149 dB | 40.768 dB | 0.996569 | 0.994418 |

The selected VVC outputs are within the declared 0.5 dB RGB-error matching threshold, at QP 27 and QP 7 respectively. Counting selected SCI media bodies rather than reserved file padding, VVC uses 92.03 percent fewer bytes for cartoon and 86.21 percent fewer for fossils. SCI therefore requires 12.54 and 7.25 times as many media bytes in these tests. Both selected VVC outputs have lower SSIM. This is an RGB-error-matched size comparison, not proof of equal perceived quality or equal performance across VVC profiles. The 4:2:0 conversion can impose a quality floor; this does not describe every H.266 encoder.

Independent decoding verifies every MP4 frame, presentation timestamp and duration. Both outputs preserve all 96 frames at the requested cadence. Presented audio sample counts and PCM hashes match SCI exactly after trimming to each track's declared duration. Raw FFmpeg MP4 audio decoding exposes 456 and 648 trailing codec-padding samples per channel respectively; the audit records these rather than counting padding as additional presented audio. Silence does not establish speech or music fidelity.

The VVC IDR intervals are approximately 0.667 seconds for cartoon and 1.333 seconds for fossils. SCI retains its own independent chunk boundaries. Seek cost is not matched or measured. Search encode times are single-run diagnostics, with no controlled SCI encoding-speed comparison. No browser startup, buffering, decoder resource or sustained playback advantage is established by these files. Two short excerpts do not characterize long-form streaming or the full corpus.

An initial direct remux of an elementary VVC stream discarded a displayed frame and produced incorrect timing. That setup was rejected. The retained results use a temporary FFmpeg build with integrated `libvvenc` encoding and proper presentation timestamps. VVC tools remain outside the product; no conventional codec was added to SCI or playback, and no product dependency was added. The [VVenC license](https://github.com/fraunhoferhhi/vvenc/blob/v1.14.0/LICENSE.txt) requires notices when redistributing its software and grants no patent rights. This benchmark does not establish clearance to integrate or distribute H.266 commercially.

## Encoding and playback speed

The [speed report](measurements/speed.json) records the before/after binaries, matching compiler versions, source and module hashes, every measured run, resource limits and failed playback gates. The baseline is `d13b8ee`. Final benchmarks ran sequentially on the recorded Intel i5-12500H host. Other user applications remained running; CPU frequency and affinity were not pinned. These results describe these inputs and conditions, not every device.

The encoder now uses exact reciprocal color means, returns uniform regions as ASCII spaces, and prunes coarse fitting only when a squared-error lower bound proves it cannot beat the children. Native compression uses the existing zlib-rs backend already used by WASM. No dependency was added. Alternating one warm-up and three measured local encodes preserved every reconstructed pixel, presentation duration, dimension and frame count:

| Excerpt | 360p median before | 360p median after | Elapsed-time reduction |
| :--- | ---: | ---: | ---: |
| cartoon, 96 events | 10.857 s | 9.388 s | 13.5% |
| fossils, 96 events | 10.308 s | 9.546 s | 7.4% |

Complete SCI sizes changed from 3902030 to 3883512 bytes and from 9290933 to 9179865 bytes respectively, including audio and container overhead. A separate synthetic uniform 1080p60 hold also preserved exact output; its timing is a regression check, not evidence for general video encoding performance. These remain offline preparation times, not real-time encoding or source-download measurements.

The decoder retains immutable validated frames in both output paths, avoids repeated reference validation, and reuses the last CPU surface across deferred events. Command placement proves complete validated coverage before publishing a frame. Mutation and truncation tests independently validate every accepted result. RGBA reconstruction writes complete rows for base cells and preserves scaled glyph output. Alternating one warm-up and five measured WASM passes on the same 1080p archives gave:

| Excerpt | RGBA ms/event before | RGBA ms/event after | Elapsed-time reduction |
| :--- | ---: | ---: | ---: |
| cartoon | 13.596 | 9.235 | 32.1% |
| fossils | 20.703 | 16.257 | 21.5% |

All pixel, presentation and decoder-comparison audio hashes matched. These decoder timings exclude network, worker initialization and visible-canvas presentation. They do not establish uninterrupted playback.

The player defaults to CPU reconstruction, warms worker modules and CPU surfaces before starting its clock, and reuses its decoder pool on play and resume. Preparation requests bounded contiguous lead. Future chains preserve capacity for missing frontier work without reserving an already in-flight image twice. The image budget increased from 32 to 64 MiB, the source-event queue from eight to sixteen, the compressed/audio cache from 64 to 80 MiB, and the decoding horizon from 125 to 250 ms of wall time. This costs 48 MiB of additional buffer budget. The four-worker ceiling, 48 MiB request bound and 384 MiB decoder working-set estimate remain. These are not a bound on total browser or graphics-driver memory.

Three 1080p loopback trials per animation requested four source seconds at 2x, using CPU reconstruction for both revisions. Cartoon waiting events fell from 11, 14 and 18 to zero in every trial. Its new median observed playback time was 2.027 seconds, after separate startup and play preparation. Fossils fell from 19, 18 and 17 waiting events to 1, 2 and 3; sampled buffering remained 10.1, 115.5 and 75.6 ms. Both clips still use the original stored SCI, without source conversion or fidelity changes.

The reduction in waiting also costs preparation time: cartoon median startup increased from 207.6 to 240.1 ms, and play preparation from 89.6 to 199.3 ms. Those intervals are excluded from observed playback. The larger buffer budgets and code changes were measured together; the stream comparison does not isolate their individual effects.

The longer stress test retains the first 106 complete shared chunks of the existing two-minute mixed-detail archive, with 602 events and 10.033 seconds at every tier. Payloads, audio and seek boundaries were copied unchanged; only prefix metadata and offsets were rewritten. Trials requested ten source seconds, three times per tier and speed, with manual quality fixed:

| Tier | Waiting events at 1x | Waiting events at 2x |
| :--- | :--- | :--- |
| 360p | 0, 0, 0 | 0, 0, 0 |
| 480p | 0, 0, 0 | 0, 0, 2 |
| 720p | 1, 1, 0 | 21, 18, 17 |
| 1080p | 52, 52, 58 | 34, 33, 32 |

The 1080p 1x trials took 20.9 to 22.3 wall seconds to advance ten source seconds; the 2x trials took 17.0 to 18.6 seconds. This is a sustained decoding and reconstruction bottleneck, not a passed speed test. Every trial reached its source frontier within the wall-time limit, but the strict 2x all-tier uninterrupted gate failed and returned a nonzero exit status. No claim covers the rest of the two-minute source or broader live-action content.

Correctness tests can pass while buffering persists. A separate 360p correctness run on a 1.5 Mbit/s link with 100 ms latency recorded roughly 11.2 seconds to first frame and 7.6 seconds for a cold seek, with repeated buffering. That fixture's 13.24 MB SCI represents ten seconds, exceeding the tested link's capacity. Faster decoding alone cannot eliminate that bandwidth shortfall.

A forced 100 ms independent-checkpoint experiment was rejected: the cartoon archive grew to 12.54 MB at 360p, and 1080p repacking exceeded a 16 MiB shared-chunk bound. No checkpoint policy was shipped. A separate intermediate SIMD microbenchmark showed only a small completed-pixel improvement; a second decoder bundle was not added. The raw report retains both experiments and an early lead-preparation deadlock that received regression tests.

The result is faster encoding and decoding with unchanged ASCII output, timing and supported archive versions. **The zero-buffering target remains unmet**, including on this host's loopback stress test. Further work must reduce actual per-event decoding, reconstruction and delivery cost while measuring bytes, fidelity, startup and memory together.

## Historical measurements

Earlier reports and raw measurement JSON remain in the repository history at [cef572b](https://github.com/ecnivslabs/weft/tree/cef572b67b5e91beb46ebab6495e85cfd81ddfe0/docs). They describe the code and fixtures tested at that revision, not a new run of the current checkout.

- [SCI results](https://github.com/ecnivslabs/weft/blob/cef572b67b5e91beb46ebab6495e85cfd81ddfe0/docs/research.md): corpus, targets, compression failures and resource limits.
- [Legacy fidelity comparisons](https://github.com/ecnivslabs/weft/blob/cef572b67b5e91beb46ebab6495e85cfd81ddfe0/docs/fidelity.md): reflected ASCII improved RGB error but increased size and runtime.
- [Playback pipeline](https://github.com/ecnivslabs/weft/blob/cef572b67b5e91beb46ebab6495e85cfd81ddfe0/docs/playback-pipeline.md): bounded playback work and remaining stalls.
- [Raw measurements](https://github.com/ecnivslabs/weft/tree/cef572b67b5e91beb46ebab6495e85cfd81ddfe0/docs/measurements): recorded inputs, hashes, samples and scope.

Removed research implementations remain available in repository history. Experimental results do not become production guarantees until an implemented change receives agreement tests and a new controlled comparison.

## References

[ASCILINE](https://github.com/YusufB5/ASCILINE) is an architectural reference for separating an ASCII rendering engine from streaming and static delivery. Its representations and bandwidth claims are not results for Weft. The project uses its own visual encoder, format and decoder.

## What would establish progress

A candidate must preserve the representation contract and demonstrate quality, complete delivered size and playback cost on representative unique content. Comparisons need equal dimensions, source timing, duration, audio and a defensible quality match.

The research targets include 1080p60 below 1 Mbit/s total media delivery, startup and seeking within two seconds on the declared constrained link, and uninterrupted 2x playback at each prepared tier. A 1 Mbit/s media-time bitrate alone cannot sustain 2x on a 1.5 Mbit/s link. HTTP overhead and safety headroom also matter.

Use [the benchmark guide](benchmarking.md) for reproduction. Keep failures visible and distinguish diagnostics from perceptual or sustained-playback evidence.
