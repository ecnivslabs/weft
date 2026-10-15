export const CACHE_BYTES = 64 * 1024 * 1024;
export const REQUEST_BYTES = 48 * 1024 * 1024;
export const MAX_REQUESTS = 8;
export const MAX_RECORDS = 128;
export const MAX_WINDOW_CHUNKS = 64;
export const FRAME_BYTES = 32 * 1024 * 1024;
export const DECODER_BYTES = 384 * 1024 * 1024;

export function audioBytes(record, sampleRate = 48000) {
  return Math.ceil((record.decoded / 48000 + 0.06) * sampleRate) * 2 * 4;
}

export function deliveryWindow(reader, quality, position, rate = 1) {
  const timeline = reader.timelines.get(quality);
  if (!timeline?.length || !Number.isFinite(position) || !Number.isFinite(rate) || rate <= 0) throw new Error('Invalid SCI delivery window.');
  const first = reader.recordAt(quality, position).chunk;
  const target = position + Math.min(3, 0.75 * rate);
  let last = first; let bytes = 0;
  for (let chunk = first; chunk < timeline.length && chunk < first + MAX_WINDOW_CHUNKS; chunk++) {
    const video = timeline[chunk];
    const audio = reader.metadata.audio ? reader.records.get(`0:${chunk}`) : null;
    const cost = video.length + (audio ? audioBytes(audio, reader.audio?.sampleRate) : 0);
    if (chunk > first && bytes + cost > CACHE_BYTES) break;
    bytes += cost; last = chunk;
    if (video.end >= target) break;
  }
  return { quality, first, last, end: timeline[last].end, bytes };
}

export function decoderCount(width, height, hardware = 2) {
  const pixels = width * height;
  const cells = pixels / 12;
  const workingBytes = 16 * 1024 * 1024 + 2 * (cells * 38 + 1024) + cells * 28 * 4 + pixels * 4 * 5;
  return Math.max(1, Math.min(4, Math.floor(hardware) || 1, Math.floor(FRAME_BYTES / (pixels * 4)), Math.floor(DECODER_BYTES / workingBytes)));
}

export function presentationRate(signal) {
  if (typeof requestAnimationFrame !== 'function' || globalThis.document?.hidden || signal.aborted) return Promise.resolve(Infinity);
  return new Promise(resolve => {
    const timestamps = []; let animation; let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true; clearTimeout(timer); cancelAnimationFrame(animation); signal.removeEventListener('abort', finish);
      const intervals = timestamps.slice(1).map((time, index) => time - timestamps[index]).filter(value => value > 0 && value < 100).sort((a,b)=>a-b);
      resolve(intervals.length >= 8 ? 1000 / intervals[Math.floor(intervals.length/2)] : Infinity);
    };
    const step = timestamp => { timestamps.push(timestamp); if (timestamps.length === 13) finish(); else animation = requestAnimationFrame(step); };
    const timer = setTimeout(finish, 500); signal.addEventListener('abort', finish, {once:true});
    animation = requestAnimationFrame(step);
  });
}

export function shouldPaint(packet, position, duration, sourceFps, rate, displayRate, initial = false) {
  const end = packet.end ?? packet.time + packet.duration;
  if (end <= position) return false;
  if ((initial && packet.time <= position) || end >= duration - 1e-9 || !Number.isFinite(displayRate) || sourceFps * rate <= displayRate * 1.01) return true;
  const interval = rate / displayRate;
  return Math.floor((packet.time + 1e-9) / interval) !== Math.floor((end + 1e-9) / interval);
}
