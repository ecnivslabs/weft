export class PixelRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.context = canvas.getContext('2d', { alpha: false });
    this.image = null;
  }

  draw(frame) {
    if (frame.bitmap || frame.pixels) {
      if (this.canvas.width !== frame.width || this.canvas.height !== frame.height) {
        this.canvas.width = frame.width; this.canvas.height = frame.height; this.image = null;
      }
      if (frame.bitmap) { this.context.drawImage(frame.bitmap, 0, 0); frame.bitmap.close(); }
      else {
        if (frame.pixels.length !== frame.width * frame.height * 4) throw new Error('Invalid SCI pixels.');
        if (!this.image) this.image = this.context.createImageData(frame.width, frame.height);
        this.image.data.set(frame.pixels); this.context.putImageData(this.image, 0, 0);
      }
      return;
    }
    throw new Error('SCI rendering requires reconstructed pixels or a bitmap.');
  }

  clear() {
    this.context.fillStyle = '#000';
    this.context.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }
}
