const KEY='littleFocusAppStateV2';
const $=id=>document.getElementById(id);
const defaults={durations:{study:25,break:5},mode:'study',remaining:1500,endSound:'chime',theme:'day'};
let state, sessions, mode='study', busy=false;
function read(){
  try{const s=JSON.parse(localStorage.getItem(KEY)||'{}');state={...defaults,...s,durations:{...defaults.durations,...(s.durations||{})}};}
  catch{state={...defaults,durations:{...defaults.durations}};}
  state.mode=state.mode==='break'?'break':'study';
  const saved=state.timerSessions||{};
  sessions={};
  for(const m of ['study','break']){
    const x=saved[m]||{};
    sessions[m]={remaining:Number.isFinite(+x.remaining)?Math.max(0,+x.remaining):state.durations[m]*60,running:x.running===true,endAt:x.running&&Number.isFinite(+x.endAt)?+x.endAt:null};
    if(sessions[m].running&&sessions[m].endAt!==null){
      sessions[m].remaining=Math.max(0,Math.ceil((sessions[m].endAt-Date.now())/1000));
      if(!sessions[m].remaining){sessions[m].running=false;sessions[m].endAt=null;}
    }
  }
  mode=state.mode;
}
function persist(){
  state.mode=mode;
  state.timerSessions={study:{...sessions.study},break:{...sessions.break}};
  state.timerRunning=Object.values(sessions).some(x=>x.running);
  state.timerEndAt=sessions[mode].endAt;
  try{localStorage.setItem(KEY,JSON.stringify(state));}catch{}
  try{chrome.runtime.sendMessage({type:'sync-timers',sessions:state.timerSessions,sound:state.endSound||'chime'}).catch(()=>{});}catch{}
}
function render(){
  const s=sessions[mode], n=Math.max(0,s.running?Math.ceil((s.endAt-Date.now())/1000):s.remaining);
  const mm=String(Math.floor(n/60)).padStart(2,'0'),ss=String(n%60).padStart(2,'0');
  $('time').textContent=mm+':'+ss;
  $('modeLabel').textContent=mode==='study'?'Tiempo de estudio':'Tiempo de descanso';
  $('start').textContent=s.running?'Pausar':'Empezar';
  $('status').textContent=s.running?(mode==='study'?'En sesión de estudio':'En tiempo de descanso'):(n===0?'Tiempo terminado':'Prepara tu espacio y empieza cuando quieras');
  $('study').classList.toggle('active',mode==='study');$('break').classList.toggle('active',mode==='break');
  $('studyDuration').textContent=state.durations.study+' min';$('breakDuration').textContent=state.durations.break+' min';
  document.body.classList.toggle('night',state.theme==='night');
  $('theme').textContent=state.theme==='night'?'☀':'☾';
}
function select(m){read();mode=m;state.mode=m;persist();render();}
$('study').addEventListener('click',()=>select('study'));
$('break').addEventListener('click',()=>select('break'));
$('start').addEventListener('click',()=>{
  read();const s=sessions[mode];
  if(s.running){s.remaining=Math.max(0,Math.ceil((s.endAt-Date.now())/1000));s.running=false;s.endAt=null;}
  else{if(s.remaining<=0)s.remaining=state.durations[mode]*60;s.running=true;s.endAt=Date.now()+s.remaining*1000;}
  persist();render();
});
$('reset').addEventListener('click',()=>{read();const s=sessions[mode];s.running=false;s.endAt=null;s.remaining=state.durations[mode]*60;persist();render();});
document.querySelectorAll('[data-mode]').forEach(b=>b.addEventListener('click',()=>{
  read();const m=b.dataset.mode;state.durations[m]=Math.max(1,Math.min(180,state.durations[m]+Number(b.dataset.delta)));
  if(!sessions[m].running)sessions[m].remaining=state.durations[m]*60;
  persist();render();
}));
$('theme').addEventListener('click',()=>{read();state.theme=state.theme==='night'?'day':'night';persist();render();});
function openFull(hash=''){const url=chrome.runtime.getURL('index.html'+hash);chrome.tabs.create({url});}
$('calendar').addEventListener('click',()=>openFull('#calendar'));
$('full').addEventListener('click',()=>openFull());
read();render();
setInterval(()=>{read();render();},400);
