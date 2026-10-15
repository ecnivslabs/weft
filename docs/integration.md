# Rust integration

`weft` owns ASCII fitting, packet decoding, reconstruction and seekable archive reading. It has no FFmpeg or HTTP dependency. Add `weft-media` only when your application needs source ingestion and audio preparation.

Use a path dependency while working from this repository:

```toml
[dependencies]
weft = { path = "../weft/crates/weft" }
```

## Fit and reconstruct a frame

Create one encoder per rendition and reuse it across frames. It retains a bounded patch cache.

```rust
use weft::{packet, scene};

fn roundtrip(rgb: &[u8], width: usize, height: usize) -> std::io::Result<Vec<u8>> {
    let mut encoder = scene::Encoder::new(scene::Options::default())?;
    let frame = encoder.map_frame(rgb, width, height)?;
    let packet = scene::packet(&frame, None, width, height)?;
    let declared = u32::from_le_bytes([packet[1], packet[2], packet[3], packet[4]]) as usize;
    let decoded = packet::decode(packet[0], declared, &packet[9..], None, packet::FrameSpec {
        width, height, font: "ascii-3x4-v2",
    })?;
    scene::render(&decoded, width, height)
}
```

Input is packed RGB. Width must be divisible by three, height by four, and the input length must match the dimensions. Reconstruction is lossy relative to the input, but decoding must recover the encoded composition exactly.

`packet::decode` accepts a bounded compressed packet and an explicit `FrameSpec`. Packets need raster dimensions and the fixed font identifier. The expanded 28-byte state is decoder memory, not the transmitted packet size.

`scene::packet` selects version 6 packet candidates. Use `scene::packet_for_version` with version 4 or 5 when writing an archive for an older decoder. `format::VERSION` and `format::PACKET_FORMAT` describe the default writer. The archive reader accepts all three versions and rejects packet tags newer than the declared container version.

`scene::Surface` keeps a validated reference and its RGBA reconstruction. `update` reuses unchanged groups and preserves its previous valid state after failed validation. `scene::render_rgba` reconstructs directly into a caller-owned vector.

## Seek in an archive

```rust
use std::fs::File;
use weft::{archive::Archive, scene};

fn read_frame(path: &str, height: u16, number: u32) -> std::io::Result<Vec<u8>> {
    let mut archive = Archive::open(File::open(path)?)?;
    let metadata = archive.metadata();
    let quality = metadata["qualities"].as_array()
        .and_then(|qualities| qualities.iter().find(|quality| quality["height"] == height))
        .ok_or_else(|| std::io::Error::other("Requested rendition is not stored"))?;
    let width = quality["columns"].as_u64()
        .ok_or_else(|| std::io::Error::other("Missing validated rendition width"))? as usize;
    let frame = archive.frame(height, number)?;
    scene::render(&frame, width, usize::from(height))
}
```

`Archive::open` validates metadata, bounds and index structure. Payload reads verify CRC32. `frame` loads the containing seek chunk and reconstructs references from its independent first packet.

For sequential playback, use `video_chunk` and `next_frame`. `presentation()` reports the most recent frame's start and duration in microseconds. `payload(0, chunk)` returns the matching Ogg Opus payload when audio is present. The caller owns audio output and presentation scheduling.

## Ingest sources

Add `weft-media` as a path dependency. `probe(Path)` returns source metadata; `encode_with_options` prepares SCI using `EncodeOptions`.

Default options retain eight-bit RGB fitting, layered ASCII, supported tiers at or below source height (a source-sized rendition for inputs below 360p), and source timing capped at 60 FPS. FFprobe, FFmpeg and libopus are required. Existing destinations are rejected and temporary files remain isolated per job.

## Browser contract

`weft-wasm` exposes input reservation, packet decoding, validated cell output, RGBA reconstruction, reset and error retrieval. [wasm.js](../player/web/wasm.js) contains the JavaScript ABI adapter.

`codecFormat(video)` validates the sole supported profile and returns ABI selector 28. Each base cell expands to 28 bytes. Historical profile selectors, packet tags and fonts are rejected.

Returned pixels are copied by default. Borrowed WASM views are valid only until the next decoder mutation and must not be written to. Retained or transferred output needs ownership of a copy. Reset at independent seek points and when dimensions, font, codec or output mode changes.

Workers use the same decoder and can reconstruct validated glyph attributes through WebGL2. A lost context uses CPU reconstruction of the already decoded frame, preserving reference state. Both paths derive their pixels from SCI attributes.

Run `cargo doc --workspace --no-deps` for the current API reference. The [software license](../LICENSE) permits noncommercial use; review it before business integration or redistribution.
