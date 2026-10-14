# Introduction

Weft, a product of ecnivs, encodes video frames as compositions of ASCII glyphs. It aims to make those compositions detailed enough to resemble ordinary video, while preserving a symbol-based representation throughout storage and playback.

The desired result is lower bandwidth and playback cost at comparable quality. That remains a research goal. Recorded comparisons show larger archives than the tested conventional codecs, and difficult image detail still exposes the lossy fitting.

## What a frame contains

The scene codec uses printable ASCII symbols from a fixed 3 by 4 font. A frame partitions its raster into spatial groups. Each group has a background space glyph and up to four foreground glyph layers, with RGB colors and horizontal or vertical reflections. Groups can span 1, 2, 4 or 8 base cells on each axis.

The decoder expands the declared glyph masks at each group's scale and draws the ordered layers. Colors, shapes and positions determine the resulting pixels. The archive carries the symbols and attributes needed for that operation, rather than source pixels or a conventional visual codec.

[SCI](../formats/SCI.md) defines the byte layout, legal symbols, spatial coverage, color rules and exact reconstruction algorithm.

## Preparation and playback

FFmpeg decodes the source during ingestion. weft fits and compresses its ASCII compositions, writes presentation durations and independent seek chunks, and adds synchronized Opus audio to `.sci`.

A viewer reads the prepared archive. The browser worker runs the Rust decoder as WebAssembly and presents reconstructed frames on Canvas. WebGL2 can reconstruct the same validated glyph attributes; CPU reconstruction handles unavailable or lost graphics contexts.

Sources are not downloaded or converted again during playback. Quality settings select a prepared rendition. Source timing survives ingestion up to the configured 60 FPS ceiling, including fractional and variable rates.

## Resolution and compatibility

Supported rendition heights are 360, 480, 720 and 1080 pixels. These labels describe the rendered image, not character rows. Width rounds to a multiple of three to match the font. A 16:9 source can therefore produce 639x360, 852x480, 1281x720 and 1920x1080.

Files use `.sci`, with internal container version 4 and one scene-v1 visual representation. Historical containers, fonts and experimental scene versions are rejected. Regenerate those archives from retained sources. For inputs below 360p, the encoder creates a source-sized rendition with height rounded down to a multiple of four.

## Next steps

Use [the CLI](encoding.md) to prepare an archive, [the Rust library](integration.md) to integrate the codec, or [the website](website.md) to watch the sample. Read [research status](research.md) before interpreting performance claims.
