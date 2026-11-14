/* BuffPrints — GPS track cleanup and path matching. Pure functions shared by the app and its tests.
   No DOM, no network, no storage.

   Three ideas, all from the Nov 13 campus field test:
   1. Smooth the GPS. Phones jump around by several meters from fix to fix; a small Kalman filter
      weighs each fix by its reported accuracy and how far a walker could have moved since the last one.
   2. Match a point to the ONE walkway you are on, not every line within 15 m. A candidate has to run
      the same way you are heading, and only the nearest (plus near-ties, like a doubled line) counts.
      The path you were already on gets a small head start, so the match doesn't flicker between a
      sidewalk and a walkway that run side by side.
   3. Claim walkways in natural stretches. A "stretch" runs from one junction to the next, the way a
      person would describe "that bit of sidewalk". Walking most of a stretch claims all of it, so
      brushing past the end of a side path claims nothing. */
(function(root){
'use strict';

const WALK_MPS = 3;          // filter's allowance for how fast a walker's true position can move (m/s)
const STRETCH_MAX_M = 120;   // longer junction-to-junction runs are split into roughly equal stretches
const STRETCH_MIN_M = 30;    // shorter leftovers (between driveways or side paths) join a neighbor on the same path
const CLAIM_FRAC = 0.6;      // walk this share of a stretch to claim it
const ALIGN_DEG = 40;        // a piece must run within this angle of your heading to count
const TIE_M = 1.5;             // pieces this close to the best match also count (overlapping/doubled lines)
const STICKY_M = 4;          // head start for the path you were just on

/* ---- 1. Smoothing ---- */
function smoother(mps){
  const q=mps||WALK_MPS;
  let lat=0, lng=0, v=-1, t0=0;   // v = variance in m²; -1 = no fix yet
  return {
    reset(){ v=-1; },
    update(la,ln,acc,t){
      acc=Math.max(1,acc||1);
      if(v<0){ lat=la; lng=ln; v=acc*acc; t0=t; return {lat,lng,acc}; }
      const dt=Math.max(0,(t-t0)/1000); t0=t;
      v+=dt*q*q;
      const k=v/(v+acc*acc);
      lat+=k*(la-lat); lng+=k*(ln-lng); v=(1-k)*v;
      return {lat,lng,acc:Math.sqrt(v)};
    }
  };
}

/* ---- 2. Matching ---- */
function angleDiff(a,b){ let d=Math.abs(a-b)%180; return d>90?180-d:d; }   // lines have no direction
function bearing(ax,ay,bx,by){ return (Math.atan2(bx-ax,by-ay)*180/Math.PI+360)%360; }
// cands: [{id, d (m to the piece), brg (deg), stretch}]; heading: deg or null; prev: stretch id you were on.
// Returns the ids of the pieces this point is actually on. No heading (standing still) → nothing.
function pick(cands,heading,prev){
  if(heading==null||!cands.length) return [];
  const ok=cands.filter(c=>angleDiff(c.brg,heading)<=ALIGN_DEG);
  if(!ok.length) return [];
  const score=c=>c.d-(prev&&c.stretch===prev?STICKY_M:0);
  let best=Infinity; ok.forEach(c=>{ best=Math.min(best,score(c)); });
  return ok.filter(c=>score(c)<=best+TIE_M).map(c=>c.id);
}

/* ---- 3. Stretches ---- */
const vkey=p=>p[0].toFixed(6)+','+p[1].toFixed(6);
// paths: [{id, pts:[[lat,lng],...]}]; pieces: [{id, pid, vi (index of the path edge), len}] in path order.
// Returns {of: pieceId→stretchId, list: stretchId→{pid, ids, len}}.
// A junction is a vertex where 3+ walkway ends meet. Where exactly two ways meet end to end (OSM often
// splits one sidewalk into several ways), the stretch carries on across them, up to the length cap.
function stretches(paths,pieces,opts){
  opts=opts||{};
  const maxM=opts.maxM||STRETCH_MAX_M, minM=opts.minM!=null?opts.minM:STRETCH_MIN_M;
  const deg={};   // walkway ends meeting at each vertex
  paths.forEach(p=>p.pts.forEach((q,i)=>{ const k=vkey(q); deg[k]=(deg[k]||0)+(i===0||i===p.pts.length-1?1:2); }));
  const byPath={}; pieces.forEach(s=>(byPath[s.pid]=byPath[s.pid]||[]).push(s));
  const L=a=>a.reduce((m,s)=>m+s.len,0);
  const parts=[], ends={};   // ends: vertex key → parts touching it at a path end
  paths.forEach(p=>{
    const ps=byPath[p.id]; if(!ps||!ps.length) return;
    const runs=[]; let cur=[];
    ps.forEach(s=>{
      if(s.vi>0&&cur.length&&cur[cur.length-1].vi!==s.vi&&deg[vkey(p.pts[s.vi])]!==2){ runs.push(cur); cur=[]; }
      cur.push(s);
    });
    if(cur.length) runs.push(cur);
    let mine=[];
    runs.forEach(r=>{   // split long runs into near-equal stretches by piece count
      const n=Math.max(1,Math.round(L(r)/maxM)), per=Math.ceil(r.length/n);
      for(let i=0;i<r.length;i+=per) mine.push(r.slice(i,i+per));
    });
    for(let i=0;mine.length>1&&i<mine.length;){   // fold tiny parts into the shorter neighbor
      if(L(mine[i])>=minM){ i++; continue; }
      const left=i>0?L(mine[i-1]):Infinity, right=i<mine.length-1?L(mine[i+1]):Infinity;
      if(left<=right){ mine[i-1]=mine[i-1].concat(mine[i]); mine.splice(i,1); }
      else { mine[i+1]=mine[i].concat(mine[i+1]); mine.splice(i,1); }
    }
    mine.forEach((m,k)=>{
      const part={id:p.id+'#'+k, pid:p.id, ids:m.map(s=>s.id), len:L(m), up:null};
      parts.push(part);
      if(k===0) (ends[vkey(p.pts[0])]=ends[vkey(p.pts[0])]||[]).push(part);
      if(k===mine.length-1) (ends[vkey(p.pts[p.pts.length-1])]=ends[vkey(p.pts[p.pts.length-1])]||[]).push(part);
    });
  });
  const root=x=>{ while(x.up) x=x.up; return x; };
  Object.keys(ends).forEach(k=>{   // carry on across a plain two-way joint
    const e=ends[k]; if(deg[k]!==2||e.length!==2) return;
    const a=root(e[0]), b=root(e[1]); if(a===b||a.len+b.len>maxM) return;
    b.up=a; a.ids=a.ids.concat(b.ids); a.len+=b.len;
  });
  const of={}, list={};
  parts.forEach(p=>{ if(p.up) return; list[p.id]={pid:p.pid, ids:p.ids, len:p.len}; p.ids.forEach(id=>{ of[id]=p.id; }); });
  return {of,list};
}
// covered: pieceId→truthy; lens: pieceId→meters
function ready(st,covered,lens){
  let got=0; st.ids.forEach(id=>{ if(covered[id]) got+=lens[id]||0; });
  return got>=CLAIM_FRAC*st.len-1e-6;
}

const api={WALK_MPS,STRETCH_MAX_M,STRETCH_MIN_M,CLAIM_FRAC,ALIGN_DEG,TIE_M,STICKY_M,
  smoother,angleDiff,bearing,pick,stretches,ready};
if(typeof module!=='undefined'&&module.exports) module.exports=api;
else root.RoamTrack=api;
})(typeof window!=='undefined'?window:globalThis);
