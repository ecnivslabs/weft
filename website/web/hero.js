const artwork = document.querySelector('[data-glyph-art]');
const canvas = artwork.querySelector('canvas');
const image = artwork.querySelector('img');
const context = canvas.getContext('2d');
const width = 960, height = 720;

if (context) {
  // The detailed image is decoded SCI output, never the ingestion image.
  const loaded = image.complete ? image.naturalWidth > 0 : await new Promise(resolve => {
    image.addEventListener('load', () => resolve(true), { once: true });
    image.addEventListener('error', () => resolve(false), { once: true });
  });
  if (loaded) {
    await document.fonts.load('500 22px "Geist Mono"').catch(() => []);
    canvas.width = width;
    canvas.height = height;
    const background = getComputedStyle(document.documentElement).getPropertyValue('--background').trim();
    const sample = document.createElement('canvas');
    const brush = sample.getContext('2d', { willReadFrequently: true });
    const characters = ' .,:;il1tfLCG08@';

    function ascii(columns) {
      const rows = Math.round(columns * height / width / 1.5);
      sample.width = columns;
      sample.height = rows;
      brush.drawImage(image, 0, 0, columns, rows);
      const pixels = brush.getImageData(0, 0, columns, rows).data;
      const layer = document.createElement('canvas');
      layer.width = width;
      layer.height = height;
      const ink = layer.getContext('2d');
      ink.fillStyle = background;
      ink.fillRect(0, 0, width, height);
      ink.font = `500 ${height / rows * 0.92}px "Geist Mono", monospace`;
      ink.textAlign = 'center';
      ink.textBaseline = 'middle';
      for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) {
        const offset = (y * columns + x) * 4;
        const luminance = pixels[offset] * 0.2126 + pixels[offset + 1] * 0.7152 + pixels[offset + 2] * 0.0722;
        if (luminance < 20) continue;
        const value = Math.min(1, (luminance - 14) / 210);
        // Large characters remain unmistakably text; smaller grids recover color.
        ink.fillStyle = columns === 60 ? '#f1ece2' : `rgb(${pixels[offset]} ${pixels[offset + 1]} ${pixels[offset + 2]})`;
        const glyph = characters[Math.max(1, Math.round(Math.sqrt(value) * (characters.length - 1)))];
        ink.fillText(glyph, (x + 0.5) * width / columns, (y + 0.5) * height / rows);
      }
      return layer;
    }
    const layers = [ascii(60), ascii(120), ascii(240), image];
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    function paint(time) {
      const phase = time % 10000;
      const progress = phase < 1500 ? 0 : phase < 4500 ? (phase - 1500) / 3000 : phase < 6500 ? 1 : phase < 9500 ? 1 - (phase - 6500) / 3000 : 0;
      const level = progress * 3;
      const lower = Math.min(3, Math.floor(level));
      const fraction = level - lower;
      context.globalAlpha = 1;
      context.drawImage(layers[lower], 0, 0, width, height);
      if (fraction > 0 && lower < 3) {
        // A soft travelling front refines the same shape instead of changing it.
        const front = fraction * (width + 160) - 80;
        context.save();
        context.beginPath();
        context.rect(0, 0, Math.max(0, front - 40), height);
        context.clip();
        context.drawImage(layers[lower + 1], 0, 0, width, height);
        context.restore();
        for (let band = 0; band < 8; band++) {
          context.save();
          context.beginPath();
          context.rect(front - 40 + band * 10, 0, 10, height);
          context.clip();
          context.globalAlpha = 1 - band / 8;
          context.drawImage(layers[lower + 1], 0, 0, width, height);
          context.restore();
        }
      }
      const view = progress === 0 ? 'ascii' : progress === 1 ? 'weft' : 'transition';
      artwork.dataset.view = view;
    }
    let elapsed = 0, previous, lastPaint = 0, request;
    let visible = true;
    function frame(timestamp) {
      if (previous !== undefined) elapsed += timestamp - previous;
      previous = timestamp;
      if (timestamp - lastPaint >= 1000 / 30) {
        paint(elapsed);
        lastPaint = timestamp;
      }
      request = requestAnimationFrame(frame);
    }
    function updateMotion() {
      cancelAnimationFrame(request);
      previous = undefined;
      if (reduced.matches) paint(5000);
      else if (visible && !document.hidden) request = requestAnimationFrame(frame);
    }
    paint(reduced.matches ? 5000 : 0);
    artwork.dataset.ready = '';
    new IntersectionObserver(entries => { visible = entries[0].isIntersecting; updateMotion(); }).observe(artwork);
    reduced.addEventListener('change', updateMotion);
    document.addEventListener('visibilitychange', updateMotion);
    window.addEventListener('pagehide', () => cancelAnimationFrame(request));
    window.addEventListener('pageshow', updateMotion);
    updateMotion();
  }
}
