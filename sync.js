const KEY = 'littleFocusAppStateV2';

function push() {
  const raw = localStorage.getItem(KEY);
  if (!raw) return;
  const webData = JSON.parse(raw);
  const webTime = webData._cloudUpdatedAt || 0;

  chrome.storage.local.get(KEY).then(({ [KEY]: extData }) => {
    const extTime = (extData && extData._cloudUpdatedAt) || 0;
    // Solo push si la web es más reciente
    if (webTime > extTime) {
      chrome.storage.local.set({ [KEY]: webData });
    }
  });
}

// Extensión → Web: solo si el dato entrante es más reciente
chrome.storage.local.onChanged.addListener((changes) => {
  if (changes[KEY] && changes[KEY].newValue) {
    const incoming = changes[KEY].newValue;
    const incomingTime = incoming._cloudUpdatedAt || 0;
    const current = JSON.parse(localStorage.getItem(KEY) || '{}');
    const currentTime = current._cloudUpdatedAt || 0;

    if (incomingTime > currentTime) {
      localStorage.setItem(KEY, JSON.stringify(incoming));
      window.dispatchEvent(new CustomEvent('littleFocusSync'));
    }
  }
});

push();
setInterval(push, 3000);   