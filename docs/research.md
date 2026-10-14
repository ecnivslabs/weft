# Research status

Weft implements a custom ASCII visual codec, synchronized SCI archives and browser playback. Its goal remains faithful 1080p60 delivery with substantially lower bandwidth and resource cost than conventional video.

That goal is not met. Historical quality-matched comparisons favor the tested conventional codecs in size, preparation is expensive, and difficult detail remains visibly lossy. No completed blinded perception study or controlled hardware-decoder resource comparison establishes indistinguishable quality or lower CPU, memory or energy use.

## Current default

The production profile is `sci-ascii-scene-v1`, with adaptive layered glyph fitting and eight-bit RGB attributes. It preserves source timing up to 60 FPS and supports 360p, 480p, 720p and 1080p renditions.

Experimental scene versions and temporal fitting were removed from production. They did not establish the efficiency goal. The current encoder and decoder support one visual representation.

Bounded delivery, independent seeking, persistent cache reuse and Rust/browser agreement are implemented and tested. Sustained 2x playback across every tier remains unverified. Short tests and median decoder timings cannot establish that target.

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
