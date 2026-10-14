# Website

The public website at **weft.ecnivs.com** introduces the codec and links to documentation generated from the repository Markdown. Its copy describes the format and integration approach; release-specific settings and limits belong in the guides.

The comparison uses a four-second CC0 cartoon excerpt. Source and maximum-quality Weft output loop automatically as lossless animated WebP images, scaled equally to 400×225 at 24 FPS. Clicking either clip reveals whether it is Weft. The sides are chosen randomly on page load. Selection reveals both labels and stays visible until refresh. Reduced-motion preferences show still images instead. No playback controls, full player or source video stream are included.

The Weft images come from an actual 1080p SCI encode and decode at the source’s 24 FPS. The public page does not decode SCI. The native streaming player remains available separately. The README links matching native 1080p stills for inspecting detail. [Asset notices](../website/ASSETS.md) record preparation settings, hashes and the public-domain media dedication.

The hero continuously changes the same original woven knot from large, readable ASCII characters into detailed Weft output, then back. Intermediate character grids are prepared once in the browser. The detailed image comes from the production SCI encoder and decoder, not the source artwork. The coarse grids illustrate familiar ASCII art; they are not a separate encoder mode. The animation pauses outside the viewport and when the tab is hidden. Reduced-motion preferences and browsers without JavaScript show the detailed still.

## Build

Use Node.js 22 or newer:

```sh
npm ci --prefix website
npm run build:site --prefix website
npm run preview --prefix website
```

Open <http://127.0.0.1:8000>. Preparation does not run during the build or deployment.

The build renders every guide in `docs/`, plus SCI, contributing and media references. Markdown links between published guides become local documentation links; other repository references lead to GitHub. CSS and script URLs include content hashes to refresh browser caches after deployment. Canonical preview images live in `docs/assets/`, and the build checks their hashes, then copies an explicit list of landing-page assets into `website/dist/`. Decoder files, the native player, SCI archives and source videos are excluded from the Pages artifact. Original footage and the maximum-quality archive remain in ignored `videos/` storage. The smaller downloadable SCI fixture remains in the repository for the native player.

Verify the public site with:

```sh
npx --prefix website playwright install chromium
npm run test:site --prefix website
```

This test checks automatic image animation, persistent correct and incorrect guesses, image-load recovery, hero motion, documentation links, reduced motion and responsive layouts. Set `SCREENSHOT_DIR` to save screenshots.

## Native player

The local Rust server serves `website/web/player.html`, independently of the public landing page. It retains the Rust WebAssembly decoder, progressive SCI delivery, synchronized audio, seeking and normal playback controls. Browser integration tests exercise that player.

Build its decoder before starting the server:

```sh
rustup target add wasm32-unknown-unknown
npm run build:web --prefix website
cargo run -p weft-website --release --locked
```

## GitHub Pages

The CNAME from `weft.ecnivs.com` points to `ecnivslabs.github.io`. [website/CNAME](../website/CNAME) contains the domain. Keep the Cloudflare record set to **DNS only**, and enable HTTPS in GitHub Pages.

The [deployment workflow](../.github/workflows/deploy-website.yml) builds, tests and uploads only `website/dist/`. It runs through `workflow_dispatch`; pushes do not publish automatically. Verify the live preview after deployment.

## Theme

The page keeps the ecnivs and Pixie frame while using a glyph animation and one comparison: near-black grounds, warm charcoal, cream text, ginger accents, bronze borders and square controls. Display headings use the frame’s uppercase Inter, black outer stroke and ginger emphasis. Square bordered panels keep their paired hard shadows. Local fonts include their OFL notices. The CC0 comparison visuals require no attribution. Their original soundtrack is excluded. Third-party research media notices remain in the asset documentation.
