const {test}=require('node:test');
const assert=require('node:assert/strict');
const core=require('../student-core');

test('legacy weekly segment goal allows only supported finite choices',()=>{
  for(const value of [null,undefined,-5,Infinity,'garbage',51])assert.equal(core.goal(value),50);
  assert.equal(core.goal('100'),100);
});

test('goal settings normalize to safe defaults and keep valid choices',()=>{
  const d=core.goalsConfig(null);
  assert.deepEqual(d.paths,{on:true,target:10}); assert.deepEqual(d.complete,{on:false,target:3});
  const c=core.goalsConfig({paths:{on:false,target:'20'},walks:{target:99},zone:'junk'});
  assert.equal(c.paths.on,false); assert.equal(c.paths.target,20); assert.equal(c.walks.target,3); assert.equal(c.zone.on,true);
});

// Fixture: path A has 3 sections, path B has 2, path C has 1. Week starts at t=1000.
// Sections are 20 m, so walking 2 sections (40 m) of a long path visits it; 1 section (20 m) does not.
const segIndex={'wA.0.0':{pid:'wA',zone:'norlin',len:20},'wA.0.1':{pid:'wA',zone:'norlin',len:20},'wA.1.0':{pid:'wA',zone:'norlin',len:20},
                'wB.0.0':{pid:'wB',zone:'farrand',len:20},'wB.0.1':{pid:'wB',zone:'farrand',len:20},'wC.0.0':{pid:'wC',zone:'campus',len:12},
                'wL.0.0':{pid:'wL',zone:'norlin',len:20},'wL.0.1':{pid:'wL',zone:'norlin',len:20},'wL.0.2':{pid:'wL',zone:'norlin',len:20},'wL.0.3':{pid:'wL',zone:'norlin',len:20},'wL.0.4':{pid:'wL',zone:'norlin',len:20}};
const counts={wA:3,wB:2,wC:1,wL:5};
const lens={wA:60,wB:40,wC:12,wL:100};

test('a path counts as visited only after a meaningful stretch is walked, credited when that happens',()=>{
  const claimed={'wA.0.0':500,'wA.0.1':1500,'wB.0.0':1200,'wB.0.1':1300,'wC.0.0':2000,'wL.0.2':2100,'gone.0.0':3000};
  const h=core.pathHistory(claimed,segIndex,counts,lens);
  assert.equal(h.paths.wA.visited,true); assert.equal(h.paths.wA.visitedAt,1500);  // 40 m reached this week
  assert.equal(h.paths.wL.visited,false);   // brushed one 20 m section of a 100 m path: not a visit
  assert.equal(h.paths.wC.visited,true);    // short 12 m crosswalk: walking it counts
  assert.equal(core.activitySince(h,[],1000).newPaths,3);   // A, B, C
  assert.equal(core.activitySince(h,[],1550).newPaths,1);   // only C after t=1550
  assert.equal(h.paths.gone,undefined);     // sections missing from current walkway data are ignored
});

test('a path is complete only when every section is walked, credited the week it finishes',()=>{
  const h=core.pathHistory({'wB.0.0':500,'wB.0.1':1500,'wC.0.0':900},segIndex,counts,lens);
  assert.equal(h.paths.wB.complete,true); assert.equal(h.paths.wC.complete,true);
  const a=core.activitySince(h,[],1000);
  assert.equal(a.completed,1);          // B finished this week; C finished last week
});

test('new zones exclude skipped zones and only count first-ever visits',()=>{
  const h=core.pathHistory({'wA.0.0':500,'wA.0.1':600,'wB.0.0':1500,'wB.0.1':1550,'wC.0.0':1600,'wL.0.0':1700},segIndex,counts,lens);
  assert.deepEqual(core.activitySince(h,[],1000,{skipZones:['campus']}).newZones,['farrand']);
});

test('walks goal counts recorded walks of at least 0.1 mi this week',()=>{
  const S=[{at:new Date(1500).toISOString(),meters:200},{at:new Date(1600).toISOString(),meters:100},{at:new Date(10).toISOString(),meters:900}];
  const a=core.activitySince({paths:{},zones:{}},S,1000);
  assert.equal(a.walks,1); assert.equal(a.walkMeters,200);
});

test('goal rows honor targets, caps and turned-off goals; zone goal hides when nothing is left',()=>{
  const act={newPaths:12,completed:0,newZones:[],walks:1,walkMeters:0};
  const rows=core.goalRows({walks:{on:false}},act,0);
  assert.deepEqual(rows.map(r=>r.id),['paths']);
  assert.equal(rows[0].value,10); assert.equal(rows[0].raw,12); assert.equal(rows[0].done,true);
});

test('walk summary clamps negatives and never stores raw GPS points',()=>{
  const s=core.session(Date.UTC(2026,10,11),Date.UTC(2026,10,11)+65000,125,7);
  assert.equal(s.seconds,65);assert.equal(s.meters,125);assert.equal(s.newSegments,7);
  assert.deepEqual(Object.keys(s),['at','seconds','meters','newSegments']);
  assert.equal(core.session(1000,0,-1,-2).meters,0);
  const x=core.session(0,600000,800,4,{moving:420.4,newPaths:2,completedPaths:-1,shape:[[1,2]]});
  assert.equal(x.moving,420); assert.equal(x.completedPaths,0); assert.equal(x.shape,null);
});

test('route preview hides both ends and refuses walks too short to hide them',()=>{
  const line=[]; for(let i=0;i<=60;i++) line.push([40,-105.27+i*0.0001]);  // ~510 m east-west
  const r=core.trimRoute(line);
  assert.ok(r && r.length>2);
  assert.ok(r[0][1] > line[0][1]+0.0015, 'start trimmed by ~150 m');
  assert.ok(r[r.length-1][1] < line[line.length-1][1]-0.0015, 'end trimmed by ~150 m');
  assert.equal(core.trimRoute(line.slice(0,30)), null);               // ~250 m: too short
  assert.equal(core.trimRoute([[40,-105]]), null);
});

test('share card lines contain stats only',()=>{
  const lines=core.shareLines({meters:1609.344,seconds:1800,newPaths:2,completedPaths:0});
  assert.deepEqual(lines.map(l=>l.k),['Distance','Elapsed time','New paths']);
  assert.equal(lines[0].v,'1.00 mi'); assert.equal(lines[1].v,'30 min');
});

test('advocacy draft preserves observations and clearly states it is unsubmitted',()=>{
  const s=core.draft({category:'Lighting',location:' East of library ',observation:'One light out.',request:'Inspect and provide timeline.',date:'11/11/2026'});
  assert.match(s,/Location: East of library\n/);assert.match(s,/One light out/);
  assert.match(s,/reference number/);assert.match(s,/has not been submitted/);
  assert.doesNotMatch(s,/officially verified|has been submitted successfully/);
});

test('follow-up status is always self-reported and never implies a repair on its own',()=>{
  assert.equal(core.requestStatus({}).label,'Draft — not submitted');
  const sub=core.requestStatus({submitted:{to:'CU Facilities',date:'2026-11-12'}});
  assert.equal(sub.kind,'submitted'); assert.equal(sub.selfReported,true);
  const up=core.requestStatus({submitted:{to:'X',date:'d'},updates:[{status:'Acknowledged',source:'Email from Facilities',date:'2026-11-14'}]});
  assert.equal(up.label,'Acknowledged'); assert.equal(up.source,'Email from Facilities'); assert.equal(up.selfReported,true);
});
