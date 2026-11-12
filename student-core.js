/* BuffPrints — pure functions shared by the app and its regression tests.
   No DOM, no network, no storage. Everything here can be unit-tested in Node. */
(function(root){
'use strict';

const MIN_WALK_M = 160;
const VISIT_M = 30;               // walk this much of a path (or half of a short one) before it counts as visited          // a recorded walk counts toward the walks goal at 0.1 mi or more
const TRIM_M = 150;              // route previews drop this much from each end to hide start/finish
const GOAL_TARGETS = {
  paths:    {choices:[5,10,20,40], def:10},  // visit N paths you have never been on before (OSM splits sidewalks into short pieces)
  walks:    {choices:[1,2,3,5],  def:3},   // record N walks of 0.1 mi or more
  zone:     {choices:[1,2],      def:1},   // set foot in N campus zones for the first time
  complete: {choices:[3,5,10],   def:3}    // walk every section of N paths
};
const GOAL_ORDER = ['paths','walks','zone','complete'];
const GOAL_DEFAULT_ON = {paths:true, walks:true, zone:true, complete:false};

function hav(a,b){
  const R=6371000, r=x=>x*Math.PI/180;
  const dLat=r(b[0]-a[0]), dLng=r(b[1]-a[1]);
  const h=Math.sin(dLat/2)**2+Math.cos(r(a[0]))*Math.cos(r(b[0]))*Math.sin(dLng/2)**2;
  return 2*R*Math.asin(Math.min(1,Math.sqrt(h)));
}

const api = {
  MIN_WALK_M, VISIT_M, TRIM_M, GOAL_TARGETS, GOAL_ORDER,

  /* Legacy weekly segment goal (kept so older saved settings still parse). */
  goal(value){ return [25,50,100,200].includes(Number(value)) ? Number(value) : 50; },

  /* Normalize saved goal settings. Unknown or invalid values fall back to safe defaults. */
  goalsConfig(raw){
    const out={};
    GOAL_ORDER.forEach(id=>{
      const t=GOAL_TARGETS[id], r=raw&&typeof raw==='object'&&raw[id]&&typeof raw[id]==='object'?raw[id]:{};
      out[id]={on: typeof r.on==='boolean'?r.on:GOAL_DEFAULT_ON[id],
               target: t.choices.includes(Number(r.target))?Number(r.target):t.def};
    });
    return out;
  },

  /* Per-path history from the claimed-section map.
     claimed: {sectionId: timestampMs}; segIndex: {sectionId: {pid, zone, len}}; pathSegCount: {pid: n}.
     A path counts as VISITED once you have walked VISIT_M of it (or half of a path shorter than 2×VISIT_M),
     so brushing the end of a crossing sidewalk doesn't count. It is COMPLETE when every section is walked. */
  pathHistory(claimed, segIndex, pathSegCount, pathLen){
    const per={};
    Object.keys(claimed||{}).forEach(id=>{
      const ts=Number(claimed[id]), meta=segIndex[id];
      if(!meta || !isFinite(ts)) return;       // section no longer exists in the walkway data
      (per[meta.pid]=per[meta.pid]||{zone:meta.zone,items:[]}).items.push([ts,Number(meta.len)||0]);
    });
    const paths={}, zones={};
    Object.keys(per).forEach(pid=>{
      const it=per[pid].items.sort((a,b)=>a[0]-b[0]);
      const total=pathSegCount[pid]||0, len=(pathLen&&pathLen[pid])||it.reduce((m,x)=>m+x[1],0);
      const need=Math.min(VISIT_M, len/2);
      let acc=0, visitedAt=null; for(const [t,l] of it){ acc+=l; if(visitedAt==null && acc>=need-1e-6) visitedAt=t; }
      const p={first:it[0][0], last:it[it.length-1][0], got:it.length, total, zone:per[pid].zone, walked:acc, len,
               visited:visitedAt!=null, visitedAt, complete:total>0&&it.length>=total};
      paths[pid]=p;
      if(p.visited){ const z=zones[p.zone]; zones[p.zone]=z?Math.min(z,visitedAt):visitedAt; }
    });
    return {paths, zones};
  },

  /* Activity since `since` (ms). Only counts what the recorded data establishes. */
  activitySince(history, sessions, since, opts){
    const skipZones=(opts&&opts.skipZones)||[];
    let newPaths=0, completed=0; const newZones=[];
    Object.keys(history.paths).forEach(pid=>{
      const p=history.paths[pid];
      if(p.visited && p.visitedAt>=since) newPaths++;
      if(p.complete && p.last>=since) completed++;
    });
    Object.keys(history.zones).forEach(z=>{ if(history.zones[z]>=since && skipZones.indexOf(z)<0) newZones.push(z); });
    const walks=(Array.isArray(sessions)?sessions:[]).filter(s=>s&&Date.parse(s.at)>=since&&Number(s.meters)>=MIN_WALK_M);
    return {newPaths, completed, newZones, walks:walks.length, walkMeters:walks.reduce((a,s)=>a+Number(s.meters||0),0)};
  },

  /* Goal rows for display. `zonesLeft` = named zones never visited (a zone goal is pointless when it's 0). */
  goalRows(config, act, zonesLeft){
    const c=api.goalsConfig(config), rows=[];
    const add=(id,label,detail,value)=>{ const g=c[id]; if(!g.on) return;
      rows.push({id,label,detail,value:Math.min(value,g.target),raw:value,target:g.target,done:value>=g.target}); };
    add('paths', 'Visit '+c.paths.target+' new path'+(c.paths.target>1?'s':''), 'Paths you had never walked before, any part of them', act.newPaths);
    add('walks', 'Complete '+c.walks.target+' walk'+(c.walks.target>1?'s':''), 'Recorded walks of 0.1 mi or more', act.walks);
    if(zonesLeft>0 || act.newZones.length) add('zone', 'Explore '+(c.zone.target>1?c.zone.target+' new zones':'a new campus zone'), 'A zone you had never visited before', act.newZones.length);
    add('complete', 'Finish '+c.complete.target+' path'+(c.complete.target>1?'s':'')+' end to end', 'Every section of a path walked', act.completed);
    return rows;
  },

  /* Summary of one recorded walk. Raw GPS points are never included; only an optional trimmed shape. */
  session(start, end, meters, newSegments, extra){
    const s={at:new Date(start).toISOString(), seconds:Math.max(0,Math.round((end-start)/1000)),
             meters:Math.max(0,meters), newSegments:Math.max(0,newSegments)};
    if(extra){
      s.moving=Math.max(0,Math.round(Number(extra.moving)||0));
      s.newPaths=Math.max(0,Number(extra.newPaths)||0);
      s.completedPaths=Math.max(0,Number(extra.completedPaths)||0);
      s.shape=Array.isArray(extra.shape)&&extra.shape.length>1?extra.shape:null;
    }
    return s;
  },

  /* Privacy-preserving route preview: drop TRIM_M from both ends, simplify, round to ~1 m.
     Returns null when the walk is too short to hide its start and finish. */
  trimRoute(points, trimM){
    trimM = trimM==null ? TRIM_M : trimM;
    const pts=(points||[]).filter(p=>Array.isArray(p)&&isFinite(p[0])&&isFinite(p[1])).map(p=>[p[0],p[1]]);
    if(pts.length<3) return null;
    const cum=[0]; for(let i=1;i<pts.length;i++) cum.push(cum[i-1]+hav(pts[i-1],pts[i]));
    const total=cum[cum.length-1];
    if(total < 2*trimM + 100) return null;
    const lo=trimM, hi=total-trimM, out=[];
    const at=(d)=>{ let i=1; while(i<cum.length&&cum[i]<d) i++; const a=pts[i-1], b=pts[i], seg=cum[i]-cum[i-1]||1, t=(d-cum[i-1])/seg;
      return [a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t]; };
    out.push(at(lo));
    for(let i=0;i<pts.length;i++) if(cum[i]>lo&&cum[i]<hi) out.push(pts[i]);
    out.push(at(hi));
    const step=Math.max(1,Math.ceil(out.length/160));
    const simp=out.filter((p,i)=>i%step===0||i===out.length-1);
    return simp.map(p=>[Math.round(p[0]*1e5)/1e5, Math.round(p[1]*1e5)/1e5]);
  },

  /* Text-only lines for a share card: no names, places, times of day or identifiers. */
  shareLines(s){
    const mi=(s.meters/1609.344);
    const lines=[{k:'Distance',v:mi.toFixed(2)+' mi'}, {k:'Elapsed time',v:api.duration(s.seconds)}];
    if(s.newPaths) lines.push({k:'New paths',v:String(s.newPaths)});
    if(s.completedPaths) lines.push({k:'Paths completed',v:String(s.completedPaths)});
    return lines;
  },

  duration(sec){
    sec=Math.max(0,Math.round(sec||0)); const h=Math.floor(sec/3600), m=Math.floor(sec%3600/60), s=sec%60;
    return h ? h+' h '+m+' min' : m ? m+' min'+(m<10&&s?' '+s+' s':'') : s+' s';
  },

  draft({category,location,observation,request,date}){
    return 'Campus maintenance / accessibility concern\n\nLocation: '+location.trim()+'\nCategory: '+category+'\nObserved: '+date+'\n\nWhat I observed:\n'+observation.trim()+'\n\nRequested action:\n'+request.trim()+'\n\nPlease confirm the responsible office, provide a reference number, and advise on next steps.\n\nPrepared by a student using BuffPrints. This draft has not been submitted. No official verification is implied.';
  },

  /* Follow-up tracker entries are always self-reported by the student. */
  requestStatus(req){
    if(!req) return {label:'Draft', kind:'draft'};
    const ups=Array.isArray(req.updates)?req.updates:[];
    const last=ups[ups.length-1];
    if(last) return {label:last.status, kind:'update', source:last.source, date:last.date, selfReported:true};
    if(req.submitted) return {label:'Submitted by you', kind:'submitted', source:req.submitted.to, date:req.submitted.date, selfReported:true};
    return {label:'Draft — not submitted', kind:'draft'};
  }
};

if(typeof module!=='undefined'&&module.exports) module.exports=api;
else root.RoamStudent=api;
})(typeof window!=='undefined'?window:globalThis);
