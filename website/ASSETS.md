# Asset notices

## Cartoon comparison

The source is a four-second visual excerpt from **Fossils**, a cat-and-dog cartoon by Piti Yindee. The creator released the film’s visuals under [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). The [archived creator description](https://archive.org/download/youtube-27lZiillddg/20210603-27lZiillddg-Original_Short_Film_-_Fossils.description) records that dedication, and the [Commons license review](https://commons.wikimedia.org/wiki/File:Piti_Yindee_-_Fossils_(2021).webm) confirms it. The [source recipe](../shared/media/sample.json) pins the download, original-file hash, excerpt and preparation settings. Attribution is not required for these visuals.

The original soundtrack is excluded. Its music performance has separate CC BY-SA terms, so the retained ingestion clip replaces all original audio with silence. Its SCI preparations contain a synchronized silent stereo Opus track at 48 kHz. The public animated images have no audio. These images demonstrate a codec comparison, not an endorsement by the film’s creator.

The excerpt begins at 24 seconds and retains 96 source frames at 24 FPS, without interpolation. The archived film is 3412×1440. Preparation resizes it equally in both comparison paths to 1920×810 with Lanczos filtering, then adds 135 black rows above and below for a 1920×1080 input. This preserves the full composition without stretching or cropping. The SCI comparison uses quality 100, four ASCII foreground layers, eight-bit RGB and zero spatial byte penalty. Every Weft image is decoded from that archive by the production decoder.

Source and decoded frames receive the same Lanczos resize to 400×225 and 24 FPS preview cadence, then lossless animated WebP encoding. They repeat the selected excerpt without adding a transition or reversing its motion. Matching native PNGs preserve frame 24, at one second. Use those PNGs for inspecting pixel differences: preview resizing can conceal them, and the fitting remains lossy.

The comparison images and posters are stored once under `docs/assets/`. The public build copies the required images into its artifact and verifies their [recorded settings and hashes](../docs/assets/fidelity.json). The local player SCI archive remains separate because it uses a different, 360p preparation. Source footage and the maximum-quality archive stay under ignored `videos/fossils-sample/` storage. No conventional video file is published.

### Reproduce

Use Node.js 22 or newer, FFmpeg with HTTPS, FFV1, libopus and animated WebP support, and the release CLI:

```sh
cargo build --release --locked
node shared/scripts/prepare-preview.mjs
```

The script reuses the retained ingestion clip, prepares it from a retained original when available, or retrieves the specified excerpt. It verifies the retained original’s hash before extraction. HTTPS certificate validation and bounded connection retries remain enabled. The source recipe pins the decoded source-frame hash. The script validates the source, encodes and decodes actual SCI frames, then prepares the images and the smaller native-player fixture. All processing finishes in a temporary directory before public assets are replaced. Codec or FFmpeg changes can alter archive bytes; the manifest identifies the particular preparation.

No media preparation runs during the public site build. Update the recipe deliberately when changing the source. Replacing the preview does not require a screenshot update in ecnivs-site: its Weft card embeds the live product homepage.

## Published SCI sample

`player/web/sample.sci` is a 360p preparation of the same excerpt at its native frame rate. Its identity is recorded in [player/web/sample.json](../player/web/sample.json). The sample demonstrates the representation and a short playback path, not sustained streaming performance or a bandwidth advantage.

The Pages artifact excludes SCI archives and decoder files. The sample remains downloadable from the repository and serves the local native player. Historical source footage remains in ignored research storage with its original license obligations.

## Retained research reel

`videos/mixed-detail-1080p60.mkv` is a local ingestion input: 120 seconds, 1920x1080, native 60 FPS, 7200 frames, lossless FFV1 and stereo 48 kHz PCM. It is not part of the Pages artifact. Its recorded size is 8,235,055,580 bytes and SHA256 is `218409f3ca4519ca38f1a41a1ac80559c03df1226f09dce68db08eaedd6ad79b`.

The six 20-second sections are Office Walk, Winter Drive, Floorball Game, Freedoom gameplay, Synthetic City and original moving typography. Short UVG previews repeat to fill their sections. Benchmarks use unique excerpts and must not treat these repeats as broader corpus coverage. The previews already contain distribution-codec artifacts.

The Office Walk, Winter Drive and Floorball Game footage comes from [UVG-VCM](https://ultravideo.fi/UVG-VCM/index.html), Ultra Video Group, Tampere University, under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). [Freedoom: Short gameplay](https://commons.wikimedia.org/wiki/File:Freedoom_-_Short_gameplay.webm), recorded by CapoFantasma97, is under CC BY-SA 4.0. The [Freedoom](https://freedoom.github.io/) game's assets use its BSD license; game software is not bundled here. This research footage is not part of the public comparison or current SCI sample.

The adapted reel, original typography contribution and reel-derived ASCII reconstructions are under CC BY-SA 4.0. Preserve these credits when redistributing them. Media rights remain separate from the software license.

The [reel recipe](../player/scripts/reel.json) pins source URLs, sizes and checksums. Rebuild locally with Node.js 22 or newer and FFmpeg with FFV1, drawtext and a monospace font:

```sh
node player/scripts/create-reel.mjs
```

The builder verifies downloads and the final timeline, isolates temporary files, and refuses to overwrite a destination. Creation needs approximately 20 GiB of free space. `WEFT_REEL_FONT` selects a local font file.

## Hero artwork

The woven knot is original mathematical artwork rendered by [prepare-hero.mjs](scripts/prepare-hero.mjs). The script rasterizes a lit trefoil tube, prepares a lossless ingestion frame, encodes it to SCI and decodes it with the production CLI. Only the decoded PNG is published. The [hero manifest](media/hero.json) records source, archive and image hashes; the public build checks the image hash. Source and SCI files remain under ignored `videos/hero/` storage.

The browser samples that decoded image into three cached character grids. Its repeating transition refines large cream ASCII characters through smaller colored glyphs into the detailed image, then reverses. This is an illustration of visual density, not a comparison between encoder profiles. No source artwork or conventional video is used as its detailed playback path. The artwork requires no third-party credit.

Reproduce with FFmpeg and the release CLI:

```sh
node website/scripts/prepare-hero.mjs
```

## Fonts and identity

Inter, Space Grotesk and Geist Mono are bundled locally under the SIL Open Font License 1.1. Their copyright and license notices are in [shared/web/fonts/inter-LICENSE.txt](../shared/web/fonts/inter-LICENSE.txt) and [shared/web/fonts/space-grotesk-LICENSE.txt](../shared/web/fonts/space-grotesk-LICENSE.txt) and [shared/web/fonts/geist-mono-LICENSE.txt](../shared/web/fonts/geist-mono-LICENSE.txt).

The square play mark and README banner are project identity artwork. They are not codec-output previews. The website palette follows the ecnivs frame: near-black, warm charcoal, cream, ginger and bronze.
