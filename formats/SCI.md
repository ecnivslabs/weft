# SCI format

SCI is Weft's ASCII video archive format. Files use `.sci` and MIME type `application/vnd.weft.sci`. One visual representation is supported, with synchronized Opus audio and explicit presentation timing. The format contains ASCII symbols and appearance attributes, never a conventional video stream or source pixel planes.

New archives use internal container version **5**. Version 4 remains readable with its original packet rules. Versions 1 through 3, two-color visual profiles and experimental scene-v2/v3 profiles are rejected. Container versions describe compatibility, not visual modes or filename extensions. Existing valid version 4 archives remain reusable without re-encoding.

## Header and metadata

Integers are unsigned and little endian. The fixed header occupies 32 bytes.

| Offset | Bytes | Meaning |
| :--- | :--- | :--- |
| 0 | 4 | Magic `SCIV` |
| 4 | 2 | Internal version 4 or 5 |
| 6 | 2 | Flags, bit 0 indicates audio; other bits zero |
| 8 | 4 | UTF-8 JSON metadata length |
| 12 | 4 | Index record count |
| 16 | 8 | Absolute index offset |
| 24 | 8 | Complete archive size |

Metadata begins at byte 32 and occupies between 2 and 4096 UTF-8 bytes. The writer reserves 4096 bytes; readers follow offsets and ignore padding. Index offset is at most 65536. Archive size must equal the header declaration and cannot exceed 64 GiB.

## Seek index

Each little-endian record occupies **48 bytes**. Payload ranges are ordered, disjoint and within the archive. The final payload ends at the declared archive size. A reserved gap before payloads is allowed.

| Offset | Bytes | Meaning |
| :--- | :--- | :--- |
| 0 | 2 | Rendered quality height, or zero for audio |
| 2 | 2 | Rendered pixel width, zero for audio |
| 4 | 2 | Rendered pixel height, zero for audio |
| 6 | 2 | ASCII frame count, zero for audio |
| 8 | 4 | First frame number on the common timeline |
| 12 | 4 | Reserved zero for visuals; PCM sample count per channel for audio |
| 16 | 8 | Absolute payload offset |
| 24 | 4 | Payload byte length |
| 28 | 4 | IEEE CRC32 of stored payload |
| 32 | 8 | Presentation start, unsigned microseconds. |
| 40 | 8 | Presentation end, unsigned microseconds. |

## Presentation timing

Metadata declares `chunks`, `frames`, `duration`, nominal rational `fpsNumerator` and `fpsDenominator`, `fps`, `timebase: 1000000`, `chunkSeconds: 1`, `video`, `audio`, and `qualities`. FPS describes nominal source cadence, not a promise that variable-rate input is constant. Duration comes from presentation timestamps. Corresponding rendition/audio chunks must have identical start/end times and first frame numbers. Each rendition covers the entire timeline without gaps or overlap. Audio sample counts equal `floor(end * 48000 / 1000000) - floor(start * 48000 / 1000000)`.

A video packet starts with its unsigned 32-bit presentation duration in microseconds, followed by a nine-byte packet header (tag, uncompressed length, compressed length) and one zlib stream. Durations are positive and at most one second. Long source holds split into identical presentation events without introducing new motion. Metadata records sourceFrames and averageFps separately from presentation event counts. Delivery chunks span at most two seconds, including a trailing hold event. Their sum must equal the indexed chunk duration. References reset at each chunk. Source timestamps normalize to the first video frame and are retained to microsecond precision. Sources above the configured frame-rate ceiling drop frames using source timestamps, rather than generating new motion.

The only visual profile is `sci-ascii-scene-v1`, mapper `adaptive-layered-v2`, font `ascii-3x4-v2`, transform `reflect-xy-v1`, and `cellBytes: 28`. Version 4 uses packet format `ascii-scene-zlib`; version 5 uses `ascii-scene-fields-zlib`. Packet tags are 4 (independent commands), 5 (predicted commands), 6 (spatial attribute planes), and 7 (motion-predicted attribute planes). Version 5 additionally permits tags 8 (independent composition fields) and 9 (temporal composition fields). Tags 5, 7, and 9 require a previous frame and cannot start a chunk. Version 4 rejects tags 8 and 9. All other tags and codec profiles are rejected.

The writer stages independently compressed ASCII frames before delivery packing. Packing reconstructs those compositions and selects temporal packets, then splits every rendition at a common boundary whenever any rendition would exceed 16 MiB. New boundary packets are independent. This bounds delivery payloads without changing fitted glyphs, colors, resolution, or source timing. Chunks may therefore be shorter than the one-second target. Temporary ASCII staging is limited to 64 GiB and is removed on completion or failure. Reserved index space may leave an unreferenced gap before payloads; viewers do not fetch that gap.

The writer can use a smaller preferred delivery budget, recorded as informational `deliveryChunkBytes`. It avoids preference-driven splitting until a group spans at least 20 ms; a hard-limit split takes precedence. One complete frame or that minimum group can exceed the preferred budget. References still reset at every actual boundary and audio retains the same indexed time range.

## Adaptive glyph representation

The normative [glyph table](../crates/weft/src/glyphs.json) defines all 95 printable ASCII symbols, codes 32 through 126. Each symbol has a fixed 12-bit mask. Bit `row * 3 + column` selects foreground when set. For each reflected glyph sample, use column `2 - x` when reflection bit 0 is set and row `3 - y` when bit 1 is set. Scaling repeats this fixed mask; no frame can transmit a replacement mask. Changes to glyph masks require a distinct font identifier.


A composition partitions the raster into disjoint square groups of base cells. A base cell covers 3 by 4 pixels. A leaf covers 1, 2, 4, or 8 base cells on each axis, so its scale is 1, 2, 4, or 8. It paints an explicit ASCII space with a background RGB color, followed by zero to four printable ASCII foreground glyphs in order. Foreground layers paint only set bits of their fixed glyph masks; unset bits preserve the previous layer. Reflection bit 0 flips glyph columns and bit 1 flips glyph rows; other bits must be zero. Scaling uses nearest-neighbor replication of the fixed 3 by 4 mask. Colors are unsigned eight-bit RGB. No arbitrary source masks or pixel residuals are permitted.

The bounded expanded decoder state uses 28 bytes per base cell:

| Offset | Meaning |
| :--- | :--- |
| 0 | Scale exponent, 0 through 3 |
| 1, 2 | Horizontal and vertical base-cell offsets within the leaf |
| 3 | ASCII space, code 32 |
| 4 through 6 | Background RGB |
| 7 | Number of foreground layers, 0 through 4 |
| 8 through 27 | Four five-byte slots: ASCII code, reflection flags, foreground RGB |

Unused slots are zero. Every base cell in a leaf repeats the same scale, background, and layers, with its own offsets. Leaves must fit completely inside the frame. Readers reject overlapping, incomplete, inconsistent, or out-of-bounds leaves.

Optional encoder color quantization selects RGB attributes from a uniform per-channel palette with `2^bits` levels for 4 through 8 bits. For an input channel value `v`, compute `i = floor((v * (2^bits - 1) + 127) / 255)`, then `floor((i * 255 + floor((2^bits - 1) / 2)) / (2^bits - 1))`. Quantization applies to averaged fitting samples and final fitted colors. Layers that no longer change reconstruction may be removed. The optional informational `video.colorBits` records preparation precision. Stored attributes remain eight-bit RGB and decoding rules are unchanged. Eight-bit preparation is the default and preserves prior full-precision output.

## Palette and composition commands

Inflated command packets (tags 4 and 5) begin with an unsigned byte palette count, 0 through 255, followed by that many RGB triples. A color reference is one byte: 0 through 254 indexes the palette; 255 is followed by a literal RGB triple. Invalid palette indexes fail.

Commands fill the next unfilled base cell in row-major order:

- Command 0: scale exponent, ASCII space, background color reference, layer count, then each layer's ASCII code, reflection flags, and color reference. The reconstructed leaf fills its complete square region.
- Command 1, permitted only in tag 5: unsigned 32-bit base-cell index of a leaf origin in the previous reconstructed frame. Copy that complete glyph composition into the current position. Moving a composition changes its placement, not its symbols or masks.
- Command 2, permitted only in tag 5: positive unsigned 16-bit run count and unsigned 32-bit source base-cell index. Copy that many consecutive scale-one leaves from the previous frame. The destination must also be consecutive unfilled cells.

Commands must fill the entire frame exactly, with no trailing bytes. Previous state is immutable while constructing the next frame. Every packet is independently inflated with an exact length check and rejection of trailing compressed data. Inflation is limited to `baseCellCount * 38 + 1024` bytes. Compressed payloads remain limited to 16 MiB. No reference crosses a delivery chunk.

## Attribute planes

Tag 6 contains exactly `baseCellCount * 28` bytes, arranged in 28 attribute planes. Each byte predicts from the left, above, and upper-left value using the Paeth predictor. Missing neighbors are zero. Subtract the predictor modulo 256 when encoding; add it modulo 256 when decoding. Paeth selects the nearest neighbor to `left + above - corner`, with ties preferring left, then above, then corner.

Tag 7 starts with signed little-endian 16-bit horizontal and vertical motion offsets in base-cell units, each between -64 and 64. The remaining bytes are 28 attribute planes. Each reconstructed destination attribute predicts from the previous frame at `(x - dx, y - dy)`, or zero outside the frame. Attribute subtraction/addition is modulo 256. The complete reconstructed composition geometry and ASCII symbols must validate before rendering. These residuals describe glyph attributes, never arbitrary pixel samples.

The encoder estimates a global cell motion offset from repeated complete glyph compositions. It compares zero-motion prediction, the estimated motion prediction, spatial planes, and composition commands using their actual compressed sizes. Every choice reconstructs exactly the same ASCII composition.

## Compact composition fields

Version 5 tags 8 and 9 use the same packet header, zlib envelope, timing and inflation limits as other visual packets. Their expanded payload starts with one prediction-mode byte and an unsigned little-endian 32-bit composition count `N`. Require `1 <= N <= baseCellCount` and an exact payload length of `5 + 5*N + 5*sum(layerCounts)` bytes. The count and minimum length must validate before allocating composition storage.

Fields follow in this order: scale exponent, foreground layer count, background R, G, B, then each of four foreground slots in order, with ASCII code, reflection, R, G, B for each slot. Each field is a separate byte stream in row-major composition-origin order. Scale, layer count and background streams contain `N` entries. A foreground slot contains entries only for compositions whose layer count includes that slot. Unused slots, the fixed ASCII space and covered-cell offsets are not transmitted.

Tag 8 accepts mode 0 (literal fields) or mode 1 (preceding-value differences). In mode 1, each field stream starts with a zero predictor; later entries predict from the preceding reconstructed value in that same stream. Subtract modulo 256 when encoding and add modulo 256 when decoding. Inactive foreground slots do not advance the predictor. Tag 9 accepts only mode 2 and requires a previous validated frame of identical dimensions and font. Scale and layer-count streams remain literal. Every other field predicts from the previous expanded frame at the destination composition's origin, even when that prior base cell was covered by a differently sized composition. Prediction uses the same byte offset, with modulo-256 subtraction and addition. No reference crosses a chunk.

Reconstruct scale values first. Each exponent must be 0 through 3. Place each composition at the next uncovered base cell in row-major order, covering a square of `2^exponent` base cells on each axis. Reject overlap, out-of-bounds placement, excess compositions and incomplete coverage. Decode layer counts next, requiring 0 through 4, then derive all foreground-stream lengths before reading attributes. Restore the ASCII space, zero inactive slots and validate every glyph and reflection. Expand origins into the existing 28-byte cells, including each covered cell's own offsets. The resulting geometry and attributes must pass the same validation as command and plane packets. Reject trailing or missing bytes, invalid modes and missing temporal references.

Encoders compare complete compressed packets against the existing command and plane candidates. All candidates reconstruct identical ASCII cells. Compact fields change serialization only; they introduce no pixel payload, replacement glyph masks, color quantization or additional fitting loss.

## Audio

Metadata declares `audio: null` when no audio is present. Otherwise it declares `codec: "opus"`, `sampleRate: 48000` and `channels: 2`. Each audio index record stores one complete independent Ogg Opus stream for its presentation interval. Audio payloads have no visual packet headers or duration prefixes.

Ogg pages use version zero, one stream serial, consecutive page sequence numbers beginning at zero, correct page checksums and consistent continuation flags. The first page marks beginning of stream and the final page marks end of stream. The first packet is a 19-byte `OpusHead`, version 1, stereo, channel mapping family 0; the next is `OpusTags`. Packet assembly is bounded to 65536 bytes. Each Opus data packet represents at most 5760 samples per channel (120 ms).

Decode at 48 kHz, apply the Opus header's pre-skip, and trim trailing samples using the final Ogg granule position. The final granule must equal the indexed sample count plus pre-skip. The decoded interval must supply exactly the indexed number of samples per channel. Audio chunks schedule at their indexed presentation start, on the same clock as visual events. Seeking begins with the independent audio chunk and skips the portion before the requested time. These audio codecs serve synchronized sound only; they never carry the visual representation.

## Encoder and evidence

The encoder first fits reflected two-color glyphs, then greedily adds foreground glyph layers only when they reduce squared RGB error. It jointly refits each surviving layer color to the optimal rounded mean of its visible source pixels and removes completely occluded foreground layers. This cannot increase patch error. It considers an adaptive tree through scale eight. Exact coarse reconstructions short-circuit finer searches; otherwise child compositions compete with their parent. A byte penalty controls the local distortion versus serialized composition-size objective; zero penalty does not permit increased error from merging. The local size model precedes entropy coding and is not a globally optimal rate-distortion solver. Complete and predicted packets compete using their actual compressed byte lengths. A bounded patch cache reuses repeated source patches.

The default fidelity profile permits four layers and uses zero spatial byte penalty. The requested delivery bitrate is a research target recorded separately from the achieved rate; exceeding it never silently reduces resolution, source cadence, or fidelity settings. Research sweeps report actual compressed sizes and quality before changing production defaults.

Archives are limited to six hours, 100000 index records, 64 GiB total, 4096 pixels wide and 1080 pixels high. Dimensions must be divisible by three horizontally and four vertically. Each visual or audio delivery payload is at most 16 MiB. Supported rendition targets are 360p, 480p, 720p and 1080p, limited by source height.

Readers validate declarations before allocation, enforce exact inflation lengths and reject malformed glyphs, geometry, timing, checksums or unsupported identifiers. A failed decode cannot publish partial reconstructed output. Browser workers run the matching Rust decoder through WebAssembly; missing support fails explicitly.

These bounds and the custom extension do not establish better compression, indistinguishable quality or lower resource use. See [research status](../docs/research.md) for evidence and remaining targets.
