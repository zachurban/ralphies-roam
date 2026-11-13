/* BuffPrints — class schedule and commute logic. Pure functions: no DOM, no network, no storage.
   Shared by the app and tests/schedule-core.test.cjs.

   Privacy rule this module enforces: from a calendar file we keep only course code, component
   (lecture, recitation…), meeting days and times, term dates and the BUILDING code. Room numbers,
   instructors, class numbers and every other field are read only long enough to be discarded. */
(function(root){
'use strict';

const TZ = 'America/Denver';
const WALK_MPS = 1.3;            // typical walking pace, about 2.9 mph
const OFF_NET_M = 250;           // a building farther than this from a mapped walkway is "off the map"
const DAY_CODES = {SU:0, MO:1, TU:2, WE:3, TH:4, FR:5, SA:6};
const DAY_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

/* CU Boulder academic calendar (colorado.edu/academics/academic-calendar).
   off = no classes (ranges inclusive). asMonday = the campus follows a Monday schedule that day.
   Midsemester reading days are treated as no-class days. Update each year. */
const TERMS = [
  {name:'Fall 2026',   start:'2026-08-20', end:'2026-12-04',
   off:[['2026-09-07','2026-09-07','Labor Day'],['2026-10-08','2026-10-08','Midsemester reading day'],['2026-11-23','2026-11-25','Fall break'],['2026-11-26','2026-11-27','Thanksgiving']], asMonday:['2026-12-04']},
  {name:'Spring 2027', start:'2027-01-07', end:'2027-04-23',
   off:[['2027-01-18','2027-01-18','Martin Luther King Jr. Day'],['2027-02-25','2027-02-25','Midsemester reading day'],['2027-03-15','2027-03-19','Spring break']], asMonday:['2027-04-23']}
];

const COMPONENTS = [
  [/\bLEC\b|LECTURE/i,'Lecture'], [/\bREC\b|RECITATION/i,'Recitation'], [/\bLAB\b|LABORATORY/i,'Lab'],
  [/\bSEM\b|SEMINAR/i,'Seminar'], [/\bSTU\b|STUDIO/i,'Studio'], [/\bDIS\b|DISCUSSION/i,'Discussion'],
  [/\bPRA\b|PRACTICUM/i,'Practicum'], [/\bIND\b|INDEPENDENT/i,'Independent study'], [/\bCLN\b|CLINICAL/i,'Clinical']
];
// Explicitly online -> no walk. Unknown (TBA, blank, arranged) is NOT online: the student picks the building.
const ONLINE = /\b(REMOTE|ONLINE|ZOOM|ASYNC\w*|SYNCHRONOUS|WEB[- ]?BASED|DISTANCE)\b/i;
const NO_ROOM = /^\s*$|^\s*(TBA|TBD|ARR|ARRANGED|NO ROOM|NOT ASSIGNED|STAFF)\b|\b(TBA|TBD)\s*$/i;

/* ---------- iCalendar (RFC 5545) reading ---------- */

// Unfold continuation lines (CRLF followed by one space or tab) before anything else.
function unfold(text){
  const out=[];
  String(text).replace(/^﻿/,'').split(/\r\n|\n|\r/).forEach(l=>{
    if((l[0]===' '||l[0]==='\t')&&out.length) out[out.length-1]+=l.slice(1); else out.push(l);
  });
  return out;
}
// "NAME;P1=a;P2="x:y":value" -> {name, params, value}. Colons inside quoted parameters are not separators.
function contentLine(line){
  let q=false, i=0;
  for(;i<line.length;i++){ const c=line[i]; if(c==='"') q=!q; else if(c===':'&&!q) break; }
  if(i>=line.length) return null;
  const head=line.slice(0,i), value=line.slice(i+1), parts=[]; let cur='', qq=false;
  for(const c of head){ if(c==='"'){ qq=!qq; continue; } if(c===';'&&!qq){ parts.push(cur); cur=''; } else cur+=c; }
  parts.push(cur);
  const params={};
  parts.slice(1).forEach(p=>{ const k=p.indexOf('='); if(k>0) params[p.slice(0,k).toUpperCase()]=p.slice(k+1); });
  return {name:parts[0].toUpperCase(), params, value};
}
function unescapeText(v){ return String(v).replace(/\\([\\;,nN])/g,(m,c)=>c==='n'||c==='N'?'\n':c); }

// Wall-clock parts of a UTC instant in Denver.
function denverParts(ms){
  const f=new Intl.DateTimeFormat('en-US',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  const o={}; f.formatToParts(new Date(ms)).forEach(p=>{ o[p.type]=p.value; });
  return {date:o.year+'-'+o.month+'-'+o.day, time:o.hour+':'+o.minute};
}
// iCalendar DATE / DATE-TIME -> Denver {date:'YYYY-MM-DD', time:'HH:MM'|null}.
// TZID=America/Denver and floating times are already wall-clock; a trailing Z is UTC and is converted.
function icalTime(value, params){
  const m=/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(String(value).trim());
  if(!m) return null;
  if(!m[4]) return {date:m[1]+'-'+m[2]+'-'+m[3], time:null};
  if(m[7]) return denverParts(Date.UTC(+m[1],+m[2]-1,+m[3],+m[4],+m[5],+(m[6]||0)));
  return {date:m[1]+'-'+m[2]+'-'+m[3], time:m[4]+':'+m[5]};
}

/* "CSCI 1300-001 - Computer Science 1: Starting Computing (LEC)" -> course, title, component. Section dropped. */
function parseSummary(s){
  s=String(s||'').trim();
  const m=/^([A-Z]{3,4})\s*-?\s*(\d{4}[A-Z]?)(?:[-\s]+([0-9]{3}[A-Z]?|[0-9]{2,3}[A-Z]{1,2}))?\s*(?:[-–:]\s*)?(.*)$/.exec(s);
  const tag=/\(([A-Z]{3})\)\s*$/.exec(s); let comp=null;
  if(tag) for(const [re,n] of COMPONENTS) if(re.test(tag[1])){ comp=n; break; }
  if(!m) return {course:s.slice(0,40)||'Class', title:'', component:comp};
  const title=m[4].replace(/\s*\([A-Z]{3}\)\s*$/,'').trim();
  return {course:m[1]+' '+m[2], title:title.slice(0,80), component:comp};
}
// Only the component word is taken from DESCRIPTION; nothing else in it is kept.
function componentFrom(desc){
  const first=String(desc||'').split('\n').slice(0,2).join(' ');
  for(const [re,n] of COMPONENTS) if(re.test(first)) return n;
  return null;
}
/* LOCATION -> {code} | {online:true} | {unknown:'raw building text'|'TBA'}. The room never leaves this function.
   Handles "ECCR 265", "Engineering Center, ECCR 265", "HUMN 1B50", "ONLINE", "REMOTE", "TBA", "". */
function parseLocation(loc, known){
  const raw=String(loc||'').trim();
  if(ONLINE.test(raw)) return {online:true};
  if(NO_ROOM.test(raw)) return {unknown:'TBA'};
  const tail=raw.split(',').pop().trim().toUpperCase();
  const isKnown=c=>!known||known.has(c);
  const cands=[];
  const re=/\b([A-Z][A-Z0-9]{1,5}(?:-[A-Z0-9]{1,3})?)\b(?=\s+[A-Z]?\d)/g; let m;
  for(const txt of [tail, raw.toUpperCase()]){ re.lastIndex=0; while((m=re.exec(txt))) cands.push(m[1]); }
  const first=/^([A-Z][A-Z0-9]{1,5})\b/.exec(tail); if(first) cands.push(first[1]);
  const pick=cands.find(isKnown)||cands[0];
  if(pick) return {code:pick};
  return {unknown:raw.split(',')[0].replace(/\s+\S*\d\S*$/,'').slice(0,60)};
}

function addDays(ymd,n){ const d=new Date(ymd+'T12:00:00Z'); d.setUTCDate(d.getUTCDate()+n); return d.toISOString().slice(0,10); }
function weekday(ymd){ return new Date(ymd+'T12:00:00Z').getUTCDay(); }
function toMin(hhmm){ const [h,m]=hhmm.split(':').map(Number); return h*60+m; }

function rrule(value){
  const o={}; String(value).split(';').forEach(p=>{ const k=p.indexOf('='); if(k>0) o[p.slice(0,k).toUpperCase()]=p.slice(k+1); }); return o;
}

/* Parse a whole .ics file. Returns {classes, skipped, termGuess}.
   class = {id, course, title, component, days:[1..5], start:'HH:MM', end:'HH:MM', first:'YYYY-MM-DD', last:'YYYY-MM-DD',
            interval, exdates:[...], code|null, online:bool, unknownPlace:string|null}
   Lecture and recitation stay separate classes (separate VEVENTs, different UIDs). */
function parseICS(text, opts){
  opts=opts||{}; const known=opts.known?new Set(opts.known):null;
  const lines=unfold(text), classes=[], skipped=[];
  if(!lines.some(l=>/^BEGIN:VCALENDAR/i.test(l))) throw new Error('This doesn’t look like a calendar (.ics) file.');
  let ev=null, depth=0, n=0;
  for(const line of lines){
    if(!line.trim()) continue;
    const cl=contentLine(line); if(!cl) continue;
    if(cl.name==='BEGIN'){ if(cl.value.toUpperCase()==='VEVENT'){ ev={ex:[]}; depth=0; } else if(ev) depth++; continue; }
    if(cl.name==='END'){ if(cl.value.toUpperCase()==='VEVENT'&&ev){ const r=finish(ev); if(r.skip) skipped.push(r.skip); else classes.push(r.cls); ev=null; } else if(ev) depth--; continue; }
    if(!ev||depth>0) continue;                      // ignore VALARM etc. nested inside the event
    if(cl.name==='EXDATE') ev.ex.push(cl); else if(!(cl.name in ev)) ev[cl.name]=cl;
  }
  function finish(e){
    const sum=parseSummary(unescapeText(e.SUMMARY?e.SUMMARY.value:''));
    const label=sum.course;
    if(e.STATUS&&/CANCELLED/i.test(e.STATUS.value)) return {skip:{course:label, reason:'cancelled'}};
    const ds=e.DTSTART&&icalTime(e.DTSTART.value,e.DTSTART.params), de=e.DTEND&&icalTime(e.DTEND.value,e.DTEND.params);
    if(!ds||!ds.time) return {skip:{course:label, reason:'no meeting time'}};
    let end=de&&de.time;
    if(!end&&e.DURATION){ const d=/PT(?:(\d+)H)?(?:(\d+)M)?/.exec(e.DURATION.value); if(d){ const t=toMin(ds.time)+(+d[1]||0)*60+(+d[2]||0); end=String(Math.floor(t/60)%24).padStart(2,'0')+':'+String(t%60).padStart(2,'0'); } }
    if(!end) end=ds.time;
    const rr=e.RRULE?rrule(e.RRULE.value):null;
    let days=[weekday(ds.date)], last=ds.date, interval=1;
    if(rr){
      if(rr.FREQ&&rr.FREQ.toUpperCase()!=='WEEKLY') return {skip:{course:label, reason:'repeats '+rr.FREQ.toLowerCase()+' (only weekly classes are supported)'}};
      if(rr.BYDAY) days=rr.BYDAY.split(',').map(d=>DAY_CODES[d.replace(/^[+-]?\d+/,'').toUpperCase()]).filter(d=>d!=null);
      interval=Math.max(1,parseInt(rr.INTERVAL||'1',10)||1);
      if(rr.UNTIL){ const u=icalTime(rr.UNTIL,{}); if(u) last=u.date; }
      else if(rr.COUNT){                               // walk forward until COUNT meetings are used up
        let c=parseInt(rr.COUNT,10)||1, d=ds.date, guard=0;
        while(c>0&&guard++<800){ if(days.includes(weekday(d))&&weekOf(d,ds.date)%interval===0){ c--; last=d; } d=addDays(d,1); }
      } else last=addDays(ds.date,7*20);              // open-ended: assume one term
    }
    days=[...new Set(days)].sort();
    const exdates=[];
    e.ex.forEach(x=>x.value.split(',').forEach(v=>{ const t=icalTime(v,x.params); if(t) exdates.push(t.date); }));
    const place=parseLocation(e.LOCATION?unescapeText(e.LOCATION.value):'', known);
    const component=sum.component||componentFrom(e.DESCRIPTION?unescapeText(e.DESCRIPTION.value):'');
    n++;
    return {cls:{id:'c'+n, course:sum.course, title:sum.title, component, days, start:ds.time, end, first:ds.date, last, interval,
      exdates:[...new Set(exdates)].sort(), code:place.code||null, online:!!place.online, unknownPlace:place.unknown||null}};
  }
  if(!classes.length&&!skipped.length) throw new Error('No classes were found in this file.');
  return {classes, skipped};
}
function weekOf(d,anchor){ return Math.floor((Date.parse(d+'T12:00:00Z')-Date.parse(anchor+'T12:00:00Z'))/(7*864e5)); }

/* ---------- which classes meet on a given day ---------- */
function termFor(ymd){ return TERMS.find(t=>ymd>=t.start&&ymd<=t.end)||null; }
function campusDay(ymd){
  const t=termFor(ymd);
  if(!t) return {term:null, off:false, wd:weekday(ymd)};
  const hit=t.off.find(r=>ymd>=r[0]&&ymd<=r[1]);
  return {term:t.name, off:!!hit, reason:hit?hit[2]||'No classes':null, wd:t.asMonday.includes(ymd)?1:weekday(ymd), asMonday:t.asMonday.includes(ymd)};
}
function meetsOn(c, ymd){
  if(c.online||ymd<c.first||ymd>c.last||c.exdates.includes(ymd)) return false;
  // Buff Portal repeats run into finals week; regular meetings end on the term's last day of classes.
  const home=termFor(c.first); if(home&&ymd>home.end) return false;
  const cd=campusDay(ymd);
  if(cd.off) return false;
  // On a "Monday schedule" Friday, Monday classes meet and Friday classes don't.
  if(!c.days.includes(cd.wd)) return false;
  if(c.interval>1&&weekOf(ymd,c.first)%c.interval!==0) return false;
  return true;
}
function classesOn(classes, ymd){ return classes.filter(c=>meetsOn(c,ymd)).sort((a,b)=>a.start.localeCompare(b.start)); }
// Next date (today included) with at least one in-person class, within 14 days.
function nextClassDay(classes, ymd){
  for(let i=0;i<14;i++){ const d=addDays(ymd,i); if(classesOn(classes,d).length) return d; }
  return null;
}
function mondayOf(ymd){ const w=weekday(ymd); return addDays(ymd, w===0?-6:1-w); }
// Dates from..to (inclusive) with at least one in-person class.
function classDates(classes, from, to){ const out=[]; for(let d=from; d<=to; d=addDays(d,1)) if(classesOn(classes,d).length) out.push(d); return out; }
function denverToday(ms){ return denverParts(ms==null?Date.now():ms); }

/* Stops for a day: start place -> each class building in time order -> start place.
   Back-to-back classes in the same building are one stop. */
function dayStops(classes, ymd, home){
  const list=classesOn(classes,ymd).filter(c=>c.code);
  const stops=[{kind:'home', key:'home', label:home?home.name:'Start'}];
  list.forEach(c=>{
    const prev=stops[stops.length-1];
    if(prev.kind==='class'&&prev.code===c.code){ prev.classes.push(c); prev.end=c.end; return; }
    stops.push({kind:'class', key:c.code, code:c.code, label:c.code, start:c.start, end:c.end, classes:[c]});
  });
  if(stops.length>1) stops.push({kind:'home', key:'home', label:home?home.name:'Start'});
  return stops;
}

/* ---------- walkway routing ---------- */
const r6=x=>Math.round(x*1e6)/1e6;
function hav(a,b){
  const R=6371000, r=x=>x*Math.PI/180, dLat=r(b[0]-a[0]), dLng=r(b[1]-a[1]);
  const h=Math.sin(dLat/2)**2+Math.cos(r(a[0]))*Math.cos(r(b[0]))*Math.sin(dLng/2)**2;
  return 2*R*Math.asin(Math.min(1,Math.sqrt(h)));
}
/* paths: [{id, pts:[[lat,lng],...]}]. Walkways that meet share an OSM node, so equal coordinates join them.
   Edge key "pathId.i" is the i-th piece of a path; the app maps it to its claimable sections. */
function buildGraph(paths){
  const idx=new Map(), pts=[], adj=[];
  const node=p=>{ const k=r6(p[0])+','+r6(p[1]); let i=idx.get(k); if(i==null){ i=pts.length; idx.set(k,i); pts.push([p[0],p[1]]); adj.push([]); } return i; };
  paths.forEach(p=>{ for(let i=0;i<p.pts.length-1;i++){ const a=node(p.pts[i]), b=node(p.pts[i+1]); if(a===b) continue;
    const len=hav(p.pts[i],p.pts[i+1]), key=p.id+'.'+i; adj[a].push([b,len,key]); adj[b].push([a,len,key]); } });
  return {pts, adj};
}
function nearestNode(g, p){
  let best=-1, bd=Infinity;
  for(let i=0;i<g.pts.length;i++){ if(!g.adj[i].length) continue; const q=g.pts[i];
    const dy=(q[0]-p[0])*111320, dx=(q[1]-p[1])*85280, d=dx*dx+dy*dy; if(d<bd){ bd=d; best=i; } }
  return best<0?null:{node:best, gap:Math.sqrt(bd)};
}
// Closest walkway point to any corner of a building (or to its center when there is no outline).
function placeNode(g, place){
  const cands=(place.outline&&place.outline.length?place.outline:[]).concat([[place.lat,place.lng]]);
  let best=null; cands.forEach(c=>{ const n=nearestNode(g,c); if(n&&(!best||n.gap<best.gap)) best=n; });
  return best;
}
// Dijkstra with a binary heap. cost(len, key) lets the scenic search discount unwalked pieces.
function shortest(g, from, to, cost){
  const N=g.pts.length, dist=new Float64Array(N).fill(Infinity), prev=new Int32Array(N).fill(-1), via=new Array(N);
  const heap=[]; const push=(d,i)=>{ heap.push([d,i]); let k=heap.length-1; while(k>0){ const p=(k-1)>>1; if(heap[p][0]<=heap[k][0]) break; [heap[p],heap[k]]=[heap[k],heap[p]]; k=p; } };
  const pop=()=>{ const top=heap[0], last=heap.pop(); if(heap.length){ heap[0]=last; let k=0; for(;;){ const l=2*k+1, r=l+1; let m=k;
    if(l<heap.length&&heap[l][0]<heap[m][0]) m=l; if(r<heap.length&&heap[r][0]<heap[m][0]) m=r; if(m===k) break; [heap[m],heap[k]]=[heap[k],heap[m]]; k=m; } } return top; };
  dist[from]=0; push(0,from);
  while(heap.length){ const [d,u]=pop(); if(d>dist[u]) continue; if(u===to) break;
    for(const [v,len,key] of g.adj[u]){ const nd=d+(cost?cost(len,key):len); if(nd<dist[v]){ dist[v]=nd; prev[v]=u; via[v]=[key,len]; push(nd,v); } } }
  if(!isFinite(dist[to])) return null;
  const nodes=[to], keys=[]; let meters=0;
  for(let v=to; prev[v]>=0; v=prev[v]){ keys.push(via[v][0]); meters+=via[v][1]; nodes.push(prev[v]); }
  nodes.reverse(); keys.reverse();
  return {nodes, keys, meters, line:nodes.map(i=>g.pts[i])};
}
/* Direct route plus, when it is worth it, a "scenic" one that trades a little extra walking for paths
   the student hasn't walked. newLen(key) -> meters of that piece not yet claimed.
   Candidates come from discounting unwalked pieces and, so a brand-new player also gets a real
   alternative, from making the direct route's own pieces more expensive.
   Scenic is offered only if it adds at most ~25% (between 120 m and 300 m) and covers at least 40 m more new ground. */
function commuteLeg(g, a, b, newLen){
  const direct=shortest(g,a,b); if(!direct) return null;
  // a piece can't be "newer" than it is long; this also keeps every edge cost positive for Dijkstra
  const lenOf={}; g.adj.forEach(es=>es.forEach(([,len,key])=>{ lenOf[key]=len; }));
  const nl=k=>Math.max(0,Math.min(lenOf[k]||0,newLen(k)));
  const fresh=r=>r.keys.reduce((s,k)=>s+nl(k),0);
  direct.fresh=fresh(direct);
  const cap=Math.min(300,Math.max(120,direct.meters*0.25)), onDirect=new Set(direct.keys);
  let scenic=null;
  for(const pen of [1,1.8,3]) for(const f of [0.6,0.4,0.25]){
    if(pen===1&&f===0.6&&direct.fresh>=direct.meters-1) continue;      // same as direct when nothing is walked
    const r=shortest(g,a,b,(len,key)=>(onDirect.has(key)?len*pen:len)-nl(key)*(1-f));
    if(!r) continue; r.fresh=fresh(r);
    if(r.meters<=direct.meters+cap&&r.fresh>=direct.fresh+40&&(!scenic||r.fresh-r.meters*0.2>scenic.fresh-scenic.meters*0.2)) scenic=r;
  }
  return {direct, scenic};
}
const minutes=m=>Math.max(1,Math.round(m/WALK_MPS/60));

/* Single-source Dijkstra over the whole network (no target). meters[] are real distances; dist[] is the weighted cost. */
function tree(g, src, cost){
  const N=g.pts.length, dist=new Float64Array(N).fill(Infinity), meters=new Float64Array(N).fill(Infinity), prev=new Int32Array(N).fill(-1), via=new Array(N);
  const heap=[]; const push=(d,i)=>{ heap.push([d,i]); let k=heap.length-1; while(k>0){ const p=(k-1)>>1; if(heap[p][0]<=heap[k][0]) break; [heap[p],heap[k]]=[heap[k],heap[p]]; k=p; } };
  const pop=()=>{ const top=heap[0], last=heap.pop(); if(heap.length){ heap[0]=last; let k=0; for(;;){ const l=2*k+1, r=l+1; let m=k;
    if(l<heap.length&&heap[l][0]<heap[m][0]) m=l; if(r<heap.length&&heap[r][0]<heap[m][0]) m=r; if(m===k) break; [heap[m],heap[k]]=[heap[k],heap[m]]; k=m; } } return top; };
  dist[src]=0; meters[src]=0; push(0,src);
  while(heap.length){ const [d,u]=pop(); if(d>dist[u]) continue;
    for(const [v,len,key] of g.adj[u]){ const nd=d+(cost?cost(len,key):len); if(nd<dist[v]){ dist[v]=nd; meters[v]=meters[u]+len; prev[v]=u; via[v]=key; push(nd,v); } } }
  return {dist, meters, prev, via};
}
// path src -> v from a tree: {keys, nodes}
function treePath(t, v){ const keys=[], nodes=[v]; for(let x=v; t.prev[x]>=0; x=t.prev[x]){ keys.push(t.via[x]); nodes.push(t.prev[x]); } return {keys:keys.reverse(), nodes:nodes.reverse()}; }
function lenIndex(g){ const L={}; g.adj.forEach(es=>es.forEach(([,len,key])=>{ L[key]=len; })); return L; }

/* Gap explorer: a walk from class A to class B that fits in budgetM meters and covers as much unwalked ground as it can.
   It goes out through a turnaround point and on to B; pieces walked twice count once. Offered only when it covers at
   least 100 m more new ground than the direct route. */
function gapLoop(g, a, b, budgetM, newLen){
  const L=lenIndex(g), nl=k=>Math.max(0,Math.min(L[k]||0,newLen(k)));
  const direct=shortest(g,a,b); if(!direct) return null;
  direct.fresh=direct.keys.reduce((s,k)=>s+nl(k),0);
  if(budgetM<direct.meters+150) return null;
  const F=0.6, cost=(len,key)=>len-nl(key)*F;
  const A=tree(g,a,cost), B=tree(g,b,cost), cand=[];
  for(let v=0; v<g.pts.length; v++){
    if(!isFinite(A.meters[v])||!isFinite(B.meters[v])) continue;
    const tot=A.meters[v]+B.meters[v]; if(tot>budgetM) continue;
    const fr=(A.meters[v]-A.dist[v]+B.meters[v]-B.dist[v])/F;   // new meters along both halves (double-counts overlap)
    cand.push([fr,v]);
  }
  cand.sort((x,y)=>y[0]-x[0]);
  let best=null;
  for(const [,v] of cand.slice(0,40)){
    const pa=treePath(A,v), pb=treePath(B,v), keys=pa.keys.concat(pb.keys.slice().reverse());
    const uniq=new Set(keys), fresh=[...uniq].reduce((s,k)=>s+nl(k),0), meters=A.meters[v]+B.meters[v];
    if(!best||fresh>best.fresh) best={keys, fresh, meters, via:v, nodes:pa.nodes.concat(pb.nodes.slice().reverse().slice(1))};
  }
  if(!best||best.fresh<direct.fresh+100) return null;
  best.line=best.nodes.map(i=>g.pts[i]); best.direct=direct;
  return best;
}

/* Meet-ups. blocks = one person's in-person classes on a weekday: [{s:'HH:MM', e:'HH:MM', code}], any order.
   A free window is the time between two classes on the same day (so both people are on campus).
   Returns overlapping windows of at least minMin minutes with where each person comes from and goes to. */
function freeWindows(blocks){
  const b=blocks.slice().sort((x,y)=>x.s.localeCompare(y.s)), out=[];
  for(let i=0;i<b.length-1;i++) if(b[i+1].s>b[i].e) out.push({s:b[i].e, e:b[i+1].s, from:b[i].code, to:b[i+1].code});
  return out;
}
function meetWindows(mine, theirs, minMin){
  const out=[], A=freeWindows(mine), B=freeWindows(theirs);
  A.forEach(x=>B.forEach(y=>{ const s=x.s>y.s?x.s:y.s, e=x.e<y.e?x.e:y.e;
    if(toMin(e)-toMin(s)>=(minMin||20)) out.push({s, e, me:{from:x.from,to:x.to}, them:{from:y.from,to:y.to}}); }));
  return out;
}
/* The fairest meeting point: the walkway point that minimizes the longer of the two walks (ties: shorter total). */
function meetPoint(g, a, b){
  const A=tree(g,a), B=tree(g,b); let best=-1, bs=Infinity;
  for(let v=0; v<g.pts.length; v++){ const x=A.meters[v], y=B.meters[v]; if(!isFinite(x)||!isFinite(y)) continue;
    const sc=Math.max(x,y)+0.1*(x+y); if(sc<bs){ bs=sc; best=v; } }
  if(best<0) return null;
  return {node:best, pt:g.pts[best], mine:A.meters[best], theirs:B.meters[best], line:treePath(A,best).nodes.map(i=>g.pts[i])};
}
/* Weekly pattern of in-person classes with a building, for sharing: {1:[[s,e,code],...], ...}. No course names. */
function weekPattern(classes){
  const d={}; classes.filter(c=>c.code&&!c.online).forEach(c=>c.days.forEach(w=>{ (d[w]=d[w]||[]).push([c.start,c.end,c.code]); }));
  Object.keys(d).forEach(w=>d[w].sort((x,y)=>x[0].localeCompare(y[0]))); return d;
}

root.RoamSchedule={TZ, TERMS, WALK_MPS, OFF_NET_M, DAY_NAMES,
  unfold, contentLine, unescapeText, icalTime, parseSummary, parseLocation, parseICS,
  campusDay, meetsOn, classesOn, nextClassDay, dayStops, denverToday, addDays, weekday, mondayOf, classDates, termFor,
  buildGraph, nearestNode, placeNode, shortest, commuteLeg, minutes, hav, tree, gapLoop, freeWindows, meetWindows, meetPoint, weekPattern, toMin};
})(typeof window!=='undefined'?window:globalThis);
