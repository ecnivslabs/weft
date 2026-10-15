# Architecture

The workspace separates the visual codec from source ingestion, browser playback and application storage.

| Component | Responsibility |
| :--- | :--- |
| `crates/weft` | Glyph fitting, ASCII packets, reconstruction and bounded SCI reading. |
| `crates/weft-media` | FFprobe metadata, FFmpeg ingestion, synchronized audio and archive writing. |
| `crates/weft-cli` | Encode, inspect and reconstruct commands. |
| `crates/weft-wasm` | Browser ABI for the Rust decoder. |
| `website/web` | Public landing page and image previews. |
| `player/web` | Local SCI player and decoder workers. |
| `player/server` | Local HTTP ranges, ingestion API and persistent catalog. |
| `website/tests` | Public site and documentation checks. |
| `player/tests` | Browser agreement, ingestion, playback and benchmark runners. |
| `shared` | Common web assets and comparison preparation. |
| `formats` | SCI format specification. |

## Ingestion

FFprobe validates dimensions and timing. FFmpeg supplies source RGB and audio during preparation. The ASCII encoder partitions frames into spatial groups and fits their fixed glyph layers and colors. Exact reciprocal arithmetic preserves rounded color means. A squared-error lower bound skips a coarse fit only when even unconstrained block colors cannot beat its children, including the byte penalty.

Fitting stages independently compressed frames. Delivery packing reconstructs those compositions, compares actual packet lengths and chooses independent or predicted packets. Renditions share seek boundaries. A boundary splits before any payload exceeds 16 MiB, preserving fitted output and source cadence. Each chunk begins independently. Native and WASM zlib processing use the existing zlib-rs backend.

The writer adds timed Opus chunks, metadata and checksums. Temporary ASCII staging is limited to 64 GiB. Completed archives publish without overwriting an existing output.

## Browser playback

The reader fetches the header, metadata and index using HTTP byte ranges. It validates record bounds and loads visual and audio chunks on demand. Workers decode ASCII through Rust WebAssembly; CPU and WebGL2 renderers reconstruct the same glyphs. The player defaults to CPU reconstruction; explicit GPU and automatic renderer policies remain available to callers. This avoids forcing software WebGL onto the viewing path. The CPU surface retains the last rendered, validated composition and redraws changed roots, including after deferred source frames. It does not reuse unvalidated cell attributes.

Audio drives the presentation clock when present. Seeking stops scheduled audio, resets references at an independent chunk, and reconstructs forward to the requested time. Resolution changes select another stored rendition while preserving playback position. Playback speed currently changes audio pitch.

Presentation and in-flight reconstructed images share a 64 MiB budget, with at most sixteen queued or reserved source events and a 250 ms wall-time decoding horizon, scaled by playback speed. Worker modules and CPU presentation surfaces initialize before the clock starts. Future dependency chains leave a frame reservation available for the next contiguous source event. Play and resume retain the prepared decoder pool and wait for up to sixteen contiguous source events of lead before starting the clock. At 2x, the target is at most 200 ms of wall time and remains subject to the image budget. This preparation is bounded by the remaining source duration; it does not hide later stalls or skip source dependencies. The compressed and decoded-audio cache is bounded to 80 MiB, with a separate 48 MiB request budget. Four maximum-size visual chunks and their decoded audio must fit concurrently; the former 64 MiB cache could not hold that working set. Decoder state, browser surfaces and graphics driver allocations are not included in the presentation budget. These are pipeline limits, not a total browser memory guarantee.

The public website shows licensed animated WebP exports of actual SCI output. It has no full player, ingestion form, playlist or server API dependency. Its Pages artifact excludes the native player and decoder. The local Rust server serves a separate player page with real SCI decoding; Pages does not run Rust ingestion.

## Local storage

The local server retains source downloads in ignored `videos/` storage. Each library keeps ready archives in `videos/sci/LIBRARY_ID/` and its catalog in the selected data directory. Ready entries reuse stored SCI on restart; interrupted or obsolete profiles regenerate from retained sources.

One process owns a data directory. Job revisions prevent a removed entry from being restored by an older preparation job. Original source files are ingestion inputs and are never served as visual playback.

The local server binds to loopback by default and checks mutation origins and loopback hosts. It is intended for a trusted local library. Exposing its ingestion API requires an application's authentication, authorization, TLS and quotas. The public GitHub Pages build includes no ingestion service.

## Compatibility

SCI carries explicit presentation durations and timed seek records. New archives use internal container version 5; version 4 remains readable and reusable. Both versions retain the scene-v1 codec and fixed reflected ASCII font. Version 5 adds compact streams containing only composition origins and active attributes. Historical containers, codecs and fonts fail explicitly. The local ingestion service regenerates obsolete archives from retained sources.

The normative font is `crates/weft/src/glyphs.json`. Rust and browser tests require identical definitions and reconstruction. [SCI](../formats/SCI.md) is the format contract; [integration](integration.md) describes the API boundaries.
