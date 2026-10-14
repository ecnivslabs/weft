const comparison = document.querySelector('[data-comparison]');
const choices = [...comparison.querySelectorAll('[data-choice]')];
const status = comparison.querySelector('[role="status"]');
const media = JSON.parse(comparison.dataset.media);
const answer = crypto.getRandomValues(new Uint8Array(1))[0] % choices.length;
let selected = false;
let loading = false;
let failures = 0;
let retryTimer;

function waitForImage(image) {
  return new Promise((resolve, reject) => {
    const finish = () => {
      image.removeEventListener('load', finish);
      image.removeEventListener('error', finish);
      if (image.naturalWidth > 0) resolve();
      else reject(new Error('Preview image failed to load.'));
    };
    image.addEventListener('load', finish);
    image.addEventListener('error', finish);
    if (image.complete) finish();
  });
}

function assignMedia(choice, retry = 0) {
  const entry = media[choice.dataset.clip];
  const url = value => {
    const result = new URL(value, location.href);
    if (retry) result.searchParams.set('retry', String(retry));
    return result.href;
  };
  choice.querySelector('source').srcset = url(entry.poster);
  choice.querySelector('img').src = url(entry.animation);
}

async function prepare() {
  if (selected || loading) return;
  loading = true;
  clearTimeout(retryTimer);
  status.textContent = failures ? 'Couldn’t load both clips. Retrying…' : 'Loading comparison…';
  if (failures) {
    for (const choice of choices) {
      const image = choice.querySelector('img');
      if (image.complete && !image.naturalWidth) assignMedia(choice, failures);
    }
  }
  await new Promise(requestAnimationFrame);
  const results = await Promise.allSettled(choices.map(choice => waitForImage(choice.querySelector('img'))));
  loading = false;
  if (selected) return;
  if (results.every(result => result.status === 'fulfilled')) {
    failures = 0;
    choices.forEach(choice => { choice.disabled = false; });
    status.textContent = 'Choose the clip you think is Weft';
  } else if (++failures <= 3) {
    status.textContent = 'Couldn’t load both clips. Retrying…';
    retryTimer = setTimeout(prepare, 2500);
  } else {
    status.textContent = 'Couldn’t load both clips. Refresh to try again.';
  }
}

choices.forEach((choice, index) => {
  choice.dataset.clip = index === answer ? 'weft' : 'source';
  choice.querySelector('img').alt = `Animated clip ${index === 0 ? 'A' : 'B'}`;
  assignMedia(choice);
  choice.addEventListener('click', () => {
    if (selected || choice.disabled) return;
    selected = true;
    clearTimeout(retryTimer);
    const correct = index === answer;
    comparison.classList.add('is-revealed');
    comparison.dataset.result = correct ? 'correct' : 'incorrect';
    choices.forEach((option, position) => {
      const name = position === answer ? 'Weft' : 'Source';
      option.disabled = true;
      option.querySelector('[data-label]').textContent = name;
      option.querySelector('img').alt = `${name} animation`;
      option.setAttribute('aria-label', `${name}${position === index ? ', your pick' : ''}`);
      if (position === index) {
        option.dataset.result = correct ? 'correct' : 'incorrect';
        option.querySelector('[data-picked]').hidden = false;
      }
    });
    const title = document.createElement('strong');
    title.textContent = correct ? 'Correct, that’s Weft' : 'Incorrect, that’s the source';
    const detail = document.createElement('span');
    detail.textContent = `${correct ? '' : 'The other clip is Weft. '}Refresh to try again.`;
    status.replaceChildren(title, detail);
  });
});

window.addEventListener('pagehide', () => clearTimeout(retryTimer));
window.addEventListener('pageshow', event => { if (event.persisted && !selected) prepare(); });
window.addEventListener('online', () => { if (!selected) prepare(); });
prepare();
