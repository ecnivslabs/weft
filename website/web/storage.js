export function readStored(key, fallback) {
  try { return JSON.parse(localStorage.getItem(`weft:${key}`)) ?? fallback; }
  catch { return fallback; }
}

export function store(key, value) {
  try { localStorage.setItem(`weft:${key}`, JSON.stringify(value)); }
  catch { /* Playback remains available when browser storage is blocked or full. */ }
}
