
let audio;
async function playSound(kind) {
  if (kind === 'custom') {
    try {
      const db = await new Promise((resolve,reject)=>{
        const req=indexedDB.open('LittleFocusAssets',1);
        req.onupgradeneeded=()=>{if(!req.result.objectStoreNames.contains('backgrounds'))req.result.createObjectStore('backgrounds');};
        req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
      });
      const blob=await new Promise((resolve,reject)=>{
        const tx=db.transaction('backgrounds','readonly');
        const req=tx.objectStore('backgrounds').get('custom-end-sound');
        req.onsuccess=()=>resolve(req.result||null);req.onerror=()=>reject(req.error);
      });
      db.close();
      if (blob) {
        if (audio) {audio.pause();audio=null;}
        audio=new Audio(URL.createObjectURL(blob));
        audio.volume=1;
        await audio.play();
        return;
      }
    } catch(e) {}
  }
  const ctx = new AudioContext();
  await ctx.resume();
  const notes = kind==='nature'?[1500,2050,1700,2250]:kind==='bell'?[880,1320]:kind==='digital'?[660,880,660,990]:[660,880,1046,880,1046];
  const lengths = kind==='bell'?[1.3,1.1]:kind==='digital'?[.42,.42,.42,.7]:kind==='nature'?[.25,.25,.25,.3]:[.5,.6,.75,.7,1];
  let offset=0;
  notes.forEach((freq,i)=>{
    const osc=ctx.createOscillator(), gain=ctx.createGain();
    osc.type=kind==='digital'?'triangle':'sine'; osc.frequency.value=freq;
    gain.gain.setValueAtTime(.0001,ctx.currentTime+offset);
    gain.gain.exponentialRampToValueAtTime(.35,ctx.currentTime+offset+.025);
    gain.gain.exponentialRampToValueAtTime(.0001,ctx.currentTime+offset+lengths[i]);
    osc.connect(gain);gain.connect(ctx.destination);
    osc.start(ctx.currentTime+offset);osc.stop(ctx.currentTime+offset+lengths[i]+.03);
    offset += kind==='digital'?.52:kind==='nature'?.31:.65;
  });
  setTimeout(()=>ctx.close().catch(()=>{}),7000);
}
chrome.runtime.onMessage.addListener(message=>{
  if(message?.target==='offscreen' && message.type==='play-end-sound') playSound(message.sound||'chime');
});
