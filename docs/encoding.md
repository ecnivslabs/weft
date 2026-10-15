# Encoding media

Use Rust 1.89 or newer. Ingestion requires FFmpeg, FFprobe and libopus on `PATH`. Inspection and frame reconstruction use the Rust codec without external media tools.

```sh
cargo build --release --locked
cargo run -p weft-cli --release -- encode videos/input.mp4 videos/output.sci
cargo run -p weft-cli --release -- inspect videos/output.sci
cargo run -p weft-cli --release -- decode videos/output.sci 30 frame.ppm --height 720
```

The source must exist. The output archive must not exist. Failed preparation removes its temporary files; a completed archive publishes without overwriting another output. An ASCII-derived JPEG thumbnail accompanies ingestion output.

`inspect` prints validated metadata. `decode` reconstructs a zero-based presentation frame and writes RGB PPM. A frame number refers to stored presentation events, which can include repeated events for long source holds.

## Resolution and timing

By default the encoder prepares 360p, 480p, 720p and 1080p when the source is tall enough. Select a subset explicitly:

```sh
cargo run -p weft-cli --release -- encode videos/input.mp4 videos/subset.sci --heights 480,1080 --fps 60000/1001
```

`--fps source` preserves source cadence up to 60 FPS. `--fps NUM/DEN` applies a ceiling using source timestamps. It drops excess frames without generating interpolated motion. Fractional rates and variable presentation durations remain explicit in SCI. Long still holds split into repeated events to bound seek chunks.

Quality labels describe rendered pixel height. Requested tiers above source height are omitted when lower requested tiers are available. If every requested tier exceeds a source of 360p or taller, encoding fails. Sources below 360p receive a source-sized rendition with height rounded down to a multiple of four. Width rounds to the nearest multiple of three while preserving the source aspect ratio.

## Offline fitting options

| Option | Purpose |
| :--- | :--- |
| `--layers 1..4` | Maximum foreground glyph layers per spatial group. |
| `--quality 0..100` | Spatial merging quality. The default is maximum detail. |
| `--byte-penalty VALUE` | Distortion cost assigned to estimated serialized bytes. |
| `--color-bits 4..8` | Precision of fitted RGB attributes. Eight bits is the default. |
| `--chunk-bytes BYTES` | Preferred delivery payload budget, between 64 KiB and 16 MiB. |
| `--target-bitrate BITS_PER_SECOND` | Recorded research target, not an enforced rate controller. |

Lower color precision can introduce banding. A smaller preferred chunk budget changes grouping rather than fitted pixels or cadence; one complete frame can exceed that soft budget. The hard 16 MiB payload limit still applies.

These options prepare archives. They are not viewer modes. Expensive offline fitting is expected, and progress is printed to stderr.

## Format compatibility

The encoder writes one `.sci` representation: `sci-ascii-scene-v1`. New archives use internal container version 5. Existing version 4 archives remain playable and reusable. Compact field packets compete with existing command and plane packets using actual compressed lengths, preserving identical decoded compositions. Container versions 1 through 3, two-color profiles and experimental scene versions are no longer supported. Re-encode their retained source media before playback.

Fitting and delivery options participate in cache identity, so ingestion does not reuse archives prepared with incompatible settings.

[Research status](research.md) describes the measured limits. [SCI](../formats/SCI.md) specifies the supported representation and rejection rules.
