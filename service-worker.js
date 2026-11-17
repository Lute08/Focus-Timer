
const ALARM_PREFIX = 'little-focus-';
let creatingOffscreen;

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL('offscreen.html')]
  });
  if (contexts.length) return;
  if (creatingOffscreen) return creatingOffscreen;
  creatingOffscreen = chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['AUDIO_PLAYBACK'],
    justification: 'Reproducir el sonido elegido cuando termina un temporizador, aunque el panel no esté abierto.'
  });
  try { await creatingOffscreen; } finally { creatingOffscreen = null; }
}

async function syncTimers(sessions, sound='chime') {
  await chrome.storage.local.set({timerSessions: sessions || {}, endSound: sound});
  for (const mode of ['study','break']) {
    const name = ALARM_PREFIX + mode;
    const session = sessions && sessions[mode];
    if (session && session.running && Number(session.endAt) > Date.now()) {
      await chrome.alarms.create(name, {when: Number(session.endAt)});
    } else {
      await chrome.alarms.clear(name);
    }
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'sync-timers') {
    syncTimers(message.sessions, message.sound).then(()=>sendResponse({ok:true})).catch(()=>sendResponse({ok:false}));
    return true;
  }
});

chrome.alarms.onAlarm.addListener(async alarm => {
  if (!alarm.name.startsWith(ALARM_PREFIX)) return;
  const mode = alarm.name.slice(ALARM_PREFIX.length);
  const {timerSessions={}, endSound='chime'} = await chrome.storage.local.get(['timerSessions','endSound']);
  const session = timerSessions[mode];
  if (!session || !session.running || !Number.isFinite(Number(session.endAt))) return;
  const remaining = Number(session.endAt) - Date.now();
  if (remaining > 0) {
    await chrome.alarms.create(alarm.name, {when: Number(session.endAt)});
    return;
  }
  session.running = false;
  session.endAt = null;
  session.remaining = 0;
  timerSessions[mode] = session;
  await chrome.storage.local.set({timerSessions});
  chrome.notifications.create('little-focus-'+mode, {
    type:'basic',
    iconUrl:'icon-192.png',
    title:'Little Focus',
    message: mode === 'study' ? '¡Ha terminado el tiempo de estudio!' : '¡Ha terminado el descanso!',
    priority:2
  });
  if (endSound !== 'none') {
    try {
      await ensureOffscreen();
      await chrome.runtime.sendMessage({target:'offscreen', type:'play-end-sound', sound:endSound});
    } catch (e) {}
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  const {timerSessions={}, endSound='chime'} = await chrome.storage.local.get(['timerSessions','endSound']);
  await syncTimers(timerSessions,endSound);
});
chrome.runtime.onStartup.addListener(async () => {
  const {timerSessions={}, endSound='chime'} = await chrome.storage.local.get(['timerSessions','endSound']);
  await syncTimers(timerSessions,endSound);
});
