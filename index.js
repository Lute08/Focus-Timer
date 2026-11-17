const STORAGE_KEY = 'littleFocusAppStateV2';
const DEFAULT_TRACKS = [
  { id: 'MYPVQccHhAQ', name: 'Música cozy · ambiente tranquilo' },
  { id: 'J84Dq4dIHUQ', name: 'Ruido marrón · concentración' },
  { id: 'CHFif_y2TyM', name: 'Lluvia y tormenta · sonidos de lluvia' },
  { id: 'bGvAXu7P9Sw', name: 'ASMR · sonidos suaves' }
];

const display = document.getElementById('display');
const statusEl = document.getElementById('status');
const startBtn = document.getElementById('startPause');
const studyTab = document.getElementById('studyTab');
const breakTab = document.getElementById('breakTab');
const themeToggle = document.getElementById('themeToggle');

function freshState() {
  return {
    durations: { study: 25, break: 5 },
    mode: 'study',
    remaining: 25 * 60,
    theme: 'day',
    playlists: [{ id: 'default', name: 'Ambientes', tracks: DEFAULT_TRACKS.map(t => ({...t})) }],
    selectedPlaylistId: 'default',
    currentTrackIndex: 0,
    currentVideoId: DEFAULT_TRACKS[0].id,
    currentVideoName: DEFAULT_TRACKS[0].name,
    language: 'es', backgroundColor: '#f3eee5', endSound: 'chime', activity: {}, notes: []
  };
}

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!saved || typeof saved !== 'object') return freshState();
    const base = freshState();
    const state = {
      ...base,
      ...saved,
      durations: {...base.durations, ...(saved.durations || {})},
      playlists: Array.isArray(saved.playlists) && saved.playlists.length
        ? saved.playlists.filter(p => p && typeof p.id === 'string' && Array.isArray(p.tracks))
        : base.playlists
    };
    state.durations.study = clampNumber(state.durations.study, 1, 180, 25);
    state.durations.break = clampNumber(state.durations.break, 1, 180, 5);
    state.mode = state.mode === 'break' ? 'break' : 'study';
    state.remaining = clampNumber(state.remaining, 0, 180 * 60, state.durations[state.mode] * 60);
    state.theme = state.theme === 'night' ? 'night' : 'day';
    state.language = ['es','en','zh'].includes(state.language) ? state.language : 'es';
    state.backgroundColor = typeof state.backgroundColor === 'string' && /^#[0-9a-f]{6}$/i.test(state.backgroundColor) ? state.backgroundColor : base.backgroundColor;
    state.activity = state.activity && typeof state.activity === 'object' ? state.activity : {};
    state.notes = Array.isArray(state.notes) ? state.notes.filter(n => n && typeof n.id === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(n.date)) : [];
    if (!state.playlists.length) state.playlists = base.playlists;
    // Recupera los cuatro ambientes originales en la lista predeterminada
    // para usuarios que ya tenían datos guardados de una versión anterior.
    if (!saved.defaultTracksRestoredV1) {
      let defaultList = state.playlists.find(p => p.id === 'default');
      if (!defaultList) {
        defaultList = { id: 'default', name: 'Ambientes', tracks: [] };
        state.playlists.unshift(defaultList);
      }
      DEFAULT_TRACKS.forEach(track => {
        if (!defaultList.tracks.some(existing => existing.id === track.id)) {
          defaultList.tracks.push({...track});
        }
      });
      state.defaultTracksRestoredV1 = true;
    }
    if (!state.playlists.some(p => p.id === state.selectedPlaylistId)) state.selectedPlaylistId = state.playlists[0].id;
    return state;
  } catch (e) {
    return freshState();
  }
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

let state = loadState();
// Dos sesiones independientes: Estudio y Descanso pueden seguir contando
// simultáneamente; solo se muestra la sesión de la pestaña seleccionada.
const timerSessions = (() => {
  const saved = state.timerSessions || {};
  const make = mode => {
    const item = saved[mode] || {};
    return {
      remaining: clampNumber(item.remaining, 0, 180*60,
        mode === state.mode ? state.remaining : state.durations[mode]*60),
      running: item.running === true,
      endAt: Number.isFinite(Number(item.endAt)) && item.running === true ? Number(item.endAt) : null
    };
  };
  const sessions = {study:make('study'), break:make('break')};
  // Migra una cuenta activa guardada por versiones anteriores.
  if (!state.timerSessions && state.timerRunning && Number(state.timerEndAt) > Date.now()) {
    sessions[state.mode] = {
      remaining: Math.max(0, Math.ceil((Number(state.timerEndAt)-Date.now())/1000)),
      running: true,
      endAt: Number(state.timerEndAt)
    };
  }
  return sessions;
})();
let interval = null;
let running = false;
let endAt = null;
let alarmAudioContext = null;
let scheduledAlarmNodes = [];
let alarmScheduled = false;
let customEndSoundBuffer = null;

function saveState() {
  try {
    state.timerSessions = {
      study: {...timerSessions.study},
      break: {...timerSessions.break}
    };
    state.timerRunning = Object.values(timerSessions).some(session => session.running);
    state.timerEndAt = timerSessions[state.mode].endAt;
    state._cloudUpdatedAt = Date.now();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    if (window.LittleFocusCloud) LittleFocusCloud.schedule(state);
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
      try {
        chrome.runtime.sendMessage({
          type: 'sync-timers',
          sessions: state.timerSessions,
          sound: state.endSound || 'chime'
        }).catch(()=>{});
      } catch (e) {}
    }
  } catch (e) {
    // The app remains usable if browser storage is unavailable.
  }
}

function getSelectedPlaylist() {
  return state.playlists.find(p => p.id === state.selectedPlaylistId) || state.playlists[0];
}

function syncSelectedTimer() {
  const session = timerSessions[state.mode];
  state.remaining = session.remaining;
  running = session.running;
  endAt = session.endAt;
}
function ensureTimerInterval() {
  const anyRunning = Object.values(timerSessions).some(session => session.running);
  if (anyRunning && interval === null) interval = setInterval(tick, 250);
  if (!anyRunning && interval !== null) { clearInterval(interval); interval = null; }
}
function renderTimer() {
  syncSelectedTimer();
  const m = Math.floor(state.remaining / 60);
  const s = state.remaining % 60;
  display.textContent = String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  document.title = display.textContent + ' — Little Focus';
  document.getElementById('modeLabel').textContent = tr(state.mode === 'study' ? 'studyTime' : 'breakTime');
  studyTab.classList.toggle('active', state.mode === 'study');
  breakTab.classList.toggle('active', state.mode === 'break');
  document.getElementById('studyValue').textContent = state.durations.study + ' min';
  document.getElementById('breakValue').textContent = state.durations.break + ' min';
  startBtn.textContent = running ? tr('pause') : tr('start');
}
function stopTimer(options={}) {
  const session = timerSessions[state.mode];
  session.running = false;
  session.endAt = null;
  if (options.reset !== true) session.remaining = state.remaining;
  state.timerRunning = Object.values(timerSessions).some(item => item.running);
  state.timerEndAt = session.endAt;
  ensureTimerInterval();
  if(options.cancelAlarm!==false) clearScheduledAlarm();
}

let customEndSoundUrl = null;
let customEndSoundAudio = null;
async function restoreCustomEndSound(){
  try{
    const db=await openAssetDB();
    const blob=await new Promise((resolve,reject)=>{
      const tx=db.transaction(DB_STORE,'readonly'),req=tx.objectStore(DB_STORE).get('custom-end-sound');
      req.onsuccess=()=>resolve(req.result||null);req.onerror=()=>reject(req.error);
    });
    db.close();
    if(blob){
      customEndSoundUrl=URL.createObjectURL(blob);
      customEndSoundAudio=new Audio(customEndSoundUrl);
      customEndSoundAudio.preload='auto';
      const AudioContextClass=window.AudioContext||window.webkitAudioContext;
      if(AudioContextClass){
        const ctx=getAlarmAudioContext();
        customEndSoundBuffer=await ctx.decodeAudioData(await blob.arrayBuffer());
      }
    }
  }catch(e){console.warn('No se pudo recuperar el sonido personalizado',e);}
}
function getAlarmAudioContext(){
  if(!alarmAudioContext){
    const AudioContextClass=window.AudioContext||window.webkitAudioContext;
    if(AudioContextClass) alarmAudioContext=new AudioContextClass();
  }
  return alarmAudioContext;
}
function clearScheduledAlarm(){
  scheduledAlarmNodes.forEach(node=>{try{node.stop();}catch(e){}});
  scheduledAlarmNodes=[];
  alarmScheduled=false;
}
function scheduleEndSound(){
  clearScheduledAlarm();
  const ctx=getAlarmAudioContext();
  if(!ctx || (state.endSound||'chime')==='none') return;
  const kind=state.endSound||'chime';
  const when=ctx.currentTime+Math.max(0.08,state.remaining);
  const master=ctx.createGain();
  master.gain.setValueAtTime(0.0001,when);
  master.gain.linearRampToValueAtTime(0.72,when+0.035);
  master.connect(ctx.destination);
  if(kind==='custom' && customEndSoundBuffer){
    const source=ctx.createBufferSource();source.buffer=customEndSoundBuffer;
    source.connect(master);source.start(when);scheduledAlarmNodes.push(source);
    master.gain.setValueAtTime(0.72,when);
    master.gain.setTargetAtTime(0.0001,when+Math.max(0.5,customEndSoundBuffer.duration-0.25),0.18);
  }else{
    const patterns={
      bell:[{f:880,t:0,d:1.45},{f:1320,t:0.12,d:1.25}],
      digital:[{f:660,t:0,d:.48},{f:880,t:.55,d:.48},{f:660,t:1.1,d:.48},{f:990,t:1.65,d:.8}],
      nature:[{f:1500,t:0,d:.22},{f:2050,t:.28,d:.22},{f:1700,t:.58,d:.22},{f:2250,t:.9,d:.3},{f:1850,t:1.3,d:.25}],
      chime:[{f:660,t:0,d:.55},{f:880,t:.48,d:.65},{f:1046,t:1.02,d:.8},{f:880,t:1.8,d:.75},{f:1046,t:2.5,d:1.1}]
    };
    const pattern=patterns[kind]||patterns.chime;
    pattern.forEach(note=>{
      const osc=ctx.createOscillator(),gain=ctx.createGain();
      osc.type=kind==='digital'?'triangle':'sine';osc.frequency.setValueAtTime(note.f,when+note.t);
      gain.gain.setValueAtTime(0.0001,when+note.t);
      gain.gain.exponentialRampToValueAtTime(kind==='digital'?0.34:0.42,when+note.t+0.025);
      gain.gain.exponentialRampToValueAtTime(0.0001,when+note.t+note.d);
      osc.connect(gain);gain.connect(master);osc.start(when+note.t);osc.stop(when+note.t+note.d+0.03);
      scheduledAlarmNodes.push(osc);
    });
    master.gain.setValueAtTime(0.72,when);
    master.gain.setTargetAtTime(0.0001,when+3.3,0.35);
  }
  scheduledAlarmNodes.push(master);
  alarmScheduled=true;
}
function playSynthSound(kind){
  const ctx=getAlarmAudioContext();if(!ctx)return;
  ctx.resume().then(()=>{
    const notes=kind==='nature'?[1500,2050,1700,2250]:kind==='bell'?[880,1320]:kind==='digital'?[660,880,660,990]:[660,880,1046,880,1046];
    const durations=kind==='bell'?[1.3,1.1]:kind==='digital'?[.42,.42,.42,.7]:kind==='nature'?[.25,.25,.25,.3]:[.5,.6,.75,.7,1];
    let offset=0;
    notes.forEach((frequency,i)=>{
      const osc=ctx.createOscillator(),gain=ctx.createGain();
      osc.type=kind==='digital'?'triangle':'sine';osc.frequency.value=frequency;
      gain.gain.setValueAtTime(0.0001,ctx.currentTime+offset);
      gain.gain.exponentialRampToValueAtTime(0.42,ctx.currentTime+offset+.025);
      gain.gain.exponentialRampToValueAtTime(0.0001,ctx.currentTime+offset+durations[i]);
      osc.connect(gain);gain.connect(ctx.destination);osc.start(ctx.currentTime+offset);osc.stop(ctx.currentTime+offset+durations[i]+.03);
      offset+=kind==='digital'?.52:kind==='nature'?.31:.48;
    });
  }).catch(()=>{});
}
function playEndSound(){
  const kind=state.endSound||'chime';
  if(kind==='none')return;
  if(kind==='custom'&&customEndSoundAudio){
    customEndSoundAudio.volume=1;customEndSoundAudio.currentTime=0;customEndSoundAudio.play().catch(()=>{});
    return;
  }
  playSynthSound(kind);
}
document.getElementById('endSoundSelect').value=state.endSound||'chime';
document.getElementById('endSoundSelect').addEventListener('change',e=>{
  state.endSound=e.target.value;saveState();
});
document.getElementById('endSoundUpload').addEventListener('change',async e=>{
  const file=e.target.files&&e.target.files[0];if(!file)return;
  if(!file.type.startsWith('audio/')){e.target.value='';return;}
  try{
    const db=await openAssetDB();
    await new Promise((resolve,reject)=>{
      const tx=db.transaction(DB_STORE,'readwrite');tx.objectStore(DB_STORE).put(file,'custom-end-sound');
      tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);
    });db.close();
    if(customEndSoundUrl)URL.revokeObjectURL(customEndSoundUrl);
    customEndSoundUrl=URL.createObjectURL(file);customEndSoundAudio=new Audio(customEndSoundUrl);customEndSoundAudio.preload='auto';
    try{const ctx=getAlarmAudioContext();if(ctx)customEndSoundBuffer=await ctx.decodeAudioData(await file.arrayBuffer());}catch(e){customEndSoundBuffer=null;}
    state.endSound='custom';document.getElementById('endSoundSelect').value='custom';saveState();
  }catch(err){alert('No se ha podido guardar el archivo de audio.');}
  e.target.value='';
});
document.getElementById('previewEndSound').addEventListener('click',()=>{
  if((state.endSound||'chime')==='custom'&&customEndSoundAudio){
    customEndSoundAudio.currentTime=0;customEndSoundAudio.play().catch(()=>alert('No se ha podido reproducir el archivo de audio.'));
  }else playEndSound();
});

function tick() {
  const now = Date.now();
  let completed = [];
  for (const mode of ['study','break']) {
    const session = timerSessions[mode];
    if (!session.running || session.endAt === null) continue;
    session.remaining = Math.max(0, Math.ceil((session.endAt - now) / 1000));
    if (session.remaining <= 0) {
      session.running = false;
      session.endAt = null;
      completed.push(mode);
    }
  }
  if (completed.length) {
    for (const mode of completed) {
      if (mode === 'study') recordStudyDay();
      if (state.mode === mode) statusEl.textContent = mode === 'study' ? tr('studyDone') : tr('breakDone');
      if (!(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id)) playEndSound();
      try {
        if (!(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) && 'Notification' in window && Notification.permission === 'granted') {
          new Notification('Little Focus', {body: mode === 'study' ? tr('studyDone') : tr('breakDone'), tag:'little-focus-timer-'+mode});
        }
      } catch(e) {}
    }
  }
  syncSelectedTimer();
  ensureTimerInterval();
  renderTimer();
  saveState();
}
async function toggleTimer() {
  const session = timerSessions[state.mode];
  if (session.running) {
    session.remaining = Math.max(0, Math.ceil((session.endAt - Date.now()) / 1000));
    session.running = false;
    session.endAt = null;
    statusEl.textContent = tr('paused');
  } else {
    if (session.remaining <= 0) session.remaining = state.durations[state.mode] * 60;
    if ('Notification' in window && Notification.permission === 'default') {
      try { Notification.requestPermission().catch(()=>{}); } catch(e) {}
    }
    if ((state.endSound || 'chime') === 'custom' && !customEndSoundBuffer) await restoreCustomEndSound();
    const ctx = getAlarmAudioContext();
    if (ctx) { try { await ctx.resume(); } catch(e) {} }
    session.running = true;
    session.endAt = Date.now() + session.remaining * 1000;
    statusEl.textContent = state.mode === 'study' ? tr('focusNow') : tr('restNow');
    ensureTimerInterval();
  }
  syncSelectedTimer();
  renderTimer();
  saveState();
}
function selectMode(next) {
  // Cada modo conserva su propio temporizador. Al cambiar de pestaña,
  // el anterior sigue contando en segundo plano sin superponerse al nuevo.
  state.mode = next;
  const session = timerSessions[next];
  if (session.running) statusEl.textContent = next === 'study' ? tr('focusNow') : tr('restNow');
  else statusEl.textContent = next === 'study' ? tr('readyStudy') : tr('takeBreak');
  syncSelectedTimer();
  renderTimer();
  saveState();
}

startBtn.addEventListener('click', toggleTimer);
document.getElementById('reset').addEventListener('click', () => {
  const session = timerSessions[state.mode];
  session.running = false;
  session.endAt = null;
  session.remaining = state.durations[state.mode] * 60;
  statusEl.textContent = tr('resetDone');
  ensureTimerInterval();
  syncSelectedTimer();
  renderTimer();
  saveState();
});
studyTab.addEventListener('click', () => selectMode('study'));
breakTab.addEventListener('click', () => selectMode('break'));

document.querySelectorAll('[data-target]').forEach(btn => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.target;
    state.durations[target] = Math.max(1, Math.min(180, state.durations[target] + Number(btn.dataset.delta)));
    const session = timerSessions[target];
    if (!session.running) session.remaining = state.durations[target] * 60;
    if (state.mode === target) {
      syncSelectedTimer();
      statusEl.textContent = 'Duración actualizada';
    }
    renderTimer();
    saveState();
  });
});

let currentMusicState=-1;
function setMusicStatus(key){const el=document.getElementById('musicStatus');if(el)el.textContent=tr(key);}
function youtubeCommand(func,args=[]){
  const frame=document.querySelector('#videoFrame iframe');
  if(!frame?.contentWindow)return;
  frame.contentWindow.postMessage(JSON.stringify({event:'command',func,args}), 'https://www.youtube-nocookie.com');
}
function loadVideo(id, caption) {
  const frame=document.getElementById('videoFrame');
  const iframe=document.createElement('iframe');
  iframe.id='musicPlayer';
  const origin=location.origin;
  iframe.src='https://www.youtube-nocookie.com/embed/'+encodeURIComponent(id)+'?rel=0&enablejsapi=1&playsinline=1&origin='+encodeURIComponent(origin);
  iframe.title=caption;
  iframe.allow='accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
  iframe.referrerPolicy='strict-origin-when-cross-origin';iframe.allowFullscreen=true;
  frame.replaceChildren(iframe);document.getElementById('musicCaption').textContent=caption;
  currentMusicState=-1;setMusicStatus('musicReady');
}

function showTrack(index) {
  const playlist = getSelectedPlaylist();
  if (!playlist || !playlist.tracks.length) {
    document.getElementById('musicCaption').textContent = 'Esta lista todavía no tiene vídeos.';
    document.getElementById('trackPosition').textContent = '0 / 0';
    return;
  }
  state.currentTrackIndex = (index + playlist.tracks.length) % playlist.tracks.length;
  const track = playlist.tracks[state.currentTrackIndex];
  state.currentVideoId = track.id;
  state.currentVideoName = track.name;
  loadVideo(track.id, track.name);
  document.getElementById('trackPosition').textContent =
    (state.currentTrackIndex + 1) + ' / ' + playlist.tracks.length;
  saveState();
}

document.getElementById('previousTrack').addEventListener('click', () => showTrack(state.currentTrackIndex - 1));
document.getElementById('nextTrack').addEventListener('click', () => showTrack(state.currentTrackIndex + 1));

function getVideoId(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    if (host === 'youtu.be') return u.pathname.slice(1).split('/')[0];
    if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtube-nocookie.com') {
      if (u.pathname === '/watch') return u.searchParams.get('v');
      const parts = u.pathname.split('/').filter(Boolean);
      if (['embed', 'shorts', 'live'].includes(parts[0])) return parts[1];
    }
  } catch (e) {}
  return null;
}

function validVideoFromInput(input) {
  const id = getVideoId(input);
  return id && /^[\w-]{11}$/.test(id) ? id : null;
}

function setTheme(theme) {
  state.theme = theme === 'night' ? 'night' : 'day';
  document.body.dataset.theme = state.theme;
  const night = state.theme === 'night';
  themeToggle.textContent = night ? '☀ ' + tr('dayMode') : '☾ ' + tr('nightMode');
  themeToggle.setAttribute('aria-pressed', night ? 'true' : 'false');
  saveState();
}
themeToggle.addEventListener('click', () => setTheme(state.theme === 'night' ? 'day' : 'night'));

const playlistToggle = document.getElementById('playlistToggle');
const playlistContent = document.getElementById('playlistContent');
playlistToggle.addEventListener('click', () => {
  const isOpen = playlistToggle.getAttribute('aria-expanded') === 'true';
  playlistToggle.setAttribute('aria-expanded', isOpen ? 'false' : 'true');
  playlistContent.hidden = isOpen;
});

function renderPlaylists() {
  const select = document.getElementById('playlistSelect');
  const items = document.getElementById('playlistItems');
  const selected = getSelectedPlaylist();
  select.replaceChildren();
  state.playlists.forEach(playlist => {
    const option = document.createElement('option');
    option.value = playlist.id;
    option.textContent = playlist.name;
    option.selected = playlist.id === state.selectedPlaylistId;
    select.appendChild(option);
  });

  items.replaceChildren();
  if (!selected || !selected.tracks.length) {
    const empty = document.createElement('li');
    empty.className = 'playlist-empty';
    empty.textContent = 'Esta lista está vacía. Añade un enlace de YouTube arriba.';
    items.appendChild(empty);
  } else {
    selected.tracks.forEach((track, index) => {
      const li = document.createElement('li');
      const play = document.createElement('button');
      play.type = 'button';
      play.className = 'playlist-play';
      play.textContent = '▶';
      play.setAttribute('aria-label', 'Reproducir ' + track.name);
      play.addEventListener('click', () => showTrack(index));

      const name = document.createElement('span');
      name.className = 'playlist-track-name';
      name.textContent = track.name;

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'playlist-remove';
      remove.textContent = '×';
      remove.title = 'Quitar vídeo';
      remove.setAttribute('aria-label', 'Quitar ' + track.name);
      remove.addEventListener('click', () => {
        selected.tracks.splice(index, 1);
        state.currentTrackIndex = 0;
        renderPlaylists();
        if (selected.tracks.length) showTrack(0);
        else {
          document.getElementById('trackPosition').textContent = '0 / 0';
          document.getElementById('musicCaption').textContent = 'Añade un vídeo a esta lista para empezar.';
          document.getElementById('videoFrame').replaceChildren();
          saveState();
        }
      });
      li.append(play, name, remove);
      items.appendChild(li);
    });
  }
  document.getElementById('deletePlaylist').disabled = state.playlists.length <= 1;
  document.getElementById('deletePlaylist').style.opacity = state.playlists.length <= 1 ? '.4' : '1';
}

document.getElementById('createPlaylist').addEventListener('click', () => {
  const input = document.getElementById('newPlaylistName');
  const name = input.value.trim();
  if (!name) {
    document.getElementById('playlistMessage').textContent = 'Escribe un nombre para la lista.';
    return;
  }
  const playlist = { id: 'list-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7), name, tracks: [] };
  state.playlists.push(playlist);
  state.selectedPlaylistId = playlist.id;
  state.currentTrackIndex = 0;
  input.value = '';
  renderPlaylists();
  document.getElementById('playlistMessage').textContent = 'Lista creada. Ahora puedes añadir enlaces.';
  document.getElementById('trackPosition').textContent = '0 / 0';
  document.getElementById('musicCaption').textContent = 'Añade un vídeo a esta lista para empezar.';
  document.getElementById('videoFrame').replaceChildren();
  saveState();
});

document.getElementById('playlistSelect').addEventListener('change', e => {
  state.selectedPlaylistId = e.target.value;
  state.currentTrackIndex = 0;
  renderPlaylists();
  const playlist = getSelectedPlaylist();
  if (playlist.tracks.length) showTrack(0);
  else {
    document.getElementById('trackPosition').textContent = '0 / 0';
    document.getElementById('musicCaption').textContent = 'Esta lista está vacía. Añade un vídeo.';
    document.getElementById('videoFrame').replaceChildren();
    saveState();
  }
});

document.getElementById('deletePlaylist').addEventListener('click', () => {
  if (state.playlists.length <= 1) return;
  const selected = getSelectedPlaylist();
  if (!confirm('¿Eliminar la lista "' + selected.name + '" y sus enlaces?')) return;
  state.playlists = state.playlists.filter(p => p.id !== selected.id);
  state.selectedPlaylistId = state.playlists[0].id;
  state.currentTrackIndex = 0;
  renderPlaylists();
  const next = getSelectedPlaylist();
  if (next.tracks.length) showTrack(0);
  else {
    document.getElementById('trackPosition').textContent = '0 / 0';
    document.getElementById('musicCaption').textContent = 'Esta lista está vacía. Añade un vídeo.';
    document.getElementById('videoFrame').replaceChildren();
  }
  saveState();
});

document.getElementById('playlistAddForm').addEventListener('submit', e => {
  e.preventDefault();
  const input = document.getElementById('playlistVideoUrl');
  const id = validVideoFromInput(input.value.trim());
  const playlist = getSelectedPlaylist();
  if (!id) {
    document.getElementById('playlistMessage').textContent = 'Ese enlace no parece válido. Comprueba que sea de YouTube.';
    return;
  }
  if (playlist.tracks.some(track => track.id === id)) {
    document.getElementById('playlistMessage').textContent = 'Ese vídeo ya está en esta lista.';
    return;
  }
  playlist.tracks.push({ id, name: 'Vídeo de YouTube · ' + id });
  input.value = '';
  renderPlaylists();
  document.getElementById('playlistMessage').textContent = 'Vídeo añadido a «' + playlist.name + '».';
  if (playlist.tracks.length === 1) showTrack(0);
  saveState();
});

function restoreMusic() {
  const playlist = getSelectedPlaylist();
  if (playlist && playlist.tracks.length) {
    const foundIndex = playlist.tracks.findIndex(t => t.id === state.currentVideoId);
    showTrack(foundIndex >= 0 ? foundIndex : Math.min(state.currentTrackIndex, playlist.tracks.length - 1));
  } else {
    document.getElementById('trackPosition').textContent = '0 / 0';
    document.getElementById('musicCaption').textContent = 'Esta lista está vacía. Añade un vídeo.';
    document.getElementById('videoFrame').replaceChildren();
  }
}

function saveOnExit() {
  const now = Date.now();
  for (const mode of ['study','break']) {
    const session = timerSessions[mode];
    if (session.running && session.endAt !== null) {
      session.remaining = Math.max(0, Math.ceil((session.endAt - now) / 1000));
    }
  }
  syncSelectedTimer();
  saveState();
}
window.addEventListener('pagehide', saveOnExit);
document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState==='hidden') saveOnExit();
  else if(Object.values(timerSessions).some(session=>session.running)) tick();
});

document.body.dataset.theme = state.theme;


// ===== Rachas, calendario, notas, recordatorios, idiomas y fondos =====
const I18N = {
  es: {
    options:'Opciones', footerText:'Un espacio sencillo para avanzar a tu ritmo · Little Focus', readyPrompt:'Prepara tu espacio y empieza cuando quieras', language:'Idioma', background:'Color de fondo', ownImage:'Usar una imagen o GIF propio', endSoundLabel:'Sonido al terminar el temporizador', customSoundLabel:'Subir un sonido propio', customSoundHint:'Puedes elegir un archivo de audio de tu dispositivo.', previewSound:'Probar sonido', openCalendar:'Abrir calendario', closeCalendar:'Cerrar calendario',
    imageHint:'La imagen se guarda en este dispositivo. Los GIF mantienen su animación. Utiliza archivos de hasta 12 MB.',
    removeImage:'Quitar imagen', soundChime:'Campanillas suaves', soundBell:'Campana', soundDigital:'Aviso digital', soundNature:'Pájaros', soundNone:'Sin sonido', soundCustom:'Mi propio sonido', musicLoading:'Vídeo cargado · esperando reproducción', musicPlaying:'Reproduciendo vídeo', musicPaused:'Vídeo en pausa', musicBuffering:'Cargando vídeo…', musicEnded:'Vídeo terminado', musicReady:'Vídeo listo · pulsa reproducir', noVideo:'No hay ningún vídeo en esta lista', streakDays:'días de racha', streakStart:'Completa un bloque de estudio para empezar',
    streakActive:'¡Vas por buen camino!', best:'Mejor racha:', days:'días', calendar:'Calendario de estudio',
    studyLegend:'Día con estudio completado', noteLegend:'Día con nota o recordatorio', selectDay:'Selecciona un día',
    calendarHelp:'Haz clic derecho sobre un día para añadir una nota o un recordatorio.',
    weekdays:['L','M','X','J','V','S','D'], addNote:'Añadir nota', addReminder:'Añadir recordatorio',
    note:'Nota', reminder:'Recordatorio', notePlaceholder:'Escribe aquí...', reminderDate:'Fecha y hora del recordatorio',
    cancel:'Cancelar', save:'Guardar', noNotes:'No hay notas para este día.', studyTime:'Tiempo de estudio',
    breakTime:'Tiempo de descanso', start:'Empezar', pause:'Pausar', studyDone:'¡Bloque terminado! Toca descansar un poco.',
    breakDone:'Descanso terminado. Vuelve al estudio cuando quieras.', paused:'Temporizador en pausa',
    focusNow:'Tiempo para concentrarte', restNow:'Momento de descansar', readyStudy:'Listo para estudiar',
    takeBreak:'Tómate un respiro', resetDone:'Temporizador reiniciado', dayMode:'Modo día', nightMode:'Modo noche',
    noteSaved:'Nota guardada.', reminderSaved:'Recordatorio guardado.', imageTooBig:'La imagen supera los 12 MB.',
    imageError:'No se ha podido guardar esa imagen.', reminderDue:'Tienes un recordatorio pendiente',
    delete:'Eliminar', savedNote:'Nota', savedReminder:'Recordatorio', sessions:'bloques completados'
  },
  en: {
    options:'Settings', footerText:'A simple space to make progress at your own pace · Little Focus', readyPrompt:'Set up your space and start whenever you like', language:'Language', background:'Background colour', ownImage:'Use your own image or GIF', endSoundLabel:'Sound when the timer ends', customSoundLabel:'Upload your own sound', customSoundHint:'Choose an audio file from your device.', previewSound:'Preview sound', openCalendar:'Open calendar', closeCalendar:'Close calendar',
    imageHint:'The image is saved on this device. GIFs keep their animation. Use files up to 12 MB.',
    removeImage:'Remove image', soundChime:'Soft chimes', soundBell:'Bell', soundDigital:'Digital alert', soundNature:'Birdsong', soundNone:'No sound', soundCustom:'My own sound', musicLoading:'Video loaded · waiting to play', musicPlaying:'Video playing', musicPaused:'Video paused', musicBuffering:'Loading video…', musicEnded:'Video ended', musicReady:'Video ready · press play', noVideo:'There are no videos in this playlist', streakDays:'day streak', streakStart:'Complete a study block to start',
    streakActive:'You are keeping it going!', best:'Best streak:', days:'days', calendar:'Study calendar',
    studyLegend:'Completed study day', noteLegend:'Day with a note or reminder', selectDay:'Select a day',
    calendarHelp:'Right-click a day to add a note or reminder.',
    weekdays:['M','T','W','T','F','S','S'], addNote:'Add note', addReminder:'Add reminder',
    note:'Note', reminder:'Reminder', notePlaceholder:'Write here...', reminderDate:'Reminder date and time',
    cancel:'Cancel', save:'Save', noNotes:'No notes for this day.', studyTime:'Study time',
    breakTime:'Break time', start:'Start', pause:'Pause', studyDone:'Study block complete! Time for a break.',
    breakDone:'Break finished. Return to studying when you are ready.', paused:'Timer paused',
    focusNow:'Time to focus', restNow:'Time to take a break', readyStudy:'Ready to study',
    takeBreak:'Take a break', resetDone:'Timer reset', dayMode:'Day mode', nightMode:'Night mode',
    noteSaved:'Note saved.', reminderSaved:'Reminder saved.', imageTooBig:'The image is larger than 12 MB.',
    imageError:'This image could not be saved.', reminderDue:'You have a reminder due',
    delete:'Delete', savedNote:'Note', savedReminder:'Reminder', sessions:'completed blocks'
  },
  zh: {
    options:'设置', footerText:'一个简单的空间，按照自己的节奏不断进步 · Little Focus', readyPrompt:'准备好你的空间，随时开始', language:'语言', background:'背景颜色', ownImage:'使用自己的图片或 GIF', endSoundLabel:'计时结束时的声音', customSoundLabel:'上传自己的声音', customSoundHint:'从设备中选择一个音频文件。', previewSound:'试听声音', openCalendar:'打开日历', closeCalendar:'关闭日历',
    imageHint:'图片保存在此设备上。GIF 会保持动画效果。请使用不超过 12 MB 的文件。',
    removeImage:'移除图片', soundChime:'柔和铃声', soundBell:'钟声', soundDigital:'数字提示音', soundNature:'鸟鸣', soundNone:'无声音', soundCustom:'自定义声音', musicLoading:'视频已加载 · 等待播放', musicPlaying:'视频正在播放', musicPaused:'视频已暂停', musicBuffering:'视频加载中…', musicEnded:'视频已结束', musicReady:'视频已就绪 · 点击播放', noVideo:'此播放列表中没有视频', streakDays:'天连续学习', streakStart:'完成一个学习时段即可开始',
    streakActive:'继续保持！', best:'最长连续记录：', days:'天', calendar:'学习日历',
    studyLegend:'已完成学习的日期', noteLegend:'有笔记或提醒的日期', selectDay:'请选择一天',
    calendarHelp:'右键点击日期即可添加笔记或提醒。',
    weekdays:['一','二','三','四','五','六','日'], addNote:'添加笔记', addReminder:'添加提醒',
    note:'笔记', reminder:'提醒', notePlaceholder:'在这里输入...', reminderDate:'提醒日期和时间',
    cancel:'取消', save:'保存', noNotes:'这一天没有笔记。', studyTime:'学习时间',
    breakTime:'休息时间', start:'开始', pause:'暂停', studyDone:'学习时段完成！休息一下吧。',
    breakDone:'休息结束，准备好后继续学习。', paused:'计时器已暂停',
    focusNow:'开始专注', restNow:'休息时间', readyStudy:'准备学习',
    takeBreak:'休息一下', resetDone:'计时器已重置', dayMode:'日间模式', nightMode:'夜间模式',
    noteSaved:'笔记已保存。', reminderSaved:'提醒已保存。', imageTooBig:'图片超过 12 MB。',
    imageError:'无法保存此图片。', reminderDue:'你有一个待处理的提醒',
    delete:'删除', savedNote:'笔记', savedReminder:'提醒', sessions:'已完成时段'
  }
};
function tr(key){ return (I18N[state.language] || I18N.es)[key] || I18N.es[key] || key; }

function localDateKey(date = new Date()) {
  const y = date.getFullYear(), m = String(date.getMonth()+1).padStart(2,'0'), d = String(date.getDate()).padStart(2,'0');
  return `${y}-${m}-${d}`;
}
function dateFromKey(key){ const [y,m,d] = key.split('-').map(Number); return new Date(y,m-1,d); }
function recordStudyDay(){
  const key = localDateKey();
  state.activity[key] = (state.activity[key] || 0) + 1;
  renderStreak(); renderCalendar(); saveState();
}
function streakLength(){
  const today = new Date();
  let cursor = new Date(today.getFullYear(),today.getMonth(),today.getDate());
  if (!state.activity[localDateKey(cursor)]) cursor.setDate(cursor.getDate()-1);
  let count = 0;
  while(state.activity[localDateKey(cursor)]){
    count++; cursor.setDate(cursor.getDate()-1);
  }
  return count;
}
function bestStreakLength(){
  const dates = Object.keys(state.activity).filter(k => state.activity[k] > 0).sort();
  let best=0, run=0, previous=null;
  dates.forEach(key=>{
    const d=dateFromKey(key);
    if(previous){ const diff=Math.round((d-previous)/86400000); run=diff===1?run+1:1; }
    else run=1;
    best=Math.max(best,run); previous=d;
  });
  return best;
}
function renderStreak(){
  const current=streakLength(), best=bestStreakLength();
  document.getElementById('streakCurrent').textContent=current;
  document.getElementById('streakLabel').textContent=tr('streakDays');
  document.getElementById('streakSub').textContent=current?tr('streakActive'):tr('streakStart');
  document.getElementById('streakBestLabel').textContent=tr('best');
  document.getElementById('streakBest').textContent=best;
  document.getElementById('bestDaysLabel').textContent=tr('days');
}
let calendarCursor = new Date(new Date().getFullYear(),new Date().getMonth(),1);
let selectedCalendarDate = localDateKey();
function renderCalendar(){
  const grid=document.getElementById('calendarGrid');
  grid.replaceChildren();
  const weekdays=tr('weekdays');
  weekdays.forEach(day=>{const el=document.createElement('div');el.className='calendar-weekday';el.textContent=day;grid.appendChild(el);});
  const year=calendarCursor.getFullYear(), month=calendarCursor.getMonth();
  const first=new Date(year,month,1), offset=(first.getDay()+6)%7, days=new Date(year,month+1,0).getDate();
  const monthNames={
    es:['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'],
    en:['January','February','March','April','May','June','July','August','September','October','November','December'],
    zh:['一月','二月','三月','四月','五月','六月','七月','八月','九月','十月','十一月','十二月']
  };
  document.getElementById('calendarMonth').textContent=state.language==='zh'?`${year}年${month+1}月`:`${monthNames[state.language][month]} ${year}`;
  for(let i=0;i<offset;i++){const blank=document.createElement('div');grid.appendChild(blank);}
  for(let day=1;day<=days;day++){
    const date=new Date(year,month,day), key=localDateKey(date), button=document.createElement('button');
    button.type='button';button.className='calendar-day';button.dataset.date=key;
    if(key===localDateKey())button.classList.add('today');
    if(key===selectedCalendarDate)button.classList.add('selected');
    const studied=!!state.activity[key], hasNotes=state.notes.some(n=>n.date===key);
    if(studied)button.classList.add('has-study');
    const number=document.createElement('span');number.className='day-number';number.textContent=day;
    const markers=document.createElement('span');markers.className='day-markers';
    if(studied){const dot=document.createElement('i');dot.className='study-dot';markers.appendChild(dot);}
    if(hasNotes){const dot=document.createElement('i');dot.className='note-dot';markers.appendChild(dot);}
    button.append(number,markers);
    button.addEventListener('click',()=>{selectedCalendarDate=key;renderCalendar();renderDayDetails();});
    button.addEventListener('contextmenu',event=>{
      event.preventDefault();selectedCalendarDate=key;renderCalendar();renderDayDetails();openDayContext(event.clientX,event.clientY,key);
    });
    grid.appendChild(button);
  }
  renderDayDetails();
}
function prettyDate(key){
  const d=dateFromKey(key);
  return new Intl.DateTimeFormat(state.language==='zh'?'zh-CN':state.language==='en'?'en-GB':'es-ES',{day:'numeric',month:'long',year:'numeric'}).format(d);
}
function renderDayDetails(){
  const title=document.getElementById('selectedDayTitle'), holder=document.getElementById('dayNotes');
  title.textContent=selectedCalendarDate?prettyDate(selectedCalendarDate):tr('selectDay');
  holder.replaceChildren();
  const items=state.notes.filter(n=>n.date===selectedCalendarDate);
  if(!items.length){const p=document.createElement('p');p.textContent=tr('noNotes');holder.appendChild(p);}
  items.forEach(note=>{
    const entry=document.createElement('div');entry.className='note-entry';
    const strong=document.createElement('strong');strong.textContent=note.type==='reminder'?'◷ '+tr('savedReminder'):'✎ '+tr('savedNote');
    const text=document.createElement('p');text.textContent=note.text;
    entry.append(strong,text);
    if(note.time){const small=document.createElement('small');small.textContent=new Date(note.time).toLocaleString(state.language==='zh'?'zh-CN':state.language==='en'?'en-GB':'es-ES');entry.appendChild(small);}
    const remove=document.createElement('button');remove.type='button';remove.className='text-button danger-button';remove.textContent=tr('delete');
    remove.addEventListener('click',()=>{state.notes=state.notes.filter(n=>n.id!==note.id);saveState();renderCalendar();});
    entry.appendChild(remove);holder.appendChild(entry);
  });
}
let contextDate=null, noteType='note';
const contextMenu=document.getElementById('dayContextMenu');
function openDayContext(x,y,key){
  contextDate=key;contextMenu.classList.add('open');
  contextMenu.style.left=Math.min(x,window.innerWidth-200)+'px';
  contextMenu.style.top=Math.min(y,window.innerHeight-100)+'px';
}
function closeDayContext(){contextMenu.classList.remove('open');}
document.addEventListener('click',event=>{if(!contextMenu.contains(event.target))closeDayContext();});
document.getElementById('contextAddNote').addEventListener('click',()=>openNoteDialog('note'));
document.getElementById('contextAddReminder').addEventListener('click',()=>openNoteDialog('reminder'));
function openNoteDialog(type){
  closeDayContext();noteType=type;
  document.getElementById('noteDialogTitle').textContent=type==='note'?tr('addNote'):tr('addReminder');
  document.getElementById('noteTextLabel').textContent=tr('note');
  document.getElementById('noteText').value='';
  document.getElementById('noteText').placeholder=tr('notePlaceholder');
  document.getElementById('reminderFields').hidden=type!=='reminder';
  const defaultTime=new Date();defaultTime.setMinutes(defaultTime.getMinutes()+30);
  document.getElementById('reminderTime').value=type==='reminder'?`${localDateKey(defaultTime)}T${String(defaultTime.getHours()).padStart(2,'0')}:${String(defaultTime.getMinutes()).padStart(2,'0')}`:`${contextDate}T09:00`;
  document.getElementById('reminderTimeLabel').textContent=tr('reminderDate');
  document.getElementById('cancelNote').textContent=tr('cancel');
  document.getElementById('saveNote').textContent=tr('save');
  document.getElementById('noteDialog').classList.add('open');
}
function closeNoteDialog(){document.getElementById('noteDialog').classList.remove('open');}
document.getElementById('cancelNote').addEventListener('click',closeNoteDialog);
document.getElementById('noteDialog').addEventListener('click',e=>{if(e.target.id==='noteDialog')closeNoteDialog();});
document.getElementById('saveNote').addEventListener('click',async()=>{
  const text=document.getElementById('noteText').value.trim();
  if(!text){document.getElementById('noteText').focus();return;}
  const time=noteType==='reminder'?document.getElementById('reminderTime').value:'';
  if(noteType==='reminder'&&!time){document.getElementById('reminderTime').focus();return;}
  state.notes.push({id:'note-'+Date.now()+'-'+Math.random().toString(36).slice(2,7),date:contextDate,text,type:noteType,time:time?new Date(time).toISOString():''});
  saveState();closeNoteDialog();renderCalendar();
  if(noteType==='reminder'&&'Notification'in window&&Notification.permission==='default'){
    try{await Notification.requestPermission();}catch(e){}
  }
  const msg=noteType==='note'?tr('noteSaved'):tr('reminderSaved');
  statusEl.textContent=msg;
});
document.getElementById('calendarToggle').addEventListener('click',()=>{
  const panel=document.getElementById('calendarPanel');
  const button=document.getElementById('calendarToggle');
  const opening=panel.hidden;
  panel.hidden=!opening;
  button.setAttribute('aria-expanded',opening?'true':'false');
  const label=opening?tr('closeCalendar'):tr('openCalendar');
  button.setAttribute('aria-label',label);
  button.title=tr('calendar');
  if(opening){
    panel.classList.remove('calendar-opening');
    void panel.offsetWidth;
    panel.classList.add('calendar-opening');
    renderCalendar();
    panel.scrollIntoView({behavior:'smooth',block:'nearest'});
  }
});
document.getElementById('calendarPrev').addEventListener('click',()=>{calendarCursor.setMonth(calendarCursor.getMonth()-1);renderCalendar();});
document.getElementById('calendarNext').addEventListener('click',()=>{calendarCursor.setMonth(calendarCursor.getMonth()+1);renderCalendar();});

// Recordatorios: se comprueban mientras Little Focus está abierto.
function checkDueReminders(){
  const now=Date.now();
  state.notes.forEach(note=>{
    if(note.type==='reminder'&&note.time&&!note.notified&&new Date(note.time).getTime()<=now){
      note.notified=true;saveState();
      if('Notification'in window&&Notification.permission==='granted'){
        try{new Notification('Little Focus',{body:note.text});}catch(e){}
      }else{
        statusEl.textContent=tr('reminderDue')+': '+note.text;
      }
    }
  });
}
setInterval(checkDueReminders,30000);

// Opciones: idioma y fondos.
const optionsPanel=document.getElementById('optionsPanel');
document.getElementById('optionsOpen').addEventListener('click',()=>optionsPanel.classList.add('open'));
document.getElementById('optionsClose').addEventListener('click',()=>optionsPanel.classList.remove('open'));
optionsPanel.addEventListener('click',e=>{if(e.target===optionsPanel)optionsPanel.classList.remove('open');});
document.getElementById('languageSelect').value=state.language;
document.getElementById('languageSelect').addEventListener('change',e=>{
  state.language=e.target.value;saveState();applyLanguage();renderTimer();renderStreak();renderCalendar();renderPlaylists();
});
const backgroundPalette=['#f3eee5','#e8eee5','#e8edf4','#f3e6e1','#f1e8f4','#f4efda','#202a25','#292b3b'];
const colorNames={
  es:['Crema','Verde salvia','Azul suave','Rosa empolvado','Lavanda','Vainilla','Bosque oscuro','Azul noche'],
  en:['Cream','Sage green','Soft blue','Dusty pink','Lavender','Vanilla','Dark forest','Midnight blue'],
  zh:['奶油色','鼠尾草绿','浅蓝色','灰粉色','薰衣草色','香草色','深森林绿','午夜蓝']
};
function renderBackgroundOptions(){
  const holder=document.getElementById('backgroundColors');holder.replaceChildren();
  backgroundPalette.forEach((color,index)=>{
    const button=document.createElement('button');button.type='button';button.className='color-swatch';button.style.background=color;
    button.title=colorNames[state.language][index];button.setAttribute('aria-label',button.title);
    button.setAttribute('aria-pressed',state.backgroundColor===color?'true':'false');
    button.addEventListener('click',()=>{state.backgroundColor=color;applyBackgroundColor();renderBackgroundOptions();saveState();});
    holder.appendChild(button);
  });
}
function applyBackgroundColor(){
  document.documentElement.style.setProperty('--bg',state.backgroundColor);
  document.body.style.backgroundColor=state.backgroundColor;
  renderBackgroundOptions();
}
const DB_NAME='LittleFocusAssets', DB_STORE='backgrounds';
function openAssetDB(){
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open(DB_NAME,1);
    request.onupgradeneeded=()=>{if(!request.result.objectStoreNames.contains(DB_STORE))request.result.createObjectStore(DB_STORE);};
    request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
  });
}
async function storeBackgroundBlob(blob){
  const db=await openAssetDB();
  await new Promise((resolve,reject)=>{
    const tx=db.transaction(DB_STORE,'readwrite');tx.objectStore(DB_STORE).put(blob,'custom-background');
    tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);
  });db.close();
}
async function getBackgroundBlob(){
  const db=await openAssetDB();
  const blob=await new Promise((resolve,reject)=>{
    const tx=db.transaction(DB_STORE,'readonly'),req=tx.objectStore(DB_STORE).get('custom-background');
    req.onsuccess=()=>resolve(req.result||null);req.onerror=()=>reject(req.error);
  });db.close();return blob;
}
async function clearBackgroundBlob(){
  const db=await openAssetDB();
  await new Promise((resolve,reject)=>{
    const tx=db.transaction(DB_STORE,'readwrite');tx.objectStore(DB_STORE).delete('custom-background');
    tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);
  });db.close();
}
let customBackgroundUrl=null;
async function restoreCustomBackground(){
  try{
    const blob=await getBackgroundBlob();
    if(blob){
      customBackgroundUrl=URL.createObjectURL(blob);
      document.body.style.setProperty('--little-focus-user-bg',`url("${customBackgroundUrl}")`);
    } else {
      document.body.style.removeProperty('--little-focus-user-bg');
    }
  }catch(e){console.warn('No se pudo recuperar el fondo personalizado',e);}
}
function applyLanguage(){
  const map={
    optionsTitle:'options',languageLabel:'language',backgroundLabel:'background',imageLabel:'ownImage',endSoundLabel:'endSoundLabel',customSoundLabel:'customSoundLabel',customSoundHint:'customSoundHint',
    imageHint:'imageHint',removeBackground:'removeImage',calendarTitle:'calendar',legendStudy:'studyLegend',
    legendNote:'noteLegend',selectedDayTitle:'selectDay',calendarHelp:'calendarHelp',
    contextAddNote:'addNote',contextAddReminder:'addReminder',streakLabel:'streakDays',bestStreakLabel:'best',bestDaysLabel:'days',streakSub:'streakStart'
  };
  Object.entries(map).forEach(([id,key])=>{const el=document.getElementById(id);if(el)el.textContent=tr(key);});
  document.getElementById('optionsOpen').textContent='⚙ '+tr('options');
  document.getElementById('studyTabText').textContent=state.language==='es'?'Estudio':state.language==='en'?'Study':'学习';
  document.getElementById('breakTabText').textContent=state.language==='es'?'Descanso':state.language==='en'?'Break':'休息';
  document.getElementById('studyDurationLabel').textContent=state.language==='es'?'Duración de estudio':state.language==='en'?'Study duration':'学习时长';
  document.getElementById('breakDurationLabel').textContent=state.language==='es'?'Duración de descanso':state.language==='en'?'Break duration':'休息时长';
  document.getElementById('endSoundSelect').options[0].text=tr('soundChime');
  document.getElementById('endSoundSelect').options[1].text=tr('soundBell');
  document.getElementById('endSoundSelect').options[2].text=tr('soundDigital');
  document.getElementById('endSoundSelect').options[3].text=tr('soundNature');
  document.getElementById('endSoundSelect').options[4].text=tr('soundNone');
  document.getElementById('endSoundSelect').options[5].text=tr('soundCustom');
  document.getElementById('previewEndSound').textContent=tr('previewSound');
  const musicKeys={'-1':'musicReady',0:'musicEnded',1:'musicPlaying',2:'musicPaused',3:'musicBuffering',5:'musicReady'};
  document.getElementById('musicStatus').textContent=tr(musicKeys[currentMusicState]||'musicLoading');
  const calendarIsOpen=!document.getElementById('calendarPanel').hidden;
  const calendarToggleLabel=calendarIsOpen?tr('closeCalendar'):tr('openCalendar');
  document.getElementById('calendarToggle').setAttribute('aria-label',calendarToggleLabel);
  document.getElementById('calendarToggle').title=tr('calendar');
  document.getElementById('noteTextLabel').textContent=tr('note');
  document.getElementById('reminderTimeLabel').textContent=tr('reminderDate');
  document.getElementById('cancelNote').textContent=tr('cancel');
  document.getElementById('saveNote').textContent=tr('save');
  document.getElementById('calendarHelp').textContent=tr('calendarHelp');
  document.getElementById('calendarPrev').setAttribute('aria-label',state.language==='es'?'Mes anterior':state.language==='en'?'Previous month':'上个月');
  document.getElementById('calendarNext').setAttribute('aria-label',state.language==='es'?'Mes siguiente':state.language==='en'?'Next month':'下个月');
  document.getElementById('brandSubtitle').textContent=state.language==='es'?'Tu rinconcito tranquilo para estudiar':state.language==='en'?'Your quiet little place to study':'安静舒适的学习空间';
  document.querySelector('.video-head h2').textContent=state.language==='es'?'Música para concentrarte':state.language==='en'?'Music for focus':'专注学习音乐';
  document.getElementById('playlistHeading').textContent=state.language==='es'?'Mis listas':state.language==='en'?'My playlists':'我的播放列表';
  themeToggle.textContent=(state.theme==='night'?'☀ ':'☾ ')+tr(state.theme==='night'?'dayMode':'nightMode');
  document.getElementById('footerText').textContent=tr('footerText');
  if(!running && state.remaining===state.durations[state.mode]*60)statusEl.textContent=tr('readyPrompt');
  renderTimer();
  renderBackgroundOptions();
}
document.getElementById('backgroundUpload').addEventListener('change',async e=>{
  const file=e.target.files&&e.target.files[0];if(!file)return;
  if(!file.type.startsWith('image/')){e.target.value='';return;}
  if(file.size>12*1024*1024){alert(tr('imageTooBig'));e.target.value='';return;}
  try{
    await storeBackgroundBlob(file);
    if(customBackgroundUrl)URL.revokeObjectURL(customBackgroundUrl);
    customBackgroundUrl=URL.createObjectURL(file);
    document.body.style.setProperty('--little-focus-user-bg',`url("${customBackgroundUrl}")`);
    document.body.style.setProperty('background-image',`linear-gradient(#0000,#0000),url("${customBackgroundUrl}")`);
    document.body.style.setProperty('background-size','cover');document.body.style.setProperty('background-attachment','fixed');
    document.body.style.setProperty('background-position','center');document.body.style.setProperty('background-repeat','no-repeat');
    e.target.value='';
  }catch(err){alert(tr('imageError'));}
});
document.getElementById('removeBackground').addEventListener('click',async()=>{
  try{await clearBackgroundBlob();}catch(e){}
  if(customBackgroundUrl)URL.revokeObjectURL(customBackgroundUrl);customBackgroundUrl=null;
  document.body.style.removeProperty('--little-focus-user-bg');
  document.body.style.removeProperty('--custom-bg-image');
  ['background-image','background-size','background-attachment','background-position','background-repeat','background-blend-mode'].forEach(p=>document.body.style.removeProperty(p));
  document.getElementById('backgroundUpload').value='';
  applyBackgroundColor();
});
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'){closeDayContext();closeNoteDialog();optionsPanel.classList.remove('open');}
});

// Aplicar los ajustes guardados al iniciar, una vez definidas las traducciones.
document.body.dataset.theme=state.theme;
applyLanguage();
setTheme(state.theme);
applyBackgroundColor();

// Recuperar el temporizador activo usando una marca de tiempo absoluta.
// Esto permite que siga avanzando en segundo plano e incluso tras reabrir la PWA.
for (const mode of ['study','break']) {
  const session = timerSessions[mode];
  if (session.running && session.endAt !== null) {
    session.remaining = Math.max(0, Math.ceil((session.endAt-Date.now())/1000));
    if (session.remaining <= 0) { session.running = false; session.endAt = null; }
  }
}
syncSelectedTimer();
if (Object.values(timerSessions).some(session=>session.running)) interval = setInterval(tick,250);
if (timerSessions[state.mode].running) statusEl.textContent = state.mode === 'study' ? tr('focusNow') : tr('restNow');
renderTimer();
saveState();
renderPlaylists();
restoreMusic();
renderStreak();
renderCalendar();
if (location.hash === '#calendar') { const cp=document.getElementById('calendarPanel'); const cb=document.getElementById('calendarToggle'); if(cp&&cb){cp.hidden=false;cb.setAttribute('aria-expanded','true');} }
restoreCustomBackground();
restoreCustomEndSound();
saveState();

// Instalación como aplicación (PWA)
let deferredInstallPrompt = null;
const installAppButton = document.getElementById('installApp');

window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  deferredInstallPrompt = event;
  if (installAppButton) installAppButton.hidden = false;
});

if (installAppButton) {
  installAppButton.addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    installAppButton.hidden = true;
  });
}

window.addEventListener('appinstalled', () => {
  if (installAppButton) installAppButton.hidden = true;
  deferredInstallPrompt = null;
});

// El service worker permite abrir la interfaz básica sin conexión.
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js').catch(error => {
      console.warn('No se pudo registrar el modo sin conexión:', error);
    });
  });
}


// Configuración y autenticación de sincronización en la nube.
(function setupCloudUI(){
  const panel=document.getElementById('cloudPanel');
  const status=document.getElementById('cloudStatus');
  if(!panel||!window.LittleFocusCloud)return;
  const cfg=LittleFocusCloud.config();
  document.getElementById('cloudUrl').value=cfg.url||'';
  document.getElementById('cloudKey').value=cfg.anonKey||'';
  function statusText(){
    const s=LittleFocusCloud.session();
    status.textContent=LittleFocusCloud.connected?'Conectado'+(s?.user?.email?' como '+s.user.email:'')+'. Guardado automático activado.':(LittleFocusCloud.configured?'Proyecto configurado. Inicia sesión para activar la copia en la nube.':'Sin configurar. Necesitas un proyecto Supabase y ejecutar supabase-setup.sql.');
  }
  document.getElementById('cloudOpen').addEventListener('click',()=>{panel.classList.add('open');statusText();});
  document.getElementById('cloudClose').addEventListener('click',()=>panel.classList.remove('open'));
  async function connect(create){
    const button=create?document.getElementById('cloudSignup'):document.getElementById('cloudLogin');
    try{
      LittleFocusCloud.saveConfig(document.getElementById('cloudUrl').value,document.getElementById('cloudKey').value);
      status.textContent=create?'Creando cuenta…':'Conectando y sincronizando…';button.disabled=true;
      const result=await LittleFocusCloud.connect(document.getElementById('cloudEmail').value.trim(),document.getElementById('cloudPassword').value,create);
      status.textContent=result.restored?'Datos de la nube restaurados. Actualizando Little Focus…':'Cuenta conectada. Tus datos locales se han guardado en la nube.';
      if(result.restored){setTimeout(()=>location.reload(),500);}else saveState();
    }catch(error){status.textContent='No se pudo conectar: '+error.message;}
    finally{button.disabled=false;}
  }
  document.getElementById('cloudLogin').addEventListener('click',()=>connect(false));
  document.getElementById('cloudSignup').addEventListener('click',()=>connect(true));
  document.getElementById('cloudLogout').addEventListener('click',async()=>{await LittleFocusCloud.signOut();statusText();});
  statusText();
})();
