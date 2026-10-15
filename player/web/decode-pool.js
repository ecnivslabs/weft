import { WorkerDecoder } from './worker.js';

let compiled;
export function decoderModule() {
  if (!compiled) compiled = (async () => {
    const response = await fetch(new URL('./decoder.wasm', import.meta.url));
    if (!response.ok) throw new Error('SCI decoder is missing. Run npm run build --prefix player.');
    return WebAssembly.compile(await response.arrayBuffer());
  })().catch(error => { compiled = null; throw error; });
  return compiled;
}

export function independent(tag) { return [4, 6, 8].includes(tag); }

export function partition(packets, position) {
  if (!Array.isArray(packets) || packets.length < 1 || packets.length > 240) throw new Error('Invalid SCI packet sequence.');
  const segments = [];
  for (let first = 0; first < packets.length;) {
    if (!independent(packets[first].tag)) throw new Error('SCI dependency has no independent frame.');
    let last = first + 1;
    while (last < packets.length && !independent(packets[last].tag)) last++;
    const final = packets[last - 1];
    if ((final.end ?? final.time + final.duration) > position) segments.push({ packets, first, last, next: first });
    first = last;
  }
  return segments;
}

export class DecoderPool {
  constructor(count, options, { accept, reserve, release, complete, fail, paint = () => true, decide = () => undefined }, factory = options => new WorkerDecoder(options)) {
    if (!Number.isInteger(count) || count < 1 || count > 4) throw new Error('Invalid SCI decoder count.');
    this.slots = Array.from({ length: count }, (_, id) => ({ id, decoder: factory(options), segment: null, busy: false }));
    this.pending = [];
    Object.assign(this, { accept, reserve, release, complete, fail, paint, decide });
    this.closed = false;
  }

  add(segments) {
    if (this.closed) throw new DOMException('Stream closed.', 'AbortError');
    if (!Array.isArray(segments) || this.pending.length + segments.length > 32768) throw new Error('SCI dependency queue limit exceeded.');
    this.pending.push(...segments);
    this.pending.sort((a, b) => a.packets[a.next].time - b.packets[b.next].time);
  }

  async prepare(width, height) {
    await Promise.all(this.slots.map(slot => slot.decoder.prepare?.(width, height)));
    if (this.closed) throw new DOMException('Stream closed.', 'AbortError');
  }

  pump(position, horizon, width, height, format, font) {
    if (this.closed) return;
    this.position = position; this.horizon = horizon;
    this.dimensions = { width, height, format, font };
    // A dependent sequence retains one decoder until its last reference is consumed.
    for (const slot of this.slots) if (!slot.segment && this.pending.length) slot.segment = this.pending.shift();
    const candidates = this.slots.filter(slot => slot.segment && !slot.busy)
      .sort((a, b) => a.segment.packets[a.segment.next].time - b.segment.packets[b.segment.next].time);
    for (const slot of candidates) {
      const segment = slot.segment; const packet = segment.packets[segment.next];
      const present = this.paint(packet);
      if (packet.time > horizon || !this.reserve(packet, present)) continue;
      slot.busy = true;
      const started = performance.now();
      let decision;
      try { decision = this.decide(packet, width, height, format, present); }
      catch (error) { slot.busy = false; this.release(packet, present); this.close(); this.fail(error); return; }
      slot.decoder.decode(packet, width, height, format, segment.next === segment.first, font, present, decision).then(frame => {
        if (this.closed) frame.bitmap?.close();
        else this.accept({ ...frame, workerId: slot.id }, packet, performance.now() - started);
        segment.next++;
        if (segment.next === segment.last) { slot.segment = null; this.complete(segment); }
      }).catch(error => { if (!this.closed) { this.close(); this.fail(error); } }).finally(() => {
        slot.busy = false; this.release(packet, present);
        if (!this.closed) {
          const { width, height, format, font } = this.dimensions;
          this.pump(this.position, this.horizon, width, height, format, font);
        }
      });
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const slot of this.slots) { slot.decoder.close(); slot.segment = null; }
    this.pending = [];
  }
}
