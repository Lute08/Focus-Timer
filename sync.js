const KEY = 'littleFocusAppStateV2';

// Web → Extensión: copia localStorage a chrome.storage.local
function push() {
  const data = localStorage.getItem(KEY);
  if (data) {
    chrome.storage.local.set({ [KEY]: JSON.parse(data) });
  }
}

// Extensión → Web: cuando el popup cambia datos, escribe en localStorage
// (la web lo detecta en su propio setInterval, NO hace falta recargar)
chrome.storage.local.onChanged.addListener((changes) => {
  if (changes[KEY] && changes[KEY].newValue) {
    const current = localStorage.getItem(KEY);
    const incoming = JSON.stringify(changes[KEY].newValue);
    if (current !== incoming) {
      localStorage.setItem(KEY, incoming);
      // Notificar a la web para que se actualice sin recargar
      window.dispatchEvent(new CustomEvent('littleFocusSync'));
    }
  }
});

push();
setInterval(push, 3000);   