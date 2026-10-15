import { glyphMasks, reflectMask } from './ascii.js';

const vertex = `#version 300 es
void main() {
  vec2 position = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(position * 2.0 - 1.0, 0.0, 1.0);
}`;
const fragment = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform usampler2D attributes;
uniform usampler2D masks;
uniform int imageHeight;
uniform int cellColumns;
out vec4 color;
uint cellByte(ivec2 cell, int channel) {
  int index = (cell.y * cellColumns + cell.x) * 7 + channel / 4;
  uvec4 value = texelFetch(attributes, ivec2(index % cellColumns, index / cellColumns), 0);
  return value[channel % 4];
}
void main() {
  ivec2 pixel = ivec2(int(gl_FragCoord.x), imageHeight - 1 - int(gl_FragCoord.y));
  ivec2 cell = pixel / ivec2(3, 4);
  int scale = 1 << int(cellByte(cell, 0));
  int x = (pixel.x % 3 + int(cellByte(cell, 1)) * 3) / scale;
  int y = (pixel.y % 4 + int(cellByte(cell, 2)) * 4) / scale;
  uint bit = 1u << uint(y * 3 + x);
  uvec3 rgb = uvec3(cellByte(cell, 4), cellByte(cell, 5), cellByte(cell, 6));
  int count = int(cellByte(cell, 7));
  for (int layer = 0; layer < 4; layer++) {
    if (layer >= count) break;
    int offset = 8 + layer * 5;
    int glyph = int(cellByte(cell, offset)) - 32;
    int reflection = int(cellByte(cell, offset + 1));
    uint mask = texelFetch(masks, ivec2(glyph * 4 + reflection, 0), 0).r;
    if ((mask & bit) != 0u) rgb = uvec3(cellByte(cell, offset + 2), cellByte(cell, offset + 3), cellByte(cell, offset + 4));
  }
  color = vec4(vec3(rgb) / 255.0, 1.0);
}`;

export class AttributeUpdates {
  constructor(columns, rows) {
    if (!Number.isInteger(columns) || !Number.isInteger(rows) || columns < 1 || columns > 1365 || rows < 1 || rows > 270) throw new Error('Invalid ASCII attribute dimensions.');
    this.columns = columns; this.rows = rows; this.count = columns * rows;
    this.words = new Uint32Array(this.count * 7);
    this.bytes = new Uint8Array(this.words.buffer);
    this.tileColumns = Math.ceil(columns / 32); this.tileRows = Math.ceil(rows / 8);
    this.dirty = new Uint8Array(this.tileColumns * this.tileRows);
    this.initialized = false;
  }

  update(cells, force = false) {
    if (!(cells instanceof Uint8Array) || cells.length !== this.bytes.length) throw new Error('Invalid ASCII attribute buffer.');
    const source = cells.byteOffset % 4 ? new Uint8Array(cells) : cells;
    const words = new Uint32Array(source.buffer, source.byteOffset, source.length / 4);
    force ||= !this.initialized;
    const full = changed => {
      this.bytes.set(cells); this.initialized = true;
      return { full: true, changed, rectangles: [{ x: 0, y: 0, width: this.columns, height: this.rows }] };
    };
    if (force) return full(this.count);
    let sampled = 0; let sampledChanges = 0;
    for (let cell = 0; cell < this.count; cell += Math.max(1, Math.floor(this.count / 128))) {
      const offset = cell * 7; sampled++;
      if ((words[offset] ^ this.words[offset]) | (words[offset + 1] ^ this.words[offset + 1])
        | (words[offset + 2] ^ this.words[offset + 2]) | (words[offset + 3] ^ this.words[offset + 3])
        | (words[offset + 4] ^ this.words[offset + 4]) | (words[offset + 5] ^ this.words[offset + 5])
        | (words[offset + 6] ^ this.words[offset + 6])) sampledChanges++;
    }
    if (sampledChanges * 2 >= sampled) return full(null);
    this.dirty.fill(0);
    let changed = 0;
    for (let y = 0; y < this.rows; y++) for (let x = 0; x < this.columns; x++) {
      const index = y * this.columns + x;
      const offset = index * 7;
      if ((words[offset] ^ this.words[offset]) | (words[offset + 1] ^ this.words[offset + 1])
        | (words[offset + 2] ^ this.words[offset + 2]) | (words[offset + 3] ^ this.words[offset + 3])
        | (words[offset + 4] ^ this.words[offset + 4]) | (words[offset + 5] ^ this.words[offset + 5])
        | (words[offset + 6] ^ this.words[offset + 6])) {
        this.words.set(words.subarray(offset, offset + 7), offset);
        changed++; this.dirty[Math.floor(y / 8) * this.tileColumns + Math.floor(x / 32)] = 1;
      }
    }
    this.initialized = true;
    if (changed * 2 >= this.count) return full(changed);
    const rectangles = [];
    let previous = new Map();
    for (let y = 0; y < this.tileRows; y++) {
      const current = new Map();
      for (let x = 0; x < this.tileColumns;) {
        if (!this.dirty[y * this.tileColumns + x]) { x++; continue; }
        const first = x++;
        while (x < this.tileColumns && this.dirty[y * this.tileColumns + x]) x++;
        const left = first * 32; const width = Math.min(this.columns, x * 32) - left;
        const top = y * 8; const height = Math.min(8, this.rows - top);
        const key = `${left}:${width}`; const adjacent = previous.get(key);
        if (adjacent && adjacent.y + adjacent.height === top) { adjacent.height += height; current.set(key, adjacent); }
        else { const rectangle = { x: left, y: top, width, height }; rectangles.push(rectangle); current.set(key, rectangle); }
        if (rectangles.length > 32) return full(changed);
      }
      previous = current;
    }
    const covered = rectangles.reduce((sum, rectangle) => sum + rectangle.width * rectangle.height, 0);
    if (covered * 2 >= this.count) return full(changed);
    return { full: false, changed, rectangles };
  }
}

function validatedPlan(plan, columns, rows, force) {
  const count = columns * rows;
  if (!plan || typeof plan.full !== 'boolean' || !Array.isArray(plan.rectangles) || plan.rectangles.length > 32
    || !(plan.changed === null || (Number.isInteger(plan.changed) && plan.changed >= 0 && plan.changed <= count))) throw new Error('Invalid ASCII change plan.');
  for (const rectangle of plan.rectangles) {
    if (!rectangle || !['x', 'y', 'width', 'height'].every(key => Number.isInteger(rectangle[key]))
      || rectangle.x < 0 || rectangle.y < 0 || rectangle.width < 1 || rectangle.height < 1
      || rectangle.x + rectangle.width > columns || rectangle.y + rectangle.height > rows) throw new Error('Invalid ASCII dirty rectangle.');
  }
  if (plan.full || force) return { full: true, changed: force ? count : plan.changed, rectangles: [{ x: 0, y: 0, width: columns, height: rows }] };
  if ((plan.changed === 0) !== (plan.rectangles.length === 0) || plan.changed === null) throw new Error('Incomplete ASCII change plan.');
  return plan;
}

export class AsciiGpu {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = this.gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error('WebGL2 ASCII reconstruction is unavailable.');
    this.lost = false;
    canvas.addEventListener('webglcontextlost', () => { this.lost = true; });
    const shaders = [];
    try {
      for (const [type, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]]) {
        const shader = gl.createShader(type); shaders.push(shader);
        gl.shaderSource(shader, source); gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
      }
      this.program = gl.createProgram();
      for (const shader of shaders) gl.attachShader(this.program, shader);
      gl.linkProgram(this.program);
      if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(this.program));
      gl.useProgram(this.program);
      gl.disable(gl.DITHER); gl.disable(gl.BLEND);
      gl.uniform1i(gl.getUniformLocation(this.program, 'attributes'), 0);
      gl.uniform1i(gl.getUniformLocation(this.program, 'masks'), 1);
      this.heightLocation = gl.getUniformLocation(this.program, 'imageHeight');
      this.columnsLocation = gl.getUniformLocation(this.program, 'cellColumns');
      this.attributes = gl.createTexture(); this.masks = gl.createTexture();
      this.image = gl.createTexture(); this.framebuffer = gl.createFramebuffer();
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.masks);
      const glyphs = glyphMasks.get('ascii-3x4-v2');
      const values = new Uint16Array(95 * 4);
      for (let glyph = 32; glyph <= 126; glyph++) for (let reflection = 0; reflection < 4; reflection++) values[(glyph - 32) * 4 + reflection] = reflectMask(glyphs[glyph], reflection);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16UI, values.length, 1, 0, gl.RED_INTEGER, gl.UNSIGNED_SHORT, values);
      this.textureParameters();
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.attributes);
      this.textureParameters();
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    } catch (error) { this.close(); throw error; }
    finally { for (const shader of shaders) if (shader) gl.deleteShader(shader); }
  }

  textureParameters() {
    const gl = this.gl;
    for (const parameter of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, parameter, gl.NEAREST);
    for (const parameter of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, parameter, gl.CLAMP_TO_EDGE);
  }

  draw(cells, width, height, plan = null) {
    const gl = this.gl;
    if (this.lost || gl.isContextLost()) throw new Error('ASCII reconstruction context was lost.');
    if (!(cells instanceof Uint8Array) || !Number.isInteger(width) || !Number.isInteger(height) || width < 3 || height < 4 || width % 3 || height % 4 || width > 4096 || height > 1080 || width * height > 4423680 || cells.length !== width / 3 * (height / 4) * 28) throw new Error('Invalid ASCII GPU dimensions.');
    const columns = width / 3; const cellRows = height / 4; const rows = cellRows * 7;
    const limit = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    if (columns > limit || rows > limit || width > limit || height > limit) throw new Error('ASCII attributes exceed GPU texture limits.');
    const resize = this.canvas.width !== width || this.canvas.height !== height;
    const reallocate = this.columns !== columns || this.rows !== rows;
    const externalPlan = plan ? validatedPlan(plan, columns, cellRows, resize || reallocate) : null;
    if (resize) { this.canvas.width = width; this.canvas.height = height; }
    gl.viewport(0, 0, width, height);
    gl.useProgram(this.program); gl.uniform1i(this.heightLocation, height); gl.uniform1i(this.columnsLocation, columns);
    if (reallocate) {
      this.updates = null;
      gl.bindTexture(gl.TEXTURE_2D, this.image); this.textureParameters();
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.image, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('ASCII reconstruction framebuffer is unavailable.');
    }
    let update; let attributes;
    if (plan) {
      update = externalPlan;
      this.updates = null; attributes = cells;
    } else {
      this.updates ??= new AttributeUpdates(columns, cellRows);
      update = this.updates.update(cells, resize || reallocate); attributes = this.updates.bytes;
    }
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.attributes);
    let seededPixels = 0;
    if (!update.full && !this.retained) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      seededPixels = width * height; this.retained = true;
    }
    const ranges = [];
    for (const rectangle of update.rectangles.toSorted((a, b) => a.y - b.y)) {
      const previous = ranges.at(-1); const end = rectangle.y + rectangle.height;
      if (previous && previous.end >= rectangle.y) previous.end = Math.max(previous.end, end);
      else ranges.push({ start: rectangle.y, end });
    }
    const uploadRows = ranges.reduce((sum, range) => sum + range.end - range.start, 0);
    const fullUpload = update.full || uploadRows * 2 >= cellRows;
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    if (reallocate) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8UI, columns, rows, 0, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, attributes);
      this.columns = columns; this.rows = rows;
    } else if (fullUpload) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, columns, rows, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, attributes);
    else {
      for (const range of ranges) {
        const offset = range.start * columns * 28;
        const end = range.end * columns * 28;
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, range.start * 7, columns, (range.end - range.start) * 7, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, attributes.subarray(offset, end));
      }
    }
    const retain = !update.full || resize || reallocate;
    gl.bindFramebuffer(gl.FRAMEBUFFER, retain ? this.framebuffer : null);
    if (update.full) { gl.drawArrays(gl.TRIANGLES, 0, 3); this.retained = retain; }
    else {
      gl.enable(gl.SCISSOR_TEST);
      for (const rectangle of update.rectangles) {
        gl.scissor(rectangle.x * 3, height - (rectangle.y + rectangle.height) * 4, rectangle.width * 3, rectangle.height * 4);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      gl.disable(gl.SCISSOR_TEST);
    }
    if (retain) {
      // Bitmap transfer replaces the default image; partial updates retain a separate surface.
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.framebuffer); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
      gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    const area = update.rectangles.reduce((sum, rectangle) => sum + rectangle.width * rectangle.height, 0);
    this.metrics = { changedCells: update.changed, full: update.full, fullUpload, rectangles: update.rectangles.length, uploadedBytes: fullUpload ? cells.length : uploadRows * columns * 28, reconstructedPixels: area * 12 + seededPixels, seededPixels, retainedAttributeBytes: this.updates?.bytes.length ?? 0, retainedPixelBytes: width * height * 4 };
    if (gl.getError() !== gl.NO_ERROR) throw new Error('ASCII GPU reconstruction failed.');
  }

  close() {
    const gl = this.gl;
    if (!gl) return;
    if (this.attributes) gl.deleteTexture(this.attributes);
    if (this.masks) gl.deleteTexture(this.masks);
    if (this.image) gl.deleteTexture(this.image);
    if (this.framebuffer) gl.deleteFramebuffer(this.framebuffer);
    if (this.program) gl.deleteProgram(this.program);
    this.updates = null;
    this.lost = true;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
