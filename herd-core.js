/* BuffPrints — Find the Herd: logic shared by herd.html, herd-admin.html and the tests.
   No DOM. Crypto is the Web Crypto API (every current iPhone/Android browser, and Node 20+).
   Network (the relay) and storage are passed in, so the whole thing runs under `node --test`.

   Privacy shape, in one place:
     * A herd is a random 256-bit key. It lives in the invite link's #fragment (never sent to
       a server) and from it we derive: an AES-GCM key (encrypts everything teammates share),
       an HMAC key (rolling "we're together" codes) and the relay channel name (a one-way hash).
     * The relay (Supabase Realtime Broadcast, client-sent only) sees ciphertext and nothing else.
     * GPS is compared with the checkpoint ON THE PHONE. Only "inside: yes/no" ever leaves it. */
(function(root){
'use strict';

const C = (typeof globalThis!=='undefined'&&globalThis.crypto) || (root&&root.crypto);
const subtle = C && C.subtle;
const enc = new TextEncoder(), dec = new TextDecoder();

/* ---------- tuning ---------- */
const CHECKPOINTS = 5;
const BASE_POINTS = 100, HINT_COST = 20, MIN_POINTS = 60, FINISH_BONUS = 100;
const MAX_HINTS = 2;
const ACC_MAX_M = 65;        // a fix less accurate than this can't prove anything
const ACC_SLACK_M = 25;      // how much of the accuracy circle may count toward "inside"
const ROLL_MS = 7000;        // rolling codes change this often
const ROLL_BACK = 2, ROLL_AHEAD = 1;   // accepted windows around "now" (clock drift + time to scan)
const MAX_MEMBERS = 8;
const AVATARS = ['bison','fox','owl','elk','bear','hawk','trout','marmot','pika','columbine','flatiron','snowflake'];
const AVATAR_EMOJI = {bison:'🦬',fox:'🦊',owl:'🦉',elk:'🦌',bear:'🐻',hawk:'🦅',trout:'🐟',marmot:'🦫',pika:'🐹',columbine:'🌸',flatiron:'⛰️',snowflake:'❄️'};
const METRIC_KEYS = ['views','starts','checkpoint_1_completions','checkpoint_2_completions','checkpoint_3_completions',
                     'checkpoint_4_completions','checkpoint_5_completions','hints_used','completions'];

/* ---------- bytes ---------- */
function b64u(bytes){
  let s=''; const b=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes);
  for(let i=0;i<b.length;i++) s+=String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function unb64u(str){
  const s=atob(String(str).replace(/-/g,'+').replace(/_/g,'/')); const out=new Uint8Array(s.length);
  for(let i=0;i<s.length;i++) out[i]=s.charCodeAt(i);
  return out;
}
function hex(bytes){ return Array.from(new Uint8Array(bytes)).map(b=>b.toString(16).padStart(2,'0')).join(''); }
function randomBytes(n){ const a=new Uint8Array(n); C.getRandomValues(a); return a; }
function randomId(n){ return b64u(randomBytes(n||9)); }

/* ---------- answers ----------
   Same rule in SQL (hunt_norm_answer): keep ASCII letters and digits, then lowercase.
   A stored answer is sha256(salt + ':' + normalized) in hex — the plain answer is never stored. */
function normalizeAnswer(s){ return String(s==null?'':s).replace(/[^A-Za-z0-9]/g,'').toLowerCase(); }
async function hashAnswer(salt, answer){
  return hex(await subtle.digest('SHA-256', enc.encode(String(salt)+':'+normalizeAnswer(answer))));
}
async function checkAnswerLocal(key, answer){
  if(!key||!key.salt||!Array.isArray(key.hashes)||!normalizeAnswer(answer)) return false;
  return key.hashes.indexOf(await hashAnswer(key.salt, answer))>=0;
}

/* ---------- geofence (runs on the phone; coordinates never leave it) ---------- */
function distanceM(lat1,lng1,lat2,lng2){
  const R=6371008.8, r=Math.PI/180, dLat=(lat2-lat1)*r, dLng=(lng2-lng1)*r;
  const a=Math.sin(dLat/2)**2+Math.cos(lat1*r)*Math.cos(lat2*r)*Math.sin(dLng/2)**2;
  return 2*R*Math.asin(Math.min(1,Math.sqrt(a)));
}
function compass(lat1,lng1,lat2,lng2){
  const r=Math.PI/180, y=Math.sin((lng2-lng1)*r)*Math.cos(lat2*r),
        x=Math.cos(lat1*r)*Math.sin(lat2*r)-Math.sin(lat1*r)*Math.cos(lat2*r)*Math.cos((lng2-lng1)*r);
  const deg=(Math.atan2(y,x)/r+360)%360;
  return ['north','northeast','east','southeast','south','southwest','west','northwest'][Math.round(deg/45)%8];
}
/* fix: {lat,lng,accuracy}. checkpoint: {lat,lng,radius_m}.
   inside  — within the radius, allowing for part of the reported accuracy circle
   near    — the accuracy circle reaches the checkpoint, but the fix isn't good enough yet
   weak    — the phone doesn't know where it is precisely enough to say
   outside — clearly somewhere else (distance + direction help the player walk there) */
function geofence(fix, cp){
  if(!fix||!isFinite(fix.lat)||!isFinite(fix.lng)||!cp) return {state:'weak', inside:false, distance:null, accuracy:null};
  const acc=isFinite(fix.accuracy)&&fix.accuracy>=0?fix.accuracy:9999;
  const d=distanceM(fix.lat,fix.lng,cp.lat,cp.lng), r=Number(cp.radius_m)||35;
  const out={distance:Math.round(d), accuracy:Math.round(acc), toward:compass(fix.lat,fix.lng,cp.lat,cp.lng)};
  if(acc>ACC_MAX_M){ out.state = d<=r+acc ? 'weak' : 'outside'; out.inside=false; return out; }
  if(d<=r+Math.min(acc,ACC_SLACK_M)){ out.state='inside'; out.inside=true; return out; }
  out.state = d<=r+acc ? 'near' : 'outside'; out.inside=false; return out;
}
/* Best of several fixes: any "inside" wins; otherwise the most accurate one explains what's wrong. */
function bestFence(fixes, cp){
  let best=null;
  for(const f of fixes||[]){
    const g=geofence(f,cp); if(g.inside) return g;
    if(!best||(g.accuracy!=null&&(best.accuracy==null||g.accuracy<best.accuracy))) best=g;
  }
  return best||geofence(null,cp);
}

/* ---------- scoring (the database runs the same arithmetic for Competition Mode) ---------- */
function puzzlePoints(hints){ return Math.max(MIN_POINTS, BASE_POINTS-HINT_COST*Math.max(0,Number(hints)||0)); }
/* done: checkpoint numbers this player completed (their own proximity check-in + solved puzzle).
   puzzles: {cp:{hints,solvedAt}} for the herd. */
function memberPoints(done, puzzles){
  let pts=0, n=0;
  for(let cp=1;cp<=CHECKPOINTS;cp++){
    const p=puzzles&&puzzles[cp];
    if(done&&done[cp]&&p&&p.solvedAt){ pts+=puzzlePoints(p.hints); n++; }
  }
  if(n===CHECKPOINTS) pts+=FINISH_BONUS;
  return pts;
}
/* Team score = average of the players who checked in somewhere, so a herd of five can't
   outscore a pair (or one person) just by being bigger. Rounded to a whole point. */
function teamScore(memberTotals){
  const xs=(memberTotals||[]).filter(x=>x!=null&&isFinite(x));
  if(!xs.length) return 0;
  return Math.round(xs.reduce((a,b)=>a+b,0)/xs.length);
}
function doneMap(member, puzzles){
  const out={}; if(!member) return out;
  for(let cp=1;cp<=CHECKPOINTS;cp++) if(member.prox&&member.prox[cp]&&puzzles&&puzzles[cp]&&puzzles[cp].solvedAt) out[cp]=true;
  return out;
}
function herdScore(state){
  const totals=[], per={};
  Object.keys(state.members||{}).forEach(id=>{
    const m=state.members[id], d=doneMap(m,state.puzzles);
    const hasAny=m.prox&&Object.keys(m.prox).length>0;
    per[id]={points:memberPoints(d,state.puzzles), done:Object.keys(d).length};
    if(hasAny) totals.push(per[id].points);
  });
  return {team:teamScore(totals), members:per, solved:Object.values(state.puzzles||{}).filter(p=>p&&p.solvedAt).length};
}

/* ---------- keys ---------- */
const KDF_SALT = enc.encode('BuffPrints Find the Herd v1');
function newHerdKey(){ return b64u(randomBytes(32)); }
function validKey(k){ return typeof k==='string' && /^[A-Za-z0-9_-]{43}$/.test(k); }
/* From the 32 random bytes in the invite: an encryption key, a signing key and the relay channel
   name. The two keys are created non-extractable — script can use them but never read them back —
   so they can be parked in IndexedDB between visits without the raw key sitting in storage. */
async function deriveKeys(rawKey){
  if(!validKey(rawKey)) throw new Error('That invite isn’t valid');
  const base=await subtle.importKey('raw', unb64u(rawKey), 'HKDF', false, ['deriveKey','deriveBits']);
  const p=info=>({name:'HKDF', hash:'SHA-256', salt:KDF_SALT, info:enc.encode(info)});
  const aes=await subtle.deriveKey(p('aes'), base, {name:'AES-GCM', length:256}, false, ['encrypt','decrypt']);
  const mac=await subtle.deriveKey(p('mac'), base, {name:'HMAC', hash:'SHA-256', length:256}, false, ['sign']);
  const channelId=hex(await subtle.deriveBits(p('channel'), base, 128));
  return {aes, mac, channelId};
}
function inviteUrl(base, rawKey){ return String(base).split('#')[0]+'#key='+rawKey; }
/* Accepts a full invite link, a bare "#key=…" or the key itself (typed or scanned). */
function parseInvite(text){
  const s=String(text||'').trim();
  const m=s.match(/[#&]key=([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/);
  if(m) return m[1];
  return validKey(s)?s:null;
}

/* ---------- sealed messages: "v1.<iv>.<ciphertext>" ---------- */
async function seal(keys, obj){
  const iv=randomBytes(12);
  const ct=await subtle.encrypt({name:'AES-GCM', iv, additionalData:enc.encode(keys.channelId)}, keys.aes, enc.encode(JSON.stringify(obj)));
  return 'v1.'+b64u(iv)+'.'+b64u(ct);
}
async function open(keys, sealed){
  const parts=String(sealed||'').split('.');
  if(parts.length!==3||parts[0]!=='v1') throw new Error('Not a herd message');
  const pt=await subtle.decrypt({name:'AES-GCM', iv:unb64u(parts[1]), additionalData:enc.encode(keys.channelId)}, keys.aes, unb64u(parts[2]));
  return JSON.parse(dec.decode(pt));
}

/* ---------- rolling codes (phone to phone, no server) ----------
   A code proves "the phone showing this is in our herd, right now": HMAC(herd key, kind|who|what|time-window).
   It changes every ROLL_MS, so a screenshot texted to a friend is stale before it's useful.
   QR text:  BPH1:T:<peer>:<checkpoint>:<window>:<mac>     6-digit form (camera-free fallback): digits of the same MAC */
function rollWindow(nowMs){ return Math.floor(nowMs/ROLL_MS); }
async function macBytes(keys, msg){ return new Uint8Array(await subtle.sign('HMAC', keys.mac, enc.encode(msg))); }
function digits6(mac){ return String((((mac[0]&0x7f)<<24)|(mac[1]<<16)|(mac[2]<<8)|mac[3])%1000000).padStart(6,'0'); }
async function presenceCode(keys, peerId, cp, nowMs){
  const w=rollWindow(nowMs), mac=await macBytes(keys,'T|'+peerId+'|'+cp+'|'+w);
  return {text:'BPH1:T:'+peerId+':'+cp+':'+w+':'+b64u(mac.slice(0,10)), digits:digits6(mac), window:w,
          msLeft:ROLL_MS-(nowMs%ROLL_MS)};
}
function windowsAround(nowMs){ const w=rollWindow(nowMs), out=[]; for(let i=-ROLL_BACK;i<=ROLL_AHEAD;i++) out.push(w+i); return out; }
/* input: scanned QR text, or six typed digits. peers: ids that may be showing a code (not me).
   Returns {ok, peerId, cp} or {ok:false, reason: 'format'|'stale'|'wrong'}. */
async function verifyPresence(keys, input, nowMs, opts){
  const o=opts||{}, s=String(input||'').trim(), wins=windowsAround(nowMs);
  const m=s.match(/^BPH1:T:([A-Za-z0-9_-]{6,24}):([1-9]):(\d{1,12}):([A-Za-z0-9_-]{14})$/);
  if(m){
    const peerId=m[1], cp=Number(m[2]), w=Number(m[3]);
    if(o.self&&peerId===o.self) return {ok:false, reason:'self'};
    if(o.cp&&cp!==o.cp) return {ok:false, reason:'other_checkpoint', cp};
    if(wins.indexOf(w)<0) return {ok:false, reason:'stale'};
    const mac=await macBytes(keys,'T|'+peerId+'|'+cp+'|'+w);
    return b64u(mac.slice(0,10))===m[4] ? {ok:true, peerId, cp} : {ok:false, reason:'wrong'};
  }
  const d=s.replace(/\s/g,'');
  if(/^\d{6}$/.test(d)){
    if(!o.cp) return {ok:false, reason:'format'};
    for(const peerId of o.peers||[]){
      if(o.self&&peerId===o.self) continue;
      for(const w of wins){
        const mac=await macBytes(keys,'T|'+peerId+'|'+o.cp+'|'+w);
        if(digits6(mac)===d) return {ok:true, peerId, cp:o.cp};
      }
    }
    return {ok:false, reason:'wrong'};
  }
  return {ok:false, reason:'format'};
}
/* Split clues handed over by QR: BPH1:P:<checkpoint>:<piece>:<mac> (not time-limited — it's a clue, not proof of presence). */
async function pieceCode(keys, cp, idx){
  const mac=await macBytes(keys,'P|'+cp+'|'+idx);
  return 'BPH1:P:'+cp+':'+idx+':'+b64u(mac.slice(0,8));
}
async function verifyPiece(keys, input){
  const m=String(input||'').trim().match(/^BPH1:P:([1-9]):(\d{1,2}):([A-Za-z0-9_-]{11})$/);
  if(!m) return {ok:false, reason:'format'};
  const mac=await macBytes(keys,'P|'+m[1]+'|'+m[2]);
  return b64u(mac.slice(0,8))===m[3] ? {ok:true, cp:Number(m[1]), idx:Number(m[2])} : {ok:false, reason:'wrong'};
}
function scanKind(text){
  const s=String(text||'').trim();
  if(/^BPH1:T:/.test(s)) return 'presence';
  if(/^BPH1:P:/.test(s)) return 'piece';
  if(parseInvite(s)) return 'invite';
  return 'unknown';
}
/* Which clue pieces start on whose screen. Everyone computes the same answer from the member list. */
function assignPieces(pieceCount, memberIds, cp){
  const ids=(memberIds||[]).slice().sort(), out={}; ids.forEach(id=>{ out[id]=[]; });
  if(!ids.length) return out;
  for(let i=0;i<pieceCount;i++) out[ids[(i+(Number(cp)||0))%ids.length]].push(i);
  return out;
}

/* ---------- herd state ----------
   Everything here only ever grows (a check-in is never un-done, a hint never un-used), so two
   phones can merge in any order, any number of times, and end up identical. */
function cleanText(s,max){ return String(s==null?'':s).replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim().slice(0,max); }
function newState(o){
  const now=o.now||Date.now(), st={
    v:1, mode:o.mode, editionId:o.edition.id, editionVersion:o.edition.version, source:o.source||'bundle',
    edition:o.edition, herd:{name:cleanText(o.name,24)||'Our herd', avatar:AVATARS.indexOf(o.avatar)>=0?o.avatar:'bison', teamId:o.teamId||null, at:now},
    createdAt:now, rosterLockedAt:null, members:{}, puzzles:{}
  };
  return st;
}
function blankMember(){ return {nick:'Buff', avatar:'bison', at:0, seen:0, leftAt:0, joinedAt:0, comp:null, prox:{}, credit:{}, together:{}}; }
function mergeMember(a,b){
  if(!a) return JSON.parse(JSON.stringify(b)); if(!b) return a;
  const newer=(b.at||0)>(a.at||0)?b:a, out=blankMember();
  out.nick=newer.nick; out.avatar=newer.avatar; out.comp=newer.comp||null; out.at=Math.max(a.at||0,b.at||0);
  out.seen=Math.max(a.seen||0,b.seen||0); out.leftAt=Math.max(a.leftAt||0,b.leftAt||0);
  out.joinedAt=Math.min(a.joinedAt||Infinity,b.joinedAt||Infinity); if(!isFinite(out.joinedAt)) out.joinedAt=0;
  for(const src of [a,b]){
    Object.keys(src.prox||{}).forEach(cp=>{ const x=src.prox[cp], y=out.prox[cp]; if(!y||(x.at||0)<(y.at||0)) out.prox[cp]={at:x.at, via:x.via, by:x.by||null}; });
    Object.keys(src.credit||{}).forEach(cp=>{ if(src.credit[cp]) out.credit[cp]=true; });
    Object.keys(src.together||{}).forEach(cp=>{ out.together[cp]=Array.from(new Set((out.together[cp]||[]).concat(src.together[cp]||[]))).sort(); });
  }
  return out;
}
function mergePuzzle(a,b){
  if(!a) return JSON.parse(JSON.stringify(b)); if(!b) return a;
  const out={unlockedAt:null, unlockedBy:null, hints:Math.min(MAX_HINTS,Math.max(a.hints||0,b.hints||0)), solvedAt:null, solvedBy:null, answer:null, shared:{}};
  const u=[a,b].filter(x=>x.unlockedAt).sort((x,y)=>x.unlockedAt-y.unlockedAt||String(x.unlockedBy).localeCompare(String(y.unlockedBy)))[0];
  if(u){ out.unlockedAt=u.unlockedAt; out.unlockedBy=u.unlockedBy; }
  const s=[a,b].filter(x=>x.solvedAt).sort((x,y)=>x.solvedAt-y.solvedAt||String(x.solvedBy).localeCompare(String(y.solvedBy)))[0];
  if(s){ out.solvedAt=s.solvedAt; out.solvedBy=s.solvedBy; out.answer=s.answer; }
  for(const src of [a,b]) Object.keys(src.shared||{}).forEach(i=>{ if(src.shared[i]) out.shared[i]=true; });
  return out;
}
function merge(a,b){
  if(!a) return b; if(!b) return a;
  const out=JSON.parse(JSON.stringify(a));
  if(!out.edition&&b.edition) out.edition=b.edition;
  if(b.herd&&(!out.herd||(b.herd.at||0)>(out.herd.at||0))) out.herd=JSON.parse(JSON.stringify(b.herd));
  if(b.herd&&b.herd.teamId&&out.herd&&!out.herd.teamId) out.herd.teamId=b.herd.teamId;
  out.createdAt=Math.min(a.createdAt||Infinity,b.createdAt||Infinity);
  const locks=[a.rosterLockedAt,b.rosterLockedAt].filter(Boolean); out.rosterLockedAt=locks.length?Math.min.apply(null,locks):null;
  const ids=new Set(Object.keys(a.members||{}).concat(Object.keys(b.members||{})));
  out.members={}; ids.forEach(id=>{ out.members[id]=mergeMember(a.members&&a.members[id], b.members&&b.members[id]); });
  const cps=new Set(Object.keys(a.puzzles||{}).concat(Object.keys(b.puzzles||{})));
  out.puzzles={}; cps.forEach(cp=>{ out.puzzles[cp]=mergePuzzle(a.puzzles&&a.puzzles[cp], b.puzzles&&b.puzzles[cp]); });
  return out;
}
function sameState(a,b){ return JSON.stringify(canon(a))===JSON.stringify(canon(b)); }
function canon(x){
  if(Array.isArray(x)) return x.map(canon);
  if(x&&typeof x==='object'){ const o={}; Object.keys(x).sort().forEach(k=>{ o[k]=canon(x[k]); }); return o; }
  return x;
}
function activeMembers(state){ return Object.keys(state.members||{}).filter(id=>!(state.members[id].leftAt>0)).sort(); }
function checkpointStatus(state, me, cp){
  const p=state.puzzles&&state.puzzles[cp], m=state.members&&state.members[me];
  const here=!!(m&&m.prox&&m.prox[cp]), solved=!!(p&&p.solvedAt);
  const needCredit=state.mode==='competition';
  if(here&&solved&&(!needCredit||(m.credit&&m.credit[cp]))) return 'done';
  if(here&&solved) return 'crediting';       // competition: waiting for the server to record it
  if(here) return 'here';                    // I'm checked in; puzzle open
  if(solved) return 'solved';                // herd solved it; I still need my own check-in
  if(p&&p.unlockedAt) return 'unlocked';     // a teammate is there; I can read the puzzle
  return 'todo';
}
function finished(state, me){
  for(let cp=1;cp<=CHECKPOINTS;cp++) if(checkpointStatus(state,me,cp)!=='done') return false;
  return true;
}

/* ---------- the session: one phone's view of a herd ----------
   deps: keys (deriveKeys), transport {send(text), onMessage(fn)}, store {get(k), set(k,v), remove(k)} (strings),
         now() → ms, onChange(state) → redraw.
   Wire protocol (every packet sealed with the herd key):
     hello {from}          "I just (re)connected — who's here?"
     state {from, s, full} s = herd state (edition included when full)
   Storage: bp-herd:<channel> = sealed {self, state, flags}. Nothing readable without the key. */
function createSession(deps){
  const keys=deps.keys, now=deps.now||(()=>Date.now());
  const storeKey='bp-herd:'+keys.channelId;
  let state=deps.state||null, self=deps.self||null, flags=deps.flags||{}, closed=false, lastPersist=Promise.resolve();
  const stats={sent:0, received:0, rejected:0};

  function me(){ return state&&state.members[self]; }
  function changed(){ if(deps.onChange) try{ deps.onChange(state); }catch(e){} }
  function persist(){
    if(!state||!deps.store) return lastPersist;
    lastPersist=lastPersist.then(()=>seal(keys,{self, state, flags})).then(s=>deps.store.set(storeKey,s)).catch(()=>{});
    return lastPersist;
  }
  async function send(obj){
    if(closed||!deps.transport) return;
    try{ const text=await seal(keys,Object.assign({from:self},obj)); stats.sent++; await deps.transport.send(text); }catch(e){}
  }
  function slim(){ const s=Object.assign({},state); delete s.edition; return s; }
  function broadcast(full){ return send({t:'state', s:full?state:slim(), full:!!full}); }
  async function commit(full){ changed(); await persist(); await broadcast(full); }

  async function receive(text){
    let msg; try{ msg=await open(keys,text); }catch(e){ stats.rejected++; return; }   // not ours, or tampered with
    if(!msg||msg.from===self) return;
    stats.received++;
    if(msg.t==='hello'){
      if(state){ if(state.members[msg.from]) state.members[msg.from].seen=now(); await broadcast(true); }
      return;
    }
    if(msg.t==='state'&&msg.s&&msg.s.v===1){
      const before=state;
      if(!state){ if(!msg.s.edition) { await send({t:'hello'}); return; } state=msg.s; }
      else state=merge(state,msg.s);
      if(state.members[msg.from]) state.members[msg.from].seen=Math.max(state.members[msg.from].seen||0, now());
      const grew=!before||!sameState(before,state);
      // If I know something the sender didn't, say so once — that's how a reloaded phone catches everyone up.
      const theirs=merge(msg.s, null), mine=merge(theirs, state);
      if(grew){ changed(); await persist(); }
      if(before&&!sameState(strip(theirs),strip(mine))) await broadcast(false);
      if(deps.onPeer) try{ deps.onPeer(msg.from); }catch(e){}
    }
  }
  function strip(s){ const o=JSON.parse(JSON.stringify(s)); delete o.edition; Object.values(o.members||{}).forEach(m=>{ delete m.seen; }); return o; }
  if(deps.transport) deps.transport.onMessage(t=>receive(t));

  function puzzle(cp){ return state.puzzles[cp]||(state.puzzles[cp]={unlockedAt:null, unlockedBy:null, hints:0, solvedAt:null, solvedBy:null, answer:null, shared:{}}); }
  const api={
    get state(){ return state; }, get self(){ return self; }, get flags(){ return flags; }, stats, keys,
    channelId:keys.channelId,
    /* Start a new herd on this phone. */
    async create(o){
      self=randomId(9);
      state=newState(Object.assign({now:now()},o));
      state.members[self]=Object.assign(blankMember(),{nick:cleanText(o.nick,24)||'Buff', avatar:AVATARS.indexOf(o.myAvatar)>=0?o.myAvatar:'bison', at:now(), seen:now(), joinedAt:now()});
      await commit(true); return state;
    },
    /* Join from an invite: ask whoever is there for the herd, then add myself. */
    async hello(){ if(!self) self=randomId(9); await send({t:'hello'}); },
    async joinAs(o){
      if(!state) throw new Error('Waiting for a teammate’s phone');
      if(!state.members[self]){
        if(activeMembers(state).length>=MAX_MEMBERS) throw new Error('This herd is full');
        state.members[self]=Object.assign(blankMember(),{joinedAt:now()});
      }
      Object.assign(state.members[self],{nick:cleanText(o.nick,24)||'Buff', avatar:AVATARS.indexOf(o.avatar)>=0?o.avatar:'bison', at:now(), seen:now(), leftAt:0});
      await commit(false);
    },
    async setComp(comp){ me().comp=comp; me().at=now(); await commit(false); },
    async setTeam(teamId){ state.herd.teamId=teamId; state.herd.at=now(); await commit(false); },
    /* My own proximity check-in. via: gps | vouch (teammate's rolling code) | sim (Demo Practice only). */
    async arrive(cp, via, by){
      if(via==='sim'&&state.mode!=='practice') throw new Error('Simulated check-ins only exist in Demo Practice');
      if(!me().prox[cp]) me().prox[cp]={at:now(), via, by:by||null};
      const p=puzzle(cp); if(!p.unlockedAt){ p.unlockedAt=now(); p.unlockedBy=self; }
      me().at=now(); await commit(false);
    },
    async hint(cp){ const p=puzzle(cp); if(p.solvedAt||p.hints>=MAX_HINTS) return p.hints; p.hints++; await commit(false); return p.hints; },
    /* Sync what the server says (Competition Mode is authoritative there). */
    async setHints(cp,n){ const p=puzzle(cp); if(n>p.hints){ p.hints=Math.min(MAX_HINTS,n); await commit(false); } },
    async solve(cp, answer){
      const p=puzzle(cp); if(!p.solvedAt){ p.solvedAt=now(); p.solvedBy=self; p.answer=String(answer).slice(0,80); }
      if(!state.rosterLockedAt) state.rosterLockedAt=now();
      await commit(false);
    },
    async credit(cp){ if(!me().credit[cp]){ me().credit[cp]=true; await commit(false); } },
    async sharePiece(cp, idx){ const p=puzzle(cp); if(!p.shared[idx]){ p.shared[idx]=true; await commit(false); } },
    async together(cp, peerId){
      const list=me().together[cp]||(me().together[cp]=[]);
      if(list.indexOf(peerId)<0){ list.push(peerId); list.sort(); await commit(false); }
    },
    async leave(){ if(me()){ me().leftAt=now(); await commit(false); } },
    async ping(){ if(me()){ me().seen=now(); await broadcast(false); } },
    async setFlag(k,v){ flags[k]=v===undefined?true:v; await persist(); },
    /* Adopt a state built elsewhere (finishing solo after leaving a herd, or recovering a run from the server). */
    async adopt(st, id){ state=st; self=id; await commit(true); },
    flush(){ return lastPersist; },
    close(){ closed=true; },
    async forget(){ closed=true; await lastPersist; if(deps.store) await deps.store.remove(storeKey); }
  };
  return api;
}
/* Reload: read this phone's sealed copy back. Returns {self,state,flags} or null. */
async function restore(keys, store){
  try{ const s=await store.get('bp-herd:'+keys.channelId); if(!s) return null; const o=await open(keys,s); return o&&o.state&&o.self?o:null; }
  catch(e){ return null; }
}

/* An in-memory relay with the same shape as the real one. Used by the tests; it also records
   every frame it carried, which is how the tests prove the relay only ever sees ciphertext. */
function memoryRelay(){
  const rooms={}, log=[];
  return {log, join(channel){
    const peers=rooms[channel]||(rooms[channel]=[]), me={fn:null, on:true};
    peers.push(me);
    return {send(text){ log.push({channel,text}); const others=peers.filter(p=>p!==me&&p.on&&p.fn); return Promise.all(others.map(p=>Promise.resolve().then(()=>p.fn(text)))).then(()=>{}); },
            onMessage(fn){ me.fn=fn; }, drop(){ me.on=false; }, rejoin(){ me.on=true; }};
  }};
}
function memoryStore(){ const m=new Map(); return {get:async k=>m.has(k)?m.get(k):null, set:async(k,v)=>{ m.set(k,String(v)); }, remove:async k=>{ m.delete(k); }, _map:m}; }

const api={CHECKPOINTS, BASE_POINTS, HINT_COST, MIN_POINTS, FINISH_BONUS, MAX_HINTS, ACC_MAX_M, ACC_SLACK_M, ROLL_MS, MAX_MEMBERS,
  AVATARS, AVATAR_EMOJI, METRIC_KEYS,
  b64u, unb64u, hex, randomId, normalizeAnswer, hashAnswer, checkAnswerLocal,
  distanceM, compass, geofence, bestFence, puzzlePoints, memberPoints, teamScore, doneMap, herdScore,
  newHerdKey, validKey, deriveKeys, inviteUrl, parseInvite, seal, open,
  rollWindow, presenceCode, verifyPresence, pieceCode, verifyPiece, scanKind, assignPieces,
  cleanText, newState, blankMember, merge, sameState, activeMembers, checkpointStatus, finished,
  createSession, restore, memoryRelay, memoryStore};

if(typeof module!=='undefined'&&module.exports) module.exports=api;
else root.HerdCore=api;
})(typeof window!=='undefined'?window:globalThis);
