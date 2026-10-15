import { Player } from './player.js';

export const player = new Player();
let sample;

async function loadSample() {
  try {
    if (!sample) {
      const response = await fetch(new URL('./sample.json', import.meta.url));
      if (!response.ok) throw new Error(`Sample metadata failed (${response.status}).`);
      const entry = await response.json();
      if (typeof entry.title !== 'string' || typeof entry.description !== 'string' || typeof entry.media !== 'string' || !entry.media.endsWith('.sci')) {
        throw new Error('Invalid SCI sample metadata.');
      }
      sample = entry;
    }
    document.querySelector('#video-title').textContent = sample.title;
    document.querySelector('#video-details').textContent = sample.description;
    document.querySelector('#download-sample').href = sample.media;
    player.load(sample);
  } catch (error) {
    player.message(error.message, true);
  }
}

document.querySelector('#retry').addEventListener('click', loadSample);
window.addEventListener('pagehide', () => player.reset());
window.addEventListener('pageshow', event => { if (event.persisted) loadSample(); });
loadSample();
