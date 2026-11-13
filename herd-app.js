/* BuffPrints — Find the Herd: the player screens (herd.html).
   The rules live in herd-core.js (shared with the tests). This file is screens, the relay
   connection, the camera, and the one place GPS is read.

   Three promises this file has to keep:
     1. The herd key arrives in the link's #fragment, is read once, and is removed from the
        address bar. It is never put in a request. Everything teammates share is sealed with it.
     2. GPS readings stay inside locate(): they are compared with the checkpoint on this phone
        and thrown away. Only "inside: yes" ever leaves that function.
     3. Friends Mode and Demo Practice call nothing that writes a row about anyone. */
(function(){
'use strict';
const H=window.HerdCore, CFG=window.RR_CONFIG||{}, BUNDLE=window.HERD_EDITIONS||{editions:[]};
const $=id=>document.getElementById(id);
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const av=k=>H.AVATAR_EMOJI[k]||H.AVATAR_EMOJI.bison;
const pl=(n,one,many)=>n+' '+(n===1?one:(many||one+'s'));
const DEMO_NOTE='Demo reward — not redeemable. No purchase benefit is available.';
const METRICS_IN_FRIENDS_MODE=true;   // anonymous counters only (see PRIVACY.md); set false to count Competition Mode alone

/* ---------- 1. the invite key: read it, then take it out of the address bar ---------- */
let pendingInvite=null;
(function(){
  const k=H.parseInvite(location.hash);
  if(k){ pendingInvite=k; try{ history.replaceState(null,'',location.pathname+location.search); }catch(e){ location.hash=''; } }
})();

/* ---------- online service (optional: Friends Mode and Demo Practice run without it) ---------- */
let sb=null;
try{
  if(CFG.supabaseUrl&&CFG.supabaseKey&&window.supabase)
    sb=window.supabase.createClient(CFG.supabaseUrl,CFG.supabaseKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:false,flowType:'implicit'}});
}catch(e){ sb=null; }
async function rpc(fn,args){
  if(!sb) return {error:{message:'The online service isn’t set up'}};
  try{ return await sb.rpc(fn,args||{}); }catch(e){ return {error:e}; }
}
const me={user:null, who:null};

/* ---------- app state ---------- */
const A={view:'loading', editions:[], serverOk:false, pick:null, mode:null, session:null, raw:null, relay:null, link:'off',
         comp:null, token:null, open:0, gps:{}, busy:{}, msg:{}, joinWait:0, standings:null, stEd:null, wallet:null,
         signin:{step:'email', email:'', msg:''}, celebrated:false, form:{}};

/* ---------- small UI kit (same shapes as the main app) ---------- */
function toast(msg){
  const t=document.createElement('div'); t.className='toast'; t.textContent=msg; $('toasts').appendChild(t);
  while($('toasts').children.length>3) $('toasts').firstChild.remove();
  setTimeout(()=>{ t.classList.add('out'); setTimeout(()=>t.remove(),450); },3200);
}
let modalClose=null, modalReturn=null;
function closeModal(){ $('modal').classList.remove('show'); if(modalClose){ const f=modalClose; modalClose=null; f(); } if(modalReturn&&document.contains(modalReturn)) modalReturn.focus(); modalReturn=null; }
function modal(title,html,btns,onClose){
  if(modalClose){ const f=modalClose; modalClose=null; f(); }
  if(!$('modal').classList.contains('show')) modalReturn=document.activeElement;
  $('mTitle').textContent=title; $('mBody').innerHTML=html; const box=$('mBtns'); box.innerHTML='';
  (btns||[]).forEach(b=>{ const el=document.createElement('button'); el.className='btn '+(b[1]||''); el.textContent=b[0]; if(b[3]) el.id=b[3];
    el.onclick=()=>{ if(b[4]!=='stay') closeModal(); b[2](); }; box.appendChild(el); });
  modalClose=onClose||null; $('modal').classList.add('show');
  setTimeout(()=>{ const f=$('mBody').querySelector('input,button')||box.querySelector('button')||$('modal').querySelector('.box'); if(f) f.focus(); },30);
}
$('modal').addEventListener('click',e=>{ if(e.target===$('modal')) closeModal(); });
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'&&$('modal').classList.contains('show')) closeModal();
  if(e.key==='Enter'&&e.target&&e.target.dataset&&e.target.dataset.enter){ e.preventDefault(); act(e.target.dataset.enter, e.target.dataset); }
});
function avatarPicker(name,legend,cur){
  return '<fieldset><legend>'+esc(legend)+'</legend><div class="avs">'+H.AVATARS.map(k=>
    '<label><input type="radio" name="'+name+'" value="'+k+'"'+(k===cur?' checked':'')+' aria-label="'+k+'"><span aria-hidden="true">'+av(k)+'</span></label>').join('')+'</div></fieldset>';
}
const radio=name=>{ const el=document.querySelector('input[name="'+name+'"]:checked'); return el?el.value:null; };
function qrSvg(text){
  const q=window.qrcode(0,'M'); q.addData(text); q.make();
  const n=q.getModuleCount(), m=3; let d='';
  for(let r=0;r<n;r++) for(let c=0;c<n;c++) if(q.isDark(r,c)) d+='M'+(c+m)+' '+(r+m)+'h1v1h-1z';
  return '<svg class="qr" viewBox="0 0 '+(n+2*m)+' '+(n+2*m)+'" role="img" aria-label="QR code" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="'+d+'" fill="#000"/></svg>';
}
function loadScript(src){ return new Promise((res,rej)=>{ const s=document.createElement('script'); s.src=src; s.onload=res; s.onerror=()=>rej(new Error('load')); document.head.appendChild(s); }); }

/* ---------- storage ----------
   localStorage: the sealed herd (ciphertext) + which herd is open.
   IndexedDB:    the derived keys, stored as non-extractable CryptoKeys (usable, never readable).
   sessionStorage: the raw invite key, for this tab only, so the invite QR can be shown again. */
const LS={get:async k=>{ try{ return localStorage.getItem(k); }catch(e){ return null; } },
          set:async(k,v)=>{ try{ localStorage.setItem(k,v); }catch(e){} },
          remove:async k=>{ try{ localStorage.removeItem(k); }catch(e){} }};
const memKeys={};
function kdb(){ return new Promise((res,rej)=>{ let r; try{ r=indexedDB.open('bp-herd',1); }catch(e){ return rej(e); }
  r.onupgradeneeded=()=>r.result.createObjectStore('keys'); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); }); }
async function ktx(mode,fn){ const db=await kdb(); return new Promise((res,rej)=>{ const tx=db.transaction('keys',mode), rq=fn(tx.objectStore('keys')); tx.oncomplete=()=>{ db.close(); res(rq&&rq.result); }; tx.onerror=tx.onabort=()=>{ db.close(); rej(tx.error); }; }); }
async function keyPut(keys){ memKeys[keys.channelId]=keys; try{ await ktx('readwrite',st=>st.put(keys,keys.channelId)); }catch(e){} }
async function keyGet(id){ if(memKeys[id]) return memKeys[id]; try{ const k=await ktx('readonly',st=>st.get(id)); if(k&&k.aes) return memKeys[id]=k; }catch(e){} return null; }
async function keyDel(id){ delete memKeys[id]; try{ await ktx('readwrite',st=>st.delete(id)); }catch(e){} }
const rawGet=id=>{ try{ return sessionStorage.getItem('bp-herd-raw:'+id); }catch(e){ return null; } };
const rawSet=(id,raw)=>{ try{ sessionStorage.setItem('bp-herd-raw:'+id,raw); }catch(e){} };
const activeGet=()=>{ try{ return localStorage.getItem('bp-herd-active'); }catch(e){ return null; } };
const activeSet=id=>{ try{ if(id) localStorage.setItem('bp-herd-active',id); else localStorage.removeItem('bp-herd-active'); }catch(e){} };

/* ---------- the relay: Supabase Realtime Broadcast, sent by the client, ciphertext only ----------
   No database-triggered broadcast (that would be stored) and no Presence (that would tell the
   server who is online together). Without the online service, tabs on one device can still
   find each other, and solo play needs nothing. */
function makeRelay(id){
  let fn=null, up=null, ch=null, bc=null;
  const setLink=s=>{ A.link=s; paintLink(); };
  if(sb){
    ch=sb.channel('herd-'+id,{config:{broadcast:{self:false,ack:false}}});
    ch.on('broadcast',{event:'m'},m=>{ const c=m&&m.payload&&m.payload.c; if(typeof c==='string'&&c.length<300000&&fn) fn(c); });
    ch.subscribe(st=>{ if(st==='SUBSCRIBED'){ setLink('live'); if(up) up(); } else if(st==='CLOSED') setLink('off'); else setLink('retry'); });
  }else if('BroadcastChannel' in window){
    bc=new BroadcastChannel('herd-'+id); bc.onmessage=e=>{ if(typeof e.data==='string'&&fn) fn(e.data); };
    setTimeout(()=>{ setLink('local'); if(up) up(); },0);
  }else setTimeout(()=>setLink('solo'),0);
  return {
    send(text){
      if(ch){ if(A.link!=='live') return Promise.resolve(); return Promise.resolve(ch.send({type:'broadcast',event:'m',payload:{c:text}})).catch(()=>{}); }
      if(bc) try{ bc.postMessage(text); }catch(e){}
      return Promise.resolve();
    },
    onMessage(f){ fn=f; }, onUp(f){ up=f; },
    close(){ try{ if(ch) sb.removeChannel(ch); if(bc) bc.close(); }catch(e){} }
  };
}
function closeSession(){ if(A.session) A.session.close(); if(A.relay) A.relay.close(); A.session=null; A.relay=null; A.comp=null; A.token=null; A.gps={}; A.msg={}; A.busy={}; A.celebrated=false; }
async function openHerd(keys,raw){
  closeSession();
  if(raw) rawSet(keys.channelId,raw);
  await keyPut(keys);
  const saved=await H.restore(keys,LS);
  const relay=makeRelay(keys.channelId);
  const s=H.createSession({keys, transport:relay, store:LS, state:saved&&saved.state, self:saved&&saved.self, flags:saved&&saved.flags, onChange:()=>afterChange()});
  relay.onUp(()=>s.hello());
  A.session=s; A.relay=relay; A.raw=raw||rawGet(keys.channelId); activeSet(keys.channelId);
  return s;
}

/* ---------- routes ---------- */
function bundled(id,version){ return BUNDLE.editions.find(x=>x.content.id===id&&x.content.version===version)||null; }
async function loadEditions(){
  A.editions=BUNDLE.editions.map(e=>({content:e.content, source:'bundle'})); A.serverOk=false;
  if(sb&&navigator.onLine){
    const r=await rpc('hunt_get_editions');
    if(!r.error&&Array.isArray(r.data)){ A.serverOk=true; A.editions=r.data.map(c=>bundled(c.id,c.version)?{content:bundled(c.id,c.version).content, source:'bundle'}:{content:c, source:'server'}); }
  }
}
/* Friends Mode / Demo Practice answer check: the hash shipped with the app when this exact route
   version is on board, otherwise a read-only question to the server. Neither stores anything. */
async function checkAnswer(st,cp,answer){
  const b=bundled(st.editionId,st.editionVersion);
  if(b) return H.checkAnswerLocal(b.key[String(cp)],answer);
  const r=await rpc('hunt_check_answer',{p_edition:st.editionId,p_version:st.editionVersion,p_checkpoint:cp,p_answer:String(answer).slice(0,200)});
  if(r.error) throw new Error('offline');
  return r.data===true;
}

/* ---------- anonymous counters: "+1" with no id and no time ---------- */
function bump(key,flag){
  const s=A.session; if(!sb||!s||!s.state) return;
  if(s.state.mode==='practice'||(s.state.mode==='friends'&&!METRICS_IN_FRIENDS_MODE)) return;
  const f='m:'+(flag||key); if(s.flags[f]) return;
  s.setFlag(f); rpc('increment_hunt_metric',{p_edition_id:s.state.editionId,p_metric_key:key});
}
function bumpView(id){
  if(!sb) return; const k='bp-herd-viewed:'+id;
  try{ if(sessionStorage.getItem(k)) return; sessionStorage.setItem(k,'1'); }catch(e){}
  rpc('increment_hunt_metric',{p_edition_id:id,p_metric_key:'views'});
}

/* ---------- 2. location: read here, compared here, discarded here ---------- */
function locate(cp,onProgress){
  return new Promise(res=>{
    if(!('geolocation' in navigator)) return res({error:'unsupported'});
    if(window.isSecureContext===false) return res({error:'insecure'});
    const fixes=[]; let done=false, id=null;
    const end=extra=>{ if(done) return; done=true; clearTimeout(t); try{ if(id!==null) navigator.geolocation.clearWatch(id); }catch(e){}
      const out=Object.assign({fence:H.bestFence(fixes,cp)},extra); fixes.length=0; res(out); };
    const t=setTimeout(()=>end(fixes.length?null:{error:'timeout'}),13000);
    try{
      id=navigator.geolocation.watchPosition(p=>{
        const f={lat:p.coords.latitude,lng:p.coords.longitude,accuracy:p.coords.accuracy}; fixes.push(f); if(fixes.length>12) fixes.shift();
        const g=H.geofence(f,cp); if(onProgress) onProgress(g); if(g.inside) end();
      },e=>end({error:e.code===1?'denied':e.code===2?'unavailable':'timeout'}),{enableHighAccuracy:true,maximumAge:0,timeout:12000});
    }catch(e){ end({error:'unsupported'}); }
  });
}
function gpsHTML(g,cp,canVouch,practice){
  if(!g) return '';
  const alt=(canVouch?' Or tap <b style="display:inline">Use a teammate’s code</b> if someone in your herd is already checked in here.':'')+(practice?' In Demo Practice you can also tap Simulate arriving.':'');
  const f=g.fence||{};
  if(g.state==='checking') return '<div class="statusbox" role="status"><b>Checking your location on this phone…</b>'+(f.accuracy!=null?'GPS is accurate to about '+f.accuracy+' m. Hold still for a moment.':'This can take a few seconds outdoors.')+'</div>';
  let t='', b='';
  if(g.state==='near'){ t='Almost — your GPS isn’t sure yet'; b='You look about '+f.distance+' m from the checkpoint, but your phone is only accurate to ±'+f.accuracy+' m right now. Step into the open, give it a few seconds, and try again.'; }
  else if(g.state==='outside'){ t='You’re not at this checkpoint yet'; b='It’s about '+(f.distance>=1000?(f.distance/1000).toFixed(1)+' km':f.distance+' m')+' to the '+f.toward+'. Try again when you get to '+esc(cp.name)+'.'; }
  else if(g.state==='weak'){ t='Your phone can’t pin down where you are'; b='The best it could do was ±'+(f.accuracy==null?'?':f.accuracy)+' m, which isn’t enough to tell. Move away from tall buildings and trees, wait a few seconds, and try again.'; }
  else if(g.state==='denied'){ t='Location is turned off for this site'; b='Find the Herd reads your location only when you tap Check in, compares it with the checkpoint on this phone, and never sends it anywhere. To allow it, turn on Location for this site in your browser or phone settings, then try again.'; }
  else if(g.state==='timeout'||g.state==='unavailable'){ t='No GPS signal yet'; b='Your phone didn’t report a location in time. Make sure Location is on, step outside, and try again.'; }
  else if(g.state==='insecure'||g.state==='unsupported'){ t='This browser can’t share location here'; b='Open BuffPrints from its https:// address in Safari or Chrome.'; }
  return '<div class="statusbox warn" role="status"><b>'+t+'</b>'+b+alt+'</div>';
}

/* ---------- Competition Mode: what the server says wins ---------- */
function note(cp,text,cls){ A.msg[cp]=text?{text,cls:cls||''}:null; }
async function applyComp(d){
  if(!d||!d.team_id) return;
  A.comp=Object.assign({},A.comp,d); const s=A.session; if(!s||!s.state) return;
  for(const p of d.puzzles||[]) if(p.hints_used) await s.setHints(p.no,p.hints_used);
  for(const cp of d.my_checkpoints||[]) await s.credit(cp);
  if(d.reward_token) A.token={token:d.reward_token,status:'issued'};
  else if((d.my_checkpoints||[]).length===H.CHECKPOINTS&&!A.token){
    const w=await rpc('hunt_my_wallet'); const t=!w.error&&(w.data||[]).find(x=>x.edition_id===s.state.editionId); if(t) A.token=t;
  }
  render();
}
/* Record my completed checkpoint. The server gets: team, checkpoint number, "inside: true", the answer. */
async function credit(cp,answer){
  const s=A.session, st=s.state, key='credit'+cp;
  if(A.busy[key]) return null; A.busy[key]=true;
  try{
    if(!(st.members[s.self].prox||{})[cp]) return null;       // never claim a place I haven't checked in at
    const r=await rpc('hunt_check_in',{p_team:st.herd.teamId,p_checkpoint:cp,p_in_geofence:true,p_answer:answer==null?null:String(answer).slice(0,200)});
    if(r.error){ note(cp,'Couldn’t reach BuffPrints to save this. Check your connection — it will retry.','warn'); return null; }
    const d=r.data||{};
    if(d.status==='ok'||d.status==='already'){ note(cp,null); await applyComp(d); return d; }
    if(d.status==='expired') note(cp,'This run’s week ended Sunday night, so standings are closed. Your credit so far is kept — start a new run to keep playing.','warn');
    else if(d.status==='not_member') note(cp,'You’re not on this team’s roster, so this check-in can’t be scored.','warn');
    return d;
  }finally{ A.busy[key]=false; render(); }
}

/* ---------- reacting to anything changing (mine or a teammate's) ---------- */
let drawQueued=false;
function afterChange(){
  const s=A.session; if(!s||!s.state) return;
  if(A.view==='joining'){ clearTimeout(A.joinWait); A.view='joinform'; }
  const st=s.state, m=st.members[s.self];
  if(m){
    for(let cp=1;cp<=H.CHECKPOINTS;cp++){
      const status=H.checkpointStatus(st,s.self,cp);
      if(status==='crediting'&&me.user&&!A.busy['credit'+cp]) credit(cp,st.puzzles[cp].answer);   // herd solved it and I'm there: save my attendance
      if(status==='done') bump('checkpoint_'+cp+'_completions');
    }
    if(H.finished(st,s.self)) bump('completions');
  }
  if(!drawQueued){ drawQueued=true; requestAnimationFrame(()=>{ drawQueued=false; render(); }); }
}
function paintLink(){ const el=$('linkLine'); if(el&&A.session&&A.session.state){ el.outerHTML=linkHTML(); } }

/* ---------- actions ---------- */
function go(view){ A.view=view; render(); window.scrollTo(0,0); const h=document.querySelector('#hv h1'); if(h) h.focus({preventScroll:true}); }
function edition(){ return A.editions.find(e=>e.content.id===A.pick)||null; }
async function startHerd(){
  const ed=edition(), mode=A.mode; if(!ed||A.busy.start) return;
  const nick=H.cleanText($('fNick').value,24), myAvatar=radio('myAv')||'bison';
  let name=H.cleanText(($('fName')||{}).value||'',24), teamAv=radio('teamAv')||myAvatar, teamId=null, summary=null, content=ed.content, source=ed.source;
  if(!nick){ A.form.msg='Add a nickname so your herd knows who you are.'; return render(); }
  if(mode==='practice'&&!name) name='Practice herd';
  if(name.length<3){ A.form.msg='Give your herd a name (3 to 24 characters).'; return render(); }
  A.busy.start=true; A.form.msg=''; A.form.nick=nick; render();
  try{
    if(mode==='competition'){
      const r=await rpc('hunt_create_team',{p_edition:ed.content.id,p_team_name:name,p_avatar:teamAv});
      if(r.error){ A.form.msg='Couldn’t reach BuffPrints. Check your connection and try again.'; return; }
      const d=r.data||{};
      if(d.status!=='ok'){
        A.form.msg={name_format:'Team names are 3 to 24 letters, numbers and single spaces.',name_guidelines:'That name isn’t available. Please choose another.',
                    unavailable:'This route isn’t open for competition right now.',too_many:'You’ve started several runs this week. Finish one before starting another.',bad_avatar:'Pick an avatar.'}[d.status]||'That didn’t work. Try again.';
        return;
      }
      teamId=d.team_id; summary=d; name=d.team_name; source='server';
      if(d.edition_version!==content.version){ const v=await rpc('hunt_get_edition_version',{p_edition:content.id,p_version:d.edition_version}); if(!v.error&&v.data) content=v.data; }
    }
    await dropCurrent();
    const raw=H.newHerdKey(), keys=await H.deriveKeys(raw), s=await openHerd(keys,raw);
    await s.create({mode, edition:content, source, name, avatar:teamAv, nick, myAvatar, teamId});
    if(summary){ A.comp=summary; await s.setComp({counts:summary.counts,cu:summary.cu_verified}); }
    bump('starts'); A.open=1; go('run');
  }finally{ A.busy.start=false; if(A.view!=='run') render(); }
}
/* Leave whatever herd this phone is in: tell teammates, tell the server (Competition), wipe the local copy and its keys. */
async function dropCurrent(){
  const s=A.session; if(!s) return;
  const st=s.state, id=s.channelId;
  if(st&&st.members[s.self]){
    if(st.mode==='competition'&&st.herd.teamId&&me.user) await rpc('hunt_leave_team',{p_team:st.herd.teamId});
    await s.leave();
  }
  await s.forget(); await keyDel(id); try{ sessionStorage.removeItem('bp-herd-raw:'+id); }catch(e){}
  closeSession(); activeSet(null);
}
async function beginJoin(raw){
  let keys; try{ keys=await H.deriveKeys(raw); }catch(e){ toast('That invite link isn’t valid'); return go('lobby'); }
  const s=await openHerd(keys,raw);
  if(s.state&&s.state.members[s.self]&&!(s.state.members[s.self].leftAt>0)){ await resumeComp(); A.open=nextOpen(); return go('run'); }
  A.view=s.state?'joinform':'joining'; render();
  clearTimeout(A.joinWait);
  if(!s.state) A.joinWait=setTimeout(()=>{ if(A.view==='joining'){ A.joinSlow=true; render(); } },9000);
}
async function finishJoin(){
  const s=A.session, st=s&&s.state; if(!st||A.busy.join) return;
  const nick=H.cleanText($('fNick').value,24), avatar=radio('myAv')||'bison';
  if(!nick){ A.form.msg='Add a nickname so your herd knows who you are.'; return render(); }
  A.busy.join=true; A.form.msg=''; render();
  try{
    let comp=null;
    if(st.mode==='competition'){
      const r=await rpc('hunt_join_team',{p_team:st.herd.teamId});
      if(r.error){ A.form.msg='Couldn’t reach BuffPrints. Check your connection and try again.'; return; }
      const d=r.data||{};
      if(d.status!=='ok'){
        A.form.msg={roster_locked:'This herd has already completed a checkpoint, so its roster is locked for scoring. You can start your own run of this route instead.',
                    full:'This herd is full (8 players).',expired:'This run was for an earlier week. Ask your herd to start a new one.',not_found:'This team no longer exists.'}[d.status]||'That didn’t work. Try again.';
        return;
      }
      comp={counts:d.counts,cu:d.cu_verified}; A.comp=d;
    }
    try{ await s.joinAs({nick,avatar}); }catch(e){ A.form.msg=e.message; return; }
    if(comp) await s.setComp(comp);
    if(A.comp) await applyComp(A.comp);
    bump('starts'); A.open=nextOpen(); go('run');
  }finally{ A.busy.join=false; if(A.view!=='run') render(); }
}
/* Back in a competitive herd after a reload: ask the server where things stand. */
async function resumeComp(){
  const s=A.session, st=s&&s.state; if(!st||st.mode!=='competition'||!st.herd.teamId||!me.user) return;
  const r=await rpc('hunt_join_team',{p_team:st.herd.teamId});
  if(!r.error&&r.data&&r.data.status==='ok') await applyComp(r.data);
}
function nextOpen(){ const s=A.session; for(let cp=1;cp<=H.CHECKPOINTS;cp++) if(H.checkpointStatus(s.state,s.self,cp)!=='done') return cp; return 0; }
function cpOf(no){ return A.session.state.edition.checkpoints[no-1]; }

async function checkInHere(no){
  const s=A.session, cp=cpOf(no); if(A.busy['gps'+no]) return;
  A.busy['gps'+no]=true; A.gps[no]={state:'checking'}; render();
  const r=await locate(cp,g=>{ if(A.gps[no]&&A.gps[no].state==='checking'){ A.gps[no].fence=g; render(); } });
  A.busy['gps'+no]=false;
  if(r.fence&&r.fence.inside){ A.gps[no]=null; await arrived(no,'gps'); }
  else{ A.gps[no]={state:r.error||r.fence.state, fence:r.fence}; render(); }
}
async function arrived(no,via,by){
  const s=A.session; await s.arrive(no,via,by);
  toast((via==='sim'?'Simulated check-in at ':'Checked in at ')+cpOf(no).name); A.open=no; render();
}
async function submitAnswer(no){
  const s=A.session, st=s.state, inp=$('ans'+no), val=inp?inp.value.trim():''; if(A.busy['ans'+no]) return;
  if(!H.normalizeAnswer(val)){ note(no,'Type an answer first.','bad'); return render(); }
  A.busy['ans'+no]=true; note(no,null); render();
  try{
    if(st.mode==='competition'){
      if(!me.user){ note(no,'Sign in again to keep scoring.','warn'); return; }
      const d=await credit(no,val);
      if(d&&(d.status==='ok'||d.status==='already')){ await s.solve(no,val); await s.credit(no); solvedToast(no); }
      else if(d&&d.status==='wrong_answer') note(no,'Not quite. Have another look — there’s no penalty for trying.','bad');
    }else{
      let ok; try{ ok=await checkAnswer(st,no,val); }catch(e){ note(no,'Couldn’t check that just now. Check your connection and try again.','warn'); return; }
      if(ok){ await s.solve(no,val); solvedToast(no); } else note(no,'Not quite. Have another look — there’s no penalty for trying.','bad');
    }
  }finally{ A.busy['ans'+no]=false; render(); }
}
function solvedToast(no){ toast('Solved: '+cpOf(no).name); const n=nextOpen(); if(n) A.open=n; }
async function revealHint(no){
  const s=A.session, st=s.state, p=st.puzzles[no]||{hints:0}; if(A.busy['hint'+no]||p.solvedAt||p.hints>=H.MAX_HINTS) return;
  A.busy['hint'+no]=true; render();
  try{
    if(st.mode==='competition'){
      const r=await rpc('hunt_use_hint',{p_team:st.herd.teamId,p_checkpoint:no});
      if(r.error){ note(no,'Couldn’t reach BuffPrints. Try again.','warn'); return; }
      if(r.data&&r.data.hints_used!=null) await s.setHints(no,r.data.hints_used);
      if(r.data&&r.data.status==='ok') bump('hints_used','hint:'+no+':'+r.data.hints_used);
    }else{ const n=await s.hint(no); bump('hints_used','hint:'+no+':'+n); }
  }finally{ A.busy['hint'+no]=false; render(); }
}

/* ---------- phone-to-phone: invite, rolling code, clue pieces, scanner ---------- */
function showInvite(){
  const s=A.session, raw=A.raw;
  if(!raw) return modal('Invite teammates','<p>For safety, this phone only keeps the invite key while the page stays open. Ask a teammate to show the herd’s QR code, or open your original invite link again to invite more people.</p>',[['OK','pri',()=>{}]]);
  const url=H.inviteUrl(location.origin+location.pathname,raw);
  const locked=s.state.mode==='competition'&&s.state.rosterLockedAt;
  modal('Invite teammates',(locked?'<p class="msg warn">Your roster is locked for scoring because you’ve completed a checkpoint. New players can’t join this competitive run.</p>':'')+
    '<p>Have a teammate scan this with their phone camera. Share it in person: anyone with this code can join your herd and see what you share.</p>'+qrSvg(url)+
    '<label class="f" for="invUrl">Or send the link</label><input class="field" id="invUrl" readonly value="'+esc(url)+'">',
    [['Copy link','pri',()=>copyText(url),null,'stay']].concat(navigator.share?[['Share…','',()=>{ navigator.share({title:'Find the Herd',text:'Join my herd on BuffPrints',url}).catch(()=>{}); },null,'stay']]:[]).concat([['Done','',()=>{}]]));
}
async function copyText(t){ try{ await navigator.clipboard.writeText(t); toast('Link copied'); }catch(e){ const i=$('invUrl'); if(i){ i.focus(); i.select(); toast('Select and copy the link'); } } }
function showCode(no){
  const s=A.session; let lastW=-1, timer=0;
  modal('Your check-in code','<p>A teammate standing with you can scan this (or type the six digits) to check in at '+esc(cpOf(no).name)+'. It also stamps you both as “together”.</p><div id="codeBox"></div><p class="small muted" style="text-align:center">It changes every few seconds, so a screenshot won’t work.</p>',
    [['Done','pri',()=>{}]],()=>clearInterval(timer));
  const tick=async()=>{
    const c=await H.presenceCode(s.keys,s.self,no,Date.now()), box=$('codeBox'); if(!box) return;
    if(c.window!==lastW){ lastW=c.window; box.innerHTML=qrSvg(c.text)+'<div class="digits" id="codeDigits">'+c.digits.slice(0,3)+' '+c.digits.slice(3)+'</div><div class="roll"><i id="rollBar"></i></div>'; }
    const b=$('rollBar'); if(b) b.style.width=Math.max(4,Math.round(c.msLeft/H.ROLL_MS*100))+'%';
  };
  tick(); timer=setInterval(tick,500);
}
async function showPiece(no,idx){
  const s=A.session, text=await H.pieceCode(s.keys,no,idx);
  modal('Pass this clue','<p>Have a teammate scan this to copy piece '+(idx+1)+' to their phone.</p>'+qrSvg(text),[['Done','pri',()=>{}]]);
}
let scan={stream:null, raf:0, ctx:null, busy:false};
function stopScan(){ cancelAnimationFrame(scan.raf); if(scan.stream) scan.stream.getTracks().forEach(t=>t.stop()); scan.stream=null; scan.busy=false; }
async function openScanner(ctx){
  scan.ctx=ctx||{};
  const typed=scan.ctx.cp?'Or type the six digits from their screen':'Or paste an invite link';
  modal(scan.ctx.cp?'Use a teammate’s code':'Scan a code','<div class="scanwrap"><video id="scanVideo" playsinline muted></video></div><p class="msg" id="scanMsg" role="status">Starting the camera…</p>'+
    '<label class="f" for="scanText">'+typed+'</label><div class="ans" style="margin-top:4px"><input class="field" id="scanText" autocomplete="off" autocapitalize="off" spellcheck="false" '+(scan.ctx.cp?'inputmode="numeric" maxlength="7" placeholder="123 456"':'placeholder="https://…#key=…"')+' data-enter="scanTyped"><button class="btn" data-act="scanTyped">Use</button></div>',
    [['Close','',()=>{}]],stopScan);
  const say=t=>{ const m=$('scanMsg'); if(m) m.textContent=t; };
  if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia) return say('This browser can’t open the camera here. Use the box below instead.');
  try{
    scan.stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}},audio:false});
    const v=$('scanVideo'); if(!v){ stopScan(); return; }
    v.srcObject=scan.stream; await v.play();
    if(!window.jsQR) await loadScript('vendor/jsqr.min.js?v=28');
    say('Point the camera at the QR code on your teammate’s screen.');
    const canvas=document.createElement('canvas'), g=canvas.getContext('2d',{willReadFrequently:true}); let last=0;
    const loop=ts=>{
      scan.raf=requestAnimationFrame(loop);
      if(ts-last<160||scan.busy||!v.videoWidth) return; last=ts;
      const k=Math.min(1,640/Math.max(v.videoWidth,v.videoHeight)); canvas.width=Math.round(v.videoWidth*k); canvas.height=Math.round(v.videoHeight*k);
      g.drawImage(v,0,0,canvas.width,canvas.height);
      const img=g.getImageData(0,0,canvas.width,canvas.height), hit=window.jsQR(img.data,img.width,img.height,{inversionAttempts:'dontInvert'});
      if(hit&&hit.data){ scan.busy=true; handleScan(hit.data).then(done=>{ if(!done) setTimeout(()=>{ scan.busy=false; },1200); }); }
    };
    scan.raf=requestAnimationFrame(loop);
  }catch(e){ say(e&&e.name==='NotAllowedError'?'Camera access is off for this site. You can turn it on in your browser settings, or use the box below.':'Couldn’t start the camera. Use the box below instead.'); }
}
/* Returns true when the scan was used (and the scanner should close). */
async function handleScan(text){
  const s=A.session, ctx=scan.ctx||{}, say=t=>{ const m=$('scanMsg'); if(m) m.textContent=t; else toast(t); };
  const digits=String(text).replace(/\s/g,''), kind=/^\d{6}$/.test(digits)?'digits':H.scanKind(text);
  if(kind==='invite'){ const raw=H.parseInvite(text); closeModal(); await askJoin(raw); return true; }
  if(!s||!s.state||!s.state.members[s.self]){ say('That code belongs to a herd. Scan the herd’s invite code first.'); return false; }
  const st=s.state;
  if(kind==='piece'){
    const v=await H.verifyPiece(s.keys,text);
    if(!v.ok){ say('That clue is from a different herd.'); return false; }
    await s.setFlag('pc:'+v.cp+':'+v.idx); closeModal(); toast('Got clue piece '+(v.idx+1)+' for '+cpOf(v.cp).name); A.open=v.cp; render(); return true;
  }
  if(kind==='presence'||kind==='digits'){
    const peers=H.activeMembers(st).filter(id=>id!==s.self&&ctx.cp&&st.members[id].prox&&st.members[id].prox[ctx.cp]);
    const v=await H.verifyPresence(s.keys,kind==='digits'?digits:text,Date.now(),{self:s.self,cp:ctx.cp||undefined,peers});
    if(!v.ok){
      say({stale:'That code has expired. Ask them to hold up the live code and scan again.',self:'That’s your own code.',other_checkpoint:'That code is for a different checkpoint.',
           wrong:kind==='digits'?'Those digits don’t match a teammate who’s checked in here. Codes change every few seconds — try the current one.':'That code isn’t from your herd.'}[v.reason]||'That isn’t a Find the Herd code.');
      return false;
    }
    const peer=st.members[v.peerId];
    if(!peer||!peer.prox||!peer.prox[v.cp]){ say('Your phone hasn’t heard that this teammate is checked in here yet. Give it a second and try again.'); return false; }
    closeModal();
    const had=!!(st.members[s.self].prox||{})[v.cp];
    if(!had) await arrived(v.cp,'vouch',v.peerId);
    await s.together(v.cp,v.peerId);
    if(had) toast('Together with '+peer.nick+' at '+cpOf(v.cp).name);
    return true;
  }
  say('That isn’t a Find the Herd code.'); return false;
}
async function askJoin(raw){
  const s=A.session;
  if(s&&s.state&&s.state.members[s.self]){
    let same=false; try{ same=(await H.deriveKeys(raw)).channelId===s.channelId; }catch(e){}
    if(same){ toast('You’re already in this herd'); return go('run'); }
    return modal('Switch herds?','<p>You’re in <b>'+esc(s.state.herd.name)+'</b>. Joining another herd leaves this one on this phone.'+(s.state.mode==='competition'?' Any checkpoints you’ve completed stay on your record.':'')+'</p>',
      [['Join the new herd','pri',async()=>{ await dropCurrent(); beginJoinFlow(raw); }],['Stay here','',()=>{}]]);
  }
  beginJoinFlow(raw);
}
function beginJoinFlow(raw){ A.pendingJoin=raw; A.mode=null; A.form={}; go('privacy'); }

async function leaveHerd(how){
  const s=A.session; if(!s) return go('lobby');
  const st=s.state, id=s.channelId;
  if(how==='solo'){
    // keep my progress and my place on the team, on a new private key nobody else holds
    const mine=JSON.parse(JSON.stringify(st)); const m=mine.members[s.self]; mine.members={}; m.together={}; mine.members[s.self]=m; mine.herd.at=Date.now();
    await s.leave(); await s.forget(); await keyDel(id); try{ sessionStorage.removeItem('bp-herd-raw:'+id); }catch(e){}
    const raw=H.newHerdKey(), keys=await H.deriveKeys(raw), comp=A.comp, s2=await openHerd(keys,raw);
    await s2.adopt(mine,s.self); A.comp=comp; toast('You’re finishing solo. Your credit so far is kept.'); return go('run');
  }
  await dropCurrent(); go('lobby');
}
function confirmLeave(){
  const s=A.session, st=s.state, comp=st.mode==='competition', mine=Object.keys(st.members[s.self].prox||{}).length, others=H.activeMembers(st).length>1;
  const btns=[];
  if(comp&&others&&mine) btns.push(['Leave and finish solo','pri',()=>leaveHerd('solo')]);
  btns.push([comp&&mine?'Leave and stop playing':'Leave herd','danger',()=>leaveHerd('stop')],['Stay','',()=>{}]);
  modal('Leave this herd?','<p>'+(comp?(mine?'You keep credit for the '+pl(mine,'checkpoint')+' you’ve completed. You can finish the rest on your own, and your points still count for the team.':'You haven’t checked in anywhere yet, so you’ll simply be removed from the team.')
    :'This removes the herd and your progress from this phone. Nothing was saved anywhere else.')+'</p>',btns);
}

/* ---------- sign-in (same email-code flow as the main app) ---------- */
function signinHTML(why){
  const si=A.signin;
  if(!sb) return '<div class="card"><b>Competition Mode needs the online service</b><p>It isn’t set up in this copy of BuffPrints. Friends Mode and Demo Practice work without it.</p></div>';
  return '<div class="card"><b>Sign in to '+esc(why)+'</b><p class="small muted" style="margin-top:4px">Any email works. A colorado.edu address makes you eligible for standings and demo rewards. We never show your email to anyone.</p>'+
    (si.step==='email'
      ?'<label class="f" for="siEmail">Email</label><input class="field" id="siEmail" type="email" autocomplete="email" inputmode="email" placeholder="you@colorado.edu" value="'+esc(si.email)+'" data-enter="siSend"><button class="btn pri block-btn" data-act="siSend"'+(A.busy.si?' disabled':'')+'>Email me a code</button>'
      :'<p class="small" style="margin-top:8px">We sent a 6-digit code to '+esc(si.email)+'.</p><label class="f" for="siCode">Code</label><input class="field" id="siCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456" data-enter="siVerify"><div class="rowbtns"><button class="btn pri" data-act="siVerify"'+(A.busy.si?' disabled':'')+'>Sign in</button><button class="btn" data-act="siBack">Use a different email</button></div>')+
    (si.msg?'<p class="msg bad" role="alert">'+esc(si.msg)+'</p>':'')+'</div>';
}
async function siSend(){
  const email=($('siEmail').value||'').trim().toLowerCase(); if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)){ A.signin.msg='Enter your email address.'; return render(); }
  A.busy.si=true; A.signin.msg=''; A.signin.email=email; render();
  const {error}=await sb.auth.signInWithOtp({email,options:{emailRedirectTo:new URL('./',location.href).href,shouldCreateUser:true}});
  A.busy.si=false; if(error) A.signin.msg=error.message||'Couldn’t send the code.'; else A.signin.step='code'; render();
}
async function siVerify(){
  const token=($('siCode').value||'').trim(); if(!/^\d{6}$/.test(token)){ A.signin.msg='Enter the 6-digit code from the email.'; return render(); }
  A.busy.si=true; A.signin.msg=''; render();
  const {error}=await sb.auth.verifyOtp({email:A.signin.email,token,type:'email'});
  A.busy.si=false; if(error){ A.signin.msg='That code didn’t work. Check it and try again.'; return render(); }
  A.signin={step:'email',email:'',msg:''};
}
function eligibilityHTML(){
  const w=me.who; if(!w) return '';
  return w.cu_verified
    ?'<p class="small" style="margin:8px 0 0"><span class="pill good">✓ colorado.edu verified</span> Eligible for weekly standings and demo rewards'+(w.affiliation?', playing for <b>'+esc(w.affiliation)+'</b>.':'. Add your dorm or team in BuffPrints to play for it.')+'</p>'
    :'<p class="small" style="margin:8px 0 0"><span class="pill">Guest</span> You can play the whole hunt. Standings and demo rewards are for verified colorado.edu addresses, so this run won’t be listed.</p>';
}
async function loadWho(){ me.who=null; if(!me.user) return; const r=await rpc('hunt_whoami'); if(!r.error) me.who=r.data; }

/* ---------- screens ---------- */
const PRIVACY_POINTS={
  herd:['Your herd sees your nickname, avatar and progress','They travel phone to phone, scrambled with a key that exists only in your invite link. Our servers pass the scrambled messages along and can’t read them.'],
  gps:['Your location stays on this phone','When you tap Check in, the phone compares its own GPS with the checkpoint and reports only “I’m inside: yes”. Exact coordinates are never sent and never stored — not even on this phone.'],
  friends:['Friends Mode saves nothing about you','No sign-in, no standings, no rewards. Your herd’s progress lives on your phones and nowhere else.'],
  competition:['Competition Mode saves the minimum','To your account: which checkpoints you completed and when. For your team: its name, avatar, hints used and score. Public standings show team and dorm or team names only — never who is on a team.'],
  practice:['Demo Practice is a sandbox','Check-ins are simulated on this phone. It earns no points and no rewards, and nothing is saved anywhere.'],
  counts:['We count totals, not people','Anonymous counters such as “runs started: 41”. No IDs, no times, nothing tied to you.']
};
function privacyHTML(mode){
  const items=['herd','gps',mode||'friends'].concat(mode==='practice'?[]:['counts']);
  return '<ul class="summary-list">'+items.map(k=>'<li><b>'+PRIVACY_POINTS[k][0]+'</b>'+PRIVACY_POINTS[k][1]+'</li>').join('')+'</ul>';
}
function fullPrivacy(){
  modal('Find the Herd and your privacy','<div class="privacy">'+['herd','gps','friends','competition','practice','counts'].map(k=>'<h4>'+PRIVACY_POINTS[k][0]+'</h4><p>'+PRIVACY_POINTS[k][1]+'</p>').join('')+
    '<h4>Deleting it</h4><p>Leave a herd to remove it from this phone. Deleting your BuffPrints account (Progress → Privacy &amp; delete my data) also deletes every check-in, team membership and reward token.</p>'+
    '<p>The full notice is in BuffPrints under Progress → Privacy &amp; delete my data.</p></div>',[['Close','pri',()=>{}]]);
}
function lobbyHTML(){
  let h='<h1 class="title" tabindex="-1">Find the Herd</h1><p class="lead">Five outdoor checkpoints, five puzzles, about 20 to 40 minutes. Go solo or bring friends.</p>';
  h+='<div class="label">Pick a route</div>';
  h+=A.editions.length?A.editions.map(e=>{ const c=e.content; return '<button class="card" data-act="pick" data-id="'+esc(c.id)+'">'+(c.demo?'<span class="pill gold">Demo route</span> ':'')+
      '<h3 style="margin-top:6px">'+esc(c.title)+'</h3><div class="sub">'+esc(c.theme)+' · '+esc(c.style)+'</div><p>'+esc(c.intro)+'</p></button>'; }).join('')
    :'<p class="empty">No routes are open right now. Check back soon.</p>';
  h+='<div class="label">Joining friends?</div><div class="card"><b>Join a herd</b><p>Scan the QR code on a teammate’s screen, or open the link they sent you.</p><div class="rowbtns"><button class="btn pri" data-act="scanJoin">Scan a code</button></div></div>';
  h+='<div class="label">More</div><div class="list">'+
    '<button class="row" data-act="standings"><span class="grow"><b>Weekly standings</b><small>Herds and dorms, Monday to Sunday</small></span><span class="chev" aria-hidden="true">›</span></button>'+
    '<button class="row" data-act="wallet"><span class="grow"><b>Reward wallet</b><small>Demo rewards from finished competitive runs</small></span><span class="chev" aria-hidden="true">›</span></button>'+
    '<button class="row" data-act="privacy"><span class="grow"><b>How your privacy works here</b><small>What your herd sees, and what never leaves your phone</small></span><span class="chev" aria-hidden="true">›</span></button>'+
    (me.who&&me.who.admin?'<a class="row" href="herd-admin.html" style="text-decoration:none;color:inherit"><span class="grow"><b>Hunt admin</b><small>Routes, checkpoints and counters</small></span><span class="chev" aria-hidden="true">›</span></a>':'')+'</div>';
  return h;
}
function modeHTML(){
  const e=edition(); if(!e) return lobbyHTML(); const c=e.content, compOk=!!sb&&A.serverOk;
  return '<button class="link" data-act="lobby">‹ All routes</button><h1 class="title" tabindex="-1">'+esc(c.title)+'</h1><p class="lead">'+esc(c.theme)+' · '+esc(c.style)+'</p>'+
    '<p style="margin:0 0 6px">'+esc(c.intro)+'</p><p class="small muted" style="margin:0 0 14px">5 checkpoints · '+c.est_minutes[0]+'–'+c.est_minutes[1]+' minutes including puzzles · about '+c.walk_minutes[0]+'–'+c.walk_minutes[1]+' minutes of walking · all outdoors</p>'+
    '<div class="label">How do you want to play?</div>'+
    '<button class="card" data-act="mode" data-mode="friends"><h3>Friends</h3><div class="sub">No sign-in · nothing saved on our servers</div><p>Casual play with whoever you invite. No standings, no rewards.</p></button>'+
    '<button class="card" data-act="mode" data-mode="competition"'+(compOk?'':' disabled')+'><h3>Competition</h3><div class="sub">Sign in · weekly standings · demo reward</div><p>'+(compOk?'Score for your herd and your dorm or team. Your first run of each route is the one that counts.':'Needs the online service, which isn’t reachable right now.')+'</p></button>'+
    '<button class="card" data-act="mode" data-mode="practice"><h3>Demo Practice</h3><div class="sub">Try it from anywhere · simulated check-ins</div><p>See how it works without walking the route. No points, no rewards.</p></button>';
}
function privacyViewHTML(){
  const joining=!!A.pendingJoin, mode=A.mode;
  return '<button class="link" data-act="'+(joining?'lobby':'backToMode')+'">‹ Back</button><h1 class="title" tabindex="-1">Before you '+(joining?'join':'start')+'</h1>'+
    privacyHTML(joining?null:mode)+(joining?'<p class="small muted">If your herd is playing Competition Mode you’ll be asked to sign in, and your completed checkpoints will be saved to your account.</p>':'')+
    '<button class="btn pri block-btn" data-act="privacyOk">Sounds good</button><p style="text-align:center;margin:6px 0 0"><button class="link" data-act="privacyFull">Read the details</button></p>';
}
function setupHTML(){
  const e=edition(), mode=A.mode, comp=mode==='competition', f=A.form;
  let h='<button class="link" data-act="backToMode">‹ Back</button><h1 class="title" tabindex="-1">'+(mode==='practice'?'Set up a practice run':'Start a herd')+'</h1><p class="lead">'+esc(e.content.title)+' · '+({friends:'Friends',competition:'Competition',practice:'Demo Practice'}[mode])+'</p>';
  if(comp&&!me.user) return h+signinHTML('compete');
  const nick=f.nick!=null?f.nick:(me.who&&me.who.nickname&&!/^Buff [0-9A-F]{4}$/.test(me.who.nickname)?me.who.nickname:'');
  h+='<div class="card">'+(comp?eligibilityHTML().replace('margin:8px 0 0','margin:0 0 10px'):'')+
    '<label class="f" for="fNick">Your nickname</label><input class="field" id="fNick" maxlength="24" autocomplete="nickname" placeholder="What your herd calls you" value="'+esc(nick)+'"><p class="note" style="margin:-6px 0 8px">Only your herd sees this.</p>'+
    avatarPicker('myAv','Your avatar',f.myAv||'bison')+
    '<label class="f" for="fName">'+(comp?'Team name':'Herd name')+'</label><input class="field" id="fName" maxlength="24" placeholder="'+(comp?'Shown on public standings':'Only your herd sees this')+'" value="'+esc(f.name||(mode==='practice'?'Practice herd':''))+'" data-enter="start">'+
    (comp?'<p class="note" style="margin:-6px 0 8px">Public on the weekly standings. Letters, numbers and spaces; keep it friendly.</p>'+avatarPicker('teamAv','Team avatar',f.teamAv||'bison'):'')+
    (f.msg?'<p class="msg bad" role="alert">'+esc(f.msg)+'</p>':'')+
    '<button class="btn pri block-btn" data-act="start"'+(A.busy.start?' disabled':'')+'>'+(A.busy.start?'Starting…':'Start')+'</button>'+
    '<p class="note">You can invite teammates on the next screen'+(comp?', until your herd completes its first checkpoint.':'.')+'</p></div>';
  return h;
}
function joiningHTML(){
  return '<h1 class="title" tabindex="-1">Looking for your herd…</h1><p class="lead">Your phone is asking a teammate’s phone for the herd.</p>'+
    (A.joinSlow?'<div class="statusbox warn" role="status"><b>No teammate’s phone has answered yet</b>The herd lives on your teammates’ phones, not on a server, so at least one of them needs Find the Herd open and online. Ask them to open it, then try again.</div><div class="rowbtns"><button class="btn pri" data-act="retryJoin">Try again</button><button class="btn" data-act="cancelJoin">Cancel</button></div>'
               :'<p class="empty">Connecting…</p><button class="btn" data-act="cancelJoin">Cancel</button>');
}
function joinFormHTML(){
  const st=A.session.state, comp=st.mode==='competition', f=A.form;
  let h='<h1 class="title" tabindex="-1">Join '+esc(st.herd.name)+'</h1><p class="lead">'+esc(st.edition.title)+' · '+({friends:'Friends',competition:'Competition',practice:'Demo Practice'}[st.mode])+' · '+pl(H.activeMembers(st).length,'player')+' so far</p>';
  if(st.mode==='practice') h+='<div class="statusbox warn"><b>This is a Demo Practice herd</b>Check-ins are simulated. No points or rewards.</div>';
  if(comp&&!me.user) return h+signinHTML('join this competitive herd')+'<button class="btn" data-act="cancelJoin" style="margin-top:6px">Cancel</button>';
  const nick=f.nick!=null?f.nick:(me.who&&me.who.nickname&&!/^Buff [0-9A-F]{4}$/.test(me.who.nickname)?me.who.nickname:'');
  h+='<div class="card">'+(comp?eligibilityHTML().replace('margin:8px 0 0','margin:0 0 10px'):'')+
    (comp&&st.rosterLockedAt?'<p class="msg warn" style="margin:0 0 10px">This herd has completed a checkpoint, so its roster is locked. Unless you were already on the team, you won’t be able to join this run.</p>':'')+
    '<label class="f" for="fNick">Your nickname</label><input class="field" id="fNick" maxlength="24" autocomplete="nickname" placeholder="What your herd calls you" value="'+esc(nick)+'" data-enter="join"><p class="note" style="margin:-6px 0 8px">Only your herd sees this.</p>'+
    avatarPicker('myAv','Your avatar',f.myAv||'fox')+(f.msg?'<p class="msg bad" role="alert">'+esc(f.msg)+'</p>':'')+
    '<div class="rowbtns"><button class="btn pri" data-act="join"'+(A.busy.join?' disabled':'')+'>'+(A.busy.join?'Joining…':'Join herd')+'</button><button class="btn" data-act="cancelJoin">Cancel</button></div></div>';
  return h;
}
function linkHTML(){
  const st=A.session.state, n=H.activeMembers(st).length-1;
  const t={live:n?'Live with '+pl(n,'teammate')+' · encrypted':'Connected · encrypted · invite teammates any time',retry:'Reconnecting… your progress is saved on this phone',
           off:'Offline · your progress is saved on this phone',local:'This device only (online service not set up)',solo:'Solo on this phone'}[A.link]||'Connecting…';
  return '<div class="link-line '+(A.link==='live'?'live':A.link==='retry'?'retry':'')+'" id="linkLine" role="status"><i aria-hidden="true"></i><span>'+t+'</span></div>';
}
function piecesHTML(no,pz,here){
  const s=A.session, st=s.state, act=H.activeMembers(st), deal=H.assignPieces(pz.pieces.length,act,no), mine=deal[s.self]||[];
  const shared=(st.puzzles[no]&&st.puzzles[no].shared)||{}, all=!!s.flags['all:'+no], solo=act.length===1;
  if(solo&&!all) return '<div class="statusbox"><b>This is a split-clue puzzle</b>In a herd, each phone gets one piece. You’re playing solo, so one tap puts every piece on your screen.</div><button class="btn block-btn" style="margin-top:8px" data-act="allPieces" data-no="'+no+'">Combine the clues (solo)</button>';
  const holder=i=>{ const id=Object.keys(deal).find(k=>deal[k].indexOf(i)>=0); return id&&st.members[id]?st.members[id].nick:'a teammate'; };
  return '<ul class="pieces">'+pz.pieces.map((text,i)=>{
    const own=mine.indexOf(i)>=0, have=all||own||shared[i]||s.flags['pc:'+no+':'+i];
    if(!have) return '<li class="missing"><small>Piece '+(i+1)+'</small>On '+esc(holder(i))+'’s phone. Scan it from their screen, or ask them to send it to the herd.</li>';
    return '<li><small>Piece '+(i+1)+(own&&!solo?' · yours':shared[i]?' · shared with the herd':'')+'</small>'+esc(text)+
      (own&&!solo&&!shared[i]?'<div class="pbtns"><button data-act="pieceQr" data-no="'+no+'" data-i="'+i+'">Show QR</button><button data-act="pieceSend" data-no="'+no+'" data-i="'+i+'">Send to herd</button></div>':'')+'</li>';
  }).join('')+'</ul>'+(!solo&&!all?'<div class="rowbtns"><button class="btn sm" data-act="scan">Scan a piece</button><button class="btn sm" data-act="allPieces" data-no="'+no+'">Teammates not here? Show every piece</button></div>':'');
}
function cpHTML(c){
  const s=A.session, st=s.state, no=c.no, status=H.checkpointStatus(st,s.self,no), pz=c.puzzle, p=st.puzzles[no]||{hints:0,shared:{}};
  const here=status==='here'||status==='crediting'||status==='done', open=A.open===no, practice=st.mode==='practice';
  const pts=p.solvedAt?H.puzzlePoints(p.hints):0, via=((st.members[s.self].prox||{})[no]||{}).via;
  const pill={todo:'',unlocked:'<span class="pill gold">Puzzle open</span>',here:'<span class="pill dark">You’re here</span>',solved:'<span class="pill gold">Solved · check in</span>',
              crediting:'<span class="pill">Saving…</span>',done:'<span class="pill good">Done'+(practice?'':' · '+pts)+'</span>'}[status];
  let h='<section class="cp '+status+'" aria-label="Checkpoint '+no+': '+esc(c.name)+'"><button class="hd" data-act="open" data-no="'+no+'" aria-expanded="'+open+'"><span class="num" aria-hidden="true">'+(status==='done'?'✓':no)+'</span><span class="grow"><b>'+esc(c.name)+'</b><small>'+esc(c.spot)+'</small></span>'+pill+'</button>';
  if(!open) return h+'</section>';
  h+='<div class="body"><p class="where">'+esc(c.entrance_note)+'</p>'+(c.access_note?'<p class="where muted">'+esc(c.access_note)+'</p>':'')+
     (c.needs_onsite_check?'<p class="flag">Demo route: this spot and its notes haven’t been checked on site yet.</p>':'');
  if(!here){
    const canVouch=H.activeMembers(st).some(id=>id!==s.self&&st.members[id].prox&&st.members[id].prox[no]);
    h+='<div class="rowbtns"><button class="btn pri" data-act="checkin" data-no="'+no+'"'+(A.busy['gps'+no]?' disabled':'')+'>'+(A.busy['gps'+no]?'Checking…':A.gps[no]?'Try again':'Check in here')+'</button>'+
       (canVouch?'<button class="btn" data-act="vouch" data-no="'+no+'">Use a teammate’s code</button>':'')+
       (practice?'<button class="btn warn" data-act="sim" data-no="'+no+'">Simulate arriving</button>':'')+'</div>'+
       (status==='todo'&&!A.gps[no]?'<p class="note">Your phone checks its own location when you tap. Nothing is sent but “inside: yes”.</p>':'')+gpsHTML(A.gps[no],c,canVouch,practice);
  }else if(via&&via!=='gps') h+='<span class="stamp">'+(via==='sim'?'Simulated check-in':via==='vouch'?'Checked in with a teammate’s code':'Checked in')+'</span>';
  if(status!=='todo'){
    h+='<div class="puzzle"><p class="q">'+esc(pz.prompt)+'</p>'+(pz.format?'<p class="fmt">Answer: '+esc(pz.format)+'</p>':'');
    if(pz.kind==='split'&&pz.pieces.length) h+=piecesHTML(no,pz,here);
    if(p.hints) h+='<ul class="hintlist" aria-label="Hints">'+pz.hints.slice(0,p.hints).map((t,i)=>'<li><b>Hint '+(i+1)+':</b> '+esc(t)+'</li>').join('')+'</ul>';
    if(p.solvedAt){
      const by=st.members[p.solvedBy]; h+='<p class="msg good">Solved'+(by?' by '+esc(by.nick):'')+(p.answer?': <b>'+esc(p.answer)+'</b>':'')+(practice?'':' · worth '+pts+' points')+'</p>';
      if(!here) h+='<p class="msg">Your herd solved it. Check in here yourself to get your own credit.</p>';
    }else if(here){
      h+='<div class="ans"><label class="sr" for="ans'+no+'">Your answer</label><input class="field" id="ans'+no+'" maxlength="80" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Your answer" data-enter="answer" data-no="'+no+'"><button class="btn pri" data-act="answer" data-no="'+no+'"'+(A.busy['ans'+no]?' disabled':'')+'>'+(A.busy['ans'+no]?'Checking…':'Submit')+'</button></div>'+
         (p.hints<H.MAX_HINTS?'<div class="rowbtns"><button class="btn sm" data-act="hint" data-no="'+no+'"'+(A.busy['hint'+no]?' disabled':'')+'>Reveal hint '+(p.hints+1)+(practice?'':' (−'+H.HINT_COST+' points)')+'</button></div>':'<p class="note">Both hints are showing. This checkpoint is worth '+H.MIN_POINTS+' points now — it can’t go lower.</p>');
    }else h+='<p class="msg">A teammate unlocked this puzzle. You can read along now; check in here to answer and get credit.</p>';
    if(A.msg[no]) h+='<p class="msg '+A.msg[no].cls+'" role="alert">'+esc(A.msg[no].text)+'</p>';
    h+='</div>';
  }
  if(here){
    const tg=(st.members[s.self].together||{})[no]||[];
    if(tg.length) h+='<span class="stamp">Together with '+tg.map(id=>esc((st.members[id]||{}).nick||'a teammate')).join(', ')+'</span>';
    if(H.activeMembers(st).length>1) h+='<div class="rowbtns"><button class="btn sm" data-act="code" data-no="'+no+'">Show my code</button><button class="btn sm" data-act="vouch" data-no="'+no+'">Scan a teammate</button></div><p class="note">“We’re together”: scan each other’s live code at a checkpoint for a stamp. It’s also how a teammate with weak GPS checks in.</p>';
  }
  return h+'</div></section>';
}
function finishHTML(){
  const s=A.session, st=s.state, sc=H.herdScore(st), comp=st.mode==='competition', c=A.comp||{}, first=!A.celebrated; A.celebrated=true;
  let h='<div class="card gold finish'+(first?' in':'')+'" role="status"><span class="pill gold">All five checkpoints</span>';
  if(st.mode==='practice') h+='<h2 style="margin-top:8px">Practice complete</h2><p>That’s how a hunt works. Nothing was saved, and no points or rewards were earned.</p><div class="rowbtns"><button class="btn pri" data-act="playAgain">Play a route for real</button></div>';
  else{
    const team=comp&&c.team_score!=null?c.team_score:sc.team;
    h+='<div class="score" style="margin-top:8px">'+team+'</div><div class="of">of 600 · '+(comp?'team score':'herd score, just for fun')+'</div>';
    if(comp){
      if(A.token) h+='<div class="token'+(A.token.status==='used'?' used':'')+'">'+esc(A.token.token)+'</div><div class="demo-note">'+DEMO_NOTE+'</div>';
      else if(c.reward_note==='not_cu'||c.cu_verified===false) h+='<p>Nice work. Demo rewards and standings are for verified colorado.edu addresses, so this run isn’t listed.</p>';
      else if(c.reward_note==='repeat_run'||c.counts===false) h+='<p>Nice work. This was a repeat run, so it doesn’t change the standings — your first run of this route is the one that counts.</p>';
      h+='<div class="rowbtns"><button class="btn pri" data-act="standings">See standings</button><button class="btn" data-act="wallet">Reward wallet</button></div>';
    }else h+='<p>Friends Mode isn’t on the standings and saves nothing. Want it to count? Start a Competition run.</p><div class="rowbtns"><button class="btn pri" data-act="playAgain">Play another route</button></div>';
  }
  return h+'</div>';
}
function runHTML(){
  const s=A.session, st=s.state, sc=H.herdScore(st), act=H.activeMembers(st), comp=st.mode==='competition', practice=st.mode==='practice', c=A.comp||{};
  let h=practice?'<div class="practice-bar" role="note">DEMO PRACTICE · simulated check-ins · 0 points · no rewards</div>':'';
  h+='<div class="herdhead"><div class="big" aria-hidden="true">'+av(st.herd.avatar)+'</div><div class="grow"><h1 class="title" tabindex="-1" style="margin:0">'+esc(st.herd.name)+'</h1><div class="small muted">'+esc(st.edition.title)+' · '+esc(st.edition.theme)+' · '+({friends:'Friends',competition:'Competition',practice:'Demo Practice'}[st.mode])+'</div></div></div>'+linkHTML();
  h+='<div class="members" aria-label="Your herd">'+Object.keys(st.members).sort((a,b)=>(a===s.self?-1:b===s.self?1:(st.members[a].joinedAt||0)-(st.members[b].joinedAt||0))).map(id=>{
    const m=st.members[id], left=m.leftAt>0;
    return '<div class="mem'+(id===s.self?' self':'')+(left?' away':'')+'"><span class="a" aria-hidden="true">'+av(m.avatar)+'</span><b>'+esc(m.nick)+(id===s.self?' (you)':'')+'</b><small>'+(left?'Left':sc.members[id].done+' of 5')+'</small>'+
      '<div class="dots" aria-hidden="true">'+[1,2,3,4,5].map(cp=>{ const x=H.checkpointStatus(st,id,cp); return '<i class="'+(x==='done'||x==='crediting'?'done':x==='here'?'here':'')+'"></i>'; }).join('')+'</div></div>'; }).join('')+'</div>';
  h+='<div class="rowbtns" style="margin:0 0 12px"><button class="btn sm" data-act="invite">Invite</button><button class="btn sm" data-act="scan">Scan</button><button class="btn sm" data-act="map">Route map</button></div>';
  if(comp&&!me.user) h+=signinHTML('keep scoring');
  if(!practice){
    const team=comp&&c.team_score!=null?c.team_score:sc.team, mine=comp&&c.my_points!=null?c.my_points:sc.members[s.self].points;
    h+='<div class="tiles" style="--n:3;margin-bottom:6px;background:#fff"><div class="tile"><b>'+team+'</b><span>'+(comp?'team score':'herd score')+'</span></div><div class="tile"><b>'+mine+'</b><span>your points</span></div><div class="tile"><b>'+sc.solved+'<small> / 5</small></b><span>puzzles solved</span></div></div>'+
       '<p class="note" style="margin:0 0 12px">'+(comp?(c.cu_verified===false?'Guest run: scored for fun, not listed on standings. ':c.counts===false?'Repeat run: it won’t change the standings. ':'')+'Team score is the average of everyone who has checked in, so big herds and solo players compete evenly.'+(st.rosterLockedAt?' Roster locked.':'')
          :'Friends Mode: scored just for fun. Nothing is saved off your phones.')+'</p>';
  }
  if(H.finished(st,s.self)) h+=finishHTML();
  h+=st.edition.checkpoints.map(cpHTML).join('');
  h+='<div class="foot"><button class="link" data-act="leave" style="color:var(--danger)">Leave herd</button><button class="link" data-act="privacy">Privacy</button><button class="link" data-act="lobbyKeep">All routes</button></div>';
  return h;
}
async function loadStandings(){
  A.standings=null; render();
  const r=await rpc('hunt_standings',{p_edition:A.stEd}); A.standings=r.error?{error:true}:r.data; render();
}
function standingsHTML(){
  let h='<button class="link" data-act="'+(A.session&&A.session.state?'backToRun':'lobby')+'">‹ Back</button><h1 class="title" tabindex="-1">Weekly standings</h1>';
  if(!sb) return h+'<p class="empty">Standings need the online service, which isn’t set up in this copy of BuffPrints.</p>';
  h+='<div class="seg" role="tablist">'+A.editions.map(e=>'<button role="tab" aria-selected="'+(e.content.id===A.stEd)+'" class="'+(e.content.id===A.stEd?'act':'')+'" data-act="stEd" data-id="'+esc(e.content.id)+'">'+esc(e.content.title.replace(/^Demo Route — /,''))+'</button>').join('')+'</div>';
  const d=A.standings;
  if(!d) return h+'<p class="empty">Loading…</p>';
  if(d.error) return h+'<p class="empty">Couldn’t load standings. Check your connection.</p><button class="btn" data-act="stReload">Try again</button>';
  const wk=new Date(d.week+'T12:00:00'), end=new Date(wk.getTime()+6*864e5), fmt=x=>x.toLocaleDateString([], {month:'short',day:'numeric'});
  h+='<p class="small muted" style="margin:0 0 4px">'+fmt(wk)+' – '+fmt(end)+' · resets Monday, Boulder time</p>';
  h+='<div class="label">Herds</div>'+(d.teams.length?d.teams.map(t=>'<div class="lb'+(t.is_mine?' you':'')+'"><span class="r">'+t.rank+'</span><span class="av" aria-hidden="true">'+av(t.avatar)+'</span><span class="n"><b>'+esc(t.team_name)+(t.is_mine?' (yours)':'')+'</b><small>'+esc(t.affiliation||'No dorm or team')+' · '+pl(t.players,'player')+(t.finished?' · finished':'')+(t.verified?' · ✓ colorado.edu':'')+'</small></span><span class="v">'+t.score+'</span></div>').join(''):'<p class="empty">No herd has scored on this route yet this week. Yours could be first.</p>');
  h+='<div class="label">Dorms and teams</div>'+(d.affiliations.length?d.affiliations.map(a=>'<div class="lb'+(a.is_mine?' you':'')+'"><span class="r">'+a.rank+'</span><span class="n"><b>'+esc(a.affiliation)+'</b><small>'+pl(a.players,'player')+' · '+a.finished+' finished</small></span><span class="v">'+a.score+'</span></div>').join(''):'<p class="empty">No dorm or team scores yet this week.</p>');
  return h+'<p class="note">Scores are out of 600: 100 per checkpoint (20 less for each hint, never below 60) plus 100 for finishing all five. No speed bonus, and ties share a place. A herd’s score is the average of its players; a dorm’s is the average of its verified players. Only a player’s first run of a route counts. Standings show team and dorm names only — never who is on a team.</p>';
}
async function loadWallet(){ A.wallet=null; render(); if(!me.user){ A.wallet=[]; return render(); } const r=await rpc('hunt_my_wallet'); A.wallet=r.error?{error:true}:r.data; render(); }
function walletHTML(){
  let h='<button class="link" data-act="'+(A.session&&A.session.state?'backToRun':'lobby')+'">‹ Back</button><h1 class="title" tabindex="-1">Reward wallet</h1><div class="demo-note" style="margin:0 0 12px">'+DEMO_NOTE+'</div>';
  if(!me.user) return h+signinHTML('see your rewards');
  const w=A.wallet; if(!w) return h+'<p class="empty">Loading…</p>';
  if(w.error) return h+'<p class="empty">Couldn’t load your wallet. Check your connection.</p>';
  if(!w.length) return h+'<p class="empty">No rewards yet. Finish all five checkpoints of a route in Competition Mode with a verified colorado.edu address to earn a demo token.</p>';
  return h+w.map(t=>'<div class="card"><span class="pill gold">Demo reward</span> <span class="pill'+(t.status==='used'?'':' good')+'">'+(t.status==='used'?'Used':'Unused')+'</span><div class="token'+(t.status==='used'?' used':'')+'">'+esc(t.token)+'</div>'+
    '<div class="sub">'+esc(t.title||t.edition_id)+' · week of '+esc(t.week)+'</div><p class="small" style="color:var(--warn);font-weight:700">'+DEMO_NOTE+'</p>'+
    (t.status==='issued'?'<div class="rowbtns"><button class="btn sm" data-act="useToken" data-token="'+esc(t.token)+'">Try a demo redemption</button></div><p class="note">Shows how a single-use token works. It doesn’t get you anything.</p>':'')+'</div>').join('');
}
let routeMap=null;
async function showMap(){
  const cps=A.session.state.edition.checkpoints;
  modal('Route map','<div id="routeMap" role="img" aria-label="Map of the five checkpoints"></div><ol class="small" style="padding-left:20px;margin:10px 0 0">'+cps.map(c=>'<li><b>'+esc(c.name)+'</b> — '+esc(c.spot)+'</li>').join('')+'</ol><p class="note">Circles show roughly where a check-in counts. Any order works. Your location isn’t shown or shared.</p>',
    [['Close','pri',()=>{}]],()=>{ if(routeMap){ routeMap.remove(); routeMap=null; } });
  try{
    if(!window.L){ const l=document.createElement('link'); l.rel='stylesheet'; l.href='https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'; document.head.appendChild(l); await loadScript('https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'); }
    if(!$('routeMap')) return;
    routeMap=L.map('routeMap',{zoomControl:true,attributionControl:true}); routeMap.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',{maxZoom:19,attribution:'Imagery &copy; Esri, Maxar'}).addTo(routeMap);
    cps.forEach(c=>{ L.circle([c.lat,c.lng],{radius:c.radius_m,color:'#CFB87C',weight:2,fillOpacity:.18}).addTo(routeMap);
      L.marker([c.lat,c.lng],{icon:L.divIcon({className:'',html:'<div class="cpmk">'+c.no+'</div>',iconSize:[26,26],iconAnchor:[13,13]}),keyboard:false}).addTo(routeMap); });
    routeMap.fitBounds(cps.map(c=>[c.lat,c.lng]),{padding:[30,30]});
  }catch(e){ const m=$('routeMap'); if(m) m.outerHTML='<p class="msg">The map couldn’t load (you may be offline). The checkpoints are listed below.</p>'; }
}

/* ---------- render: redraw the current screen, keeping whatever the player was typing ---------- */
function render(){
  const root=$('hv'), keep={}, focus=document.activeElement&&root.contains(document.activeElement)?document.activeElement:null;
  root.querySelectorAll('input[id]').forEach(i=>{ if(i.type!=='radio') keep[i.id]=i.value; });
  const radios={}; root.querySelectorAll('input[type=radio]:checked').forEach(i=>{ radios[i.name]=i.value; });
  const fid=focus&&focus.id, fact=focus&&focus.dataset&&focus.dataset.act, fno=focus&&focus.dataset&&focus.dataset.no;
  const s=A.session, inHerd=s&&s.state&&s.state.members[s.self];
  document.body.classList.toggle('practice',A.view==='run'&&inHerd&&s.state.mode==='practice');
  let h;
  if(A.view==='loading') h='<p class="empty">Loading…</p>';
  else if(A.view==='run'&&inHerd) h=runHTML();
  else if(A.view==='mode') h=modeHTML();
  else if(A.view==='privacy') h=privacyViewHTML();
  else if(A.view==='setup') h=setupHTML();
  else if(A.view==='joining') h=joiningHTML();
  else if(A.view==='joinform'&&s&&s.state) h=joinFormHTML();
  else if(A.view==='standings') h=standingsHTML();
  else if(A.view==='wallet') h=walletHTML();
  else{ A.view='lobby'; h=(inHerd?'<button class="card gold" data-act="backToRun"><span class="pill gold">In progress</span><h3 style="margin-top:6px">'+av(s.state.herd.avatar)+' '+esc(s.state.herd.name)+'</h3><div class="sub">'+esc(s.state.edition.title)+' · '+H.herdScore(s.state).members[s.self].done+' of 5 checkpoints</div><p>Tap to keep going.</p></button>':'')+lobbyHTML(); }
  root.innerHTML=h;
  Object.keys(keep).forEach(id=>{ const i=$(id); if(i&&!i.readOnly) i.value=keep[id]; });
  Object.keys(radios).forEach(n=>{ const i=root.querySelector('input[name="'+n+'"][value="'+radios[n]+'"]'); if(i) i.checked=true; });
  if(fid&&$(fid)) $(fid).focus({preventScroll:true});
  else if(fact){ const b=root.querySelector('[data-act="'+fact+'"]'+(fno?'[data-no="'+fno+'"]':'')); if(b) b.focus({preventScroll:true}); }
}

/* ---------- one click handler for everything ---------- */
async function act(a,d){
  const no=d&&d.no?Number(d.no):0, s=A.session;
  if(a==='lobby'){ A.pendingJoin=null; A.form={}; go('lobby'); }
  else if(a==='lobbyKeep') go('lobby');
  else if(a==='backToRun'){ A.open=A.open||nextOpen(); go('run'); }
  else if(a==='pick'){ A.pick=d.id; bumpView(d.id); go('mode'); }
  else if(a==='backToMode'){ A.form={}; go('mode'); }
  else if(a==='mode'){
    A.mode=d.mode; A.pendingJoin=null; A.form={};
    if(s&&s.state&&s.state.members[s.self]&&!H.finished(s.state,s.self)) return modal('Start a new run?','<p>You’re still in <b>'+esc(s.state.herd.name)+'</b>. Starting a new run leaves that herd on this phone.'+(s.state.mode==='competition'?' Checkpoints you completed stay on your record.':'')+'</p>',
      [['Start a new run','pri',()=>go('privacy')],['Go back to my herd','',()=>go('run')]]);
    go('privacy');
  }
  else if(a==='privacy'||a==='privacyFull') fullPrivacy();
  else if(a==='privacyOk'){ if(A.pendingJoin){ const raw=A.pendingJoin; A.pendingJoin=null; await beginJoin(raw); } else go('setup'); }
  else if(a==='start'){ A.form.myAv=radio('myAv'); A.form.teamAv=radio('teamAv'); A.form.name=($('fName')||{}).value; await startHerd(); }
  else if(a==='join'){ A.form.myAv=radio('myAv'); A.form.nick=$('fNick').value; await finishJoin(); }
  else if(a==='retryJoin'){ A.joinSlow=false; const raw=A.raw; if(raw) await beginJoin(raw); else go('lobby'); }
  else if(a==='cancelJoin'){ clearTimeout(A.joinWait); A.joinSlow=false; if(s&&!(s.state&&s.state.members[s.self])) await dropCurrent(); go('lobby'); }
  else if(a==='scanJoin'||a==='scan') openScanner({});
  else if(a==='scanTyped'){ const v=($('scanText').value||'').trim(); if(v) await handleScan(v); }
  else if(a==='siSend') await siSend();
  else if(a==='siVerify') await siVerify();
  else if(a==='siBack'){ A.signin={step:'email',email:A.signin.email,msg:''}; render(); }
  else if(a==='standings'){ A.stEd=A.stEd||(s&&s.state?s.state.editionId:(A.editions[0]||{content:{}}).content.id); go('standings'); if(sb) loadStandings(); }
  else if(a==='stEd'){ A.stEd=d.id; loadStandings(); }
  else if(a==='stReload') loadStandings();
  else if(a==='wallet'){ go('wallet'); loadWallet(); }
  else if(a==='useToken') modal('Try a demo redemption?','<p>This marks the token as used, to show that each one works exactly once.</p><div class="demo-note">'+DEMO_NOTE+'</div>',
      [['Mark as used','pri',async()=>{ const r=await rpc('hunt_use_token',{p_token:d.token}); toast(!r.error&&r.data&&r.data.status==='ok'?'Token used (demo)':'That token was already used'); if(A.token&&A.token.token===d.token) A.token.status='used'; loadWallet(); }],['Cancel','',()=>{}]]);
  else if(a==='playAgain') go('lobby');
  else if(!s||!s.state) return;
  else if(a==='open'){ A.open=A.open===no?0:no; render(); }
  else if(a==='checkin') await checkInHere(no);
  else if(a==='sim'){ if(s.state.mode==='practice') await arrived(no,'sim'); }
  else if(a==='vouch') openScanner({cp:no});
  else if(a==='answer') await submitAnswer(no);
  else if(a==='hint') await revealHint(no);
  else if(a==='code') showCode(no);
  else if(a==='allPieces'){ await s.setFlag('all:'+no); render(); }
  else if(a==='pieceQr') await showPiece(no,Number(d.i));
  else if(a==='pieceSend'){ await s.sharePiece(no,Number(d.i)); toast('Sent piece '+(Number(d.i)+1)+' to your herd'); }
  else if(a==='invite') showInvite();
  else if(a==='map') showMap();
  else if(a==='leave') confirmLeave();
}
document.addEventListener('click',e=>{ const b=e.target.closest('[data-act]'); if(!b||b.disabled) return; act(b.dataset.act,b.dataset); });
document.addEventListener('visibilitychange',()=>{ if(!document.hidden&&A.session&&A.session.state) A.session.hello(); });
window.addEventListener('online',()=>{ if(A.session&&A.session.state){ A.session.hello(); afterChange(); } });
setInterval(()=>{ const s=A.session; if(document.hidden||!s||!s.state||!s.state.members[s.self]) return; if(A.link==='live') s.ping(); afterChange(); },30000);   // presence + retry any unsaved credit

/* ---------- boot ---------- */
(async function boot(){
  if(!window.crypto||!crypto.subtle){ $('hv').innerHTML='<h1 class="title">Find the Herd</h1><p class="empty">This browser can’t run Find the Herd here. Open BuffPrints from its https:// address in a current version of Safari or Chrome.</p>'; return; }
  if(sb){
    try{ const {data}=await sb.auth.getSession(); me.user=data&&data.session?data.session.user:null; }catch(e){}
    sb.auth.onAuthStateChange((ev,session)=>{ const u=session?session.user:null, changed=(u&&u.id)!==(me.user&&me.user.id); me.user=u;
      if(changed) setTimeout(async()=>{ await loadWho(); await resumeComp(); if(A.view==='wallet') loadWallet(); render(); },0); });
  }
  await Promise.all([loadWho(),loadEditions()]);
  if(pendingInvite){ const raw=pendingInvite; pendingInvite=null; const cur=activeGet(); let same=false;
    try{ same=cur&&(await H.deriveKeys(raw)).channelId===cur; }catch(e){}
    if(same){ await beginJoin(raw); return; }
    if(cur){ const k=await keyGet(cur); if(k){ const s=await openHerd(k); if(s.state&&s.state.members[s.self]&&!(s.state.members[s.self].leftAt>0)){ A.view='run'; render(); return askJoin(raw); } closeSession(); } }
    return beginJoinFlow(raw);
  }
  const cur=activeGet();
  if(cur){
    const k=await keyGet(cur);
    if(k){ const s=await openHerd(k); if(s.state&&s.state.members[s.self]&&!(s.state.members[s.self].leftAt>0)){ await resumeComp(); A.open=nextOpen(); const v=new URLSearchParams(location.search).get('view'); if(v==='standings') return act('standings'); return go('run'); } closeSession(); }
    activeSet(null);
  }
  const v=new URLSearchParams(location.search).get('view');
  if(v==='standings') return act('standings'); if(v==='wallet') return act('wallet');
  go('lobby');
})();
if('serviceWorker' in navigator&&location.protocol==='https:') navigator.serviceWorker.register('sw.js').catch(()=>{});
})();
