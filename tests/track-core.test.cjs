const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const path=require('path');
const T=require('../track-core');

test('smoother pulls a jumpy fix toward the recent track',()=>{
  const f=T.smoother();
  f.update(40,-105,5,0);
  const a=f.update(40.0001,-105,5,1000);      // ~11 m jump in 1 s at ±5 m
  assert.ok(a.lat>40&&a.lat<40.0001,'blended, not taken raw');
  const g=T.smoother(); g.update(40,-105,5,0);
  const b=g.update(40.0001,-105,30,1000);     // same jump with poor accuracy moves much less
  assert.ok(b.lat-40<a.lat-40);
  f.reset(); assert.deepEqual(f.update(41,-104,8,5000),{lat:41,lng:-104,acc:8});
});

test('angles ignore line direction',()=>{
  assert.equal(T.angleDiff(10,190),0);
  assert.equal(T.angleDiff(0,90),90);
  assert.equal(T.angleDiff(350,20),30);
});

test('a perpendicular side path is not matched when walking past it',()=>{
  const c=[{id:'main',d:1,brg:0,stretch:'A'},{id:'side',d:0.5,brg:90,stretch:'B'}];
  assert.deepEqual(T.pick(c,180,null),['main']);
});

test('only the nearest of two parallel lines counts, with a head start for the one you were on',()=>{
  const c=[{id:'walk',d:3,brg:0,stretch:'W'},{id:'side',d:9,brg:5,stretch:'S'}];
  assert.deepEqual(T.pick(c,0,null),['walk']);
  const close=[{id:'walk',d:6,brg:0,stretch:'W'},{id:'side',d:4,brg:0,stretch:'S'}];
  assert.deepEqual(T.pick(close,0,'W'),['walk'],'stays on the walkway through a 2 m wobble');
  const dup=[{id:'a',d:2,brg:0,stretch:'X'},{id:'b',d:3.5,brg:180,stretch:'Y'}];
  assert.deepEqual(T.pick(dup,0,null).sort(),['a','b'],'doubled lines both count');
});

test('no heading (standing still) matches nothing',()=>{
  assert.deepEqual(T.pick([{id:'a',d:1,brg:0,stretch:'A'}],null,null),[]);
});

// Path P: A—B—C—D, with path Q joining at B. Each edge 50 m, diced into 20 m-ish pieces.
function fixture(){
  const pts=[[0,0],[0.00045,0],[0.0009,0],[0.00135,0]];
  const paths=[{id:'P',pts},{id:'Q',pts:[[0.00045,0],[0.00045,0.0006]]}];
  const pieces=[];
  for(let vi=0;vi<3;vi++) for(let j=0;j<3;j++) pieces.push({id:'P.'+vi+'.'+j,pid:'P',vi,len:50/3});
  pieces.push({id:'Q.0.0',pid:'Q',vi:0,len:25},{id:'Q.0.1',pid:'Q',vi:0,len:25});
  return {paths,pieces};
}

test('stretches break at junctions and keep runs whole',()=>{
  const {paths,pieces}=fixture();
  const st=T.stretches(paths,pieces);
  assert.equal(st.of['P.0.0'],st.of['P.0.2'],'A–B is one stretch');
  assert.notEqual(st.of['P.0.2'],st.of['P.1.0'],'breaks where Q joins at B');
  assert.equal(st.of['P.1.0'],st.of['P.2.2'],'B–D has no junction, so it stays whole (100 m < max)');
  assert.equal(st.of['Q.0.0'],st.of['Q.0.1']);
  const lens=Object.fromEntries(pieces.map(p=>[p.id,p.len]));
  const bd=st.list[st.of['P.1.0']];
  assert.equal(T.ready(bd,{'P.1.0':1,'P.1.1':1},lens),false,'a third is not enough');
  assert.equal(T.ready(bd,{'P.1.0':1,'P.1.1':1,'P.1.2':1,'P.2.0':1},lens),true,'two thirds claims the stretch');
});

test('long runs split and tiny leftovers merge',()=>{
  const paths=[{id:'L',pts:[[0,0],[0.003,0]]}];
  const pieces=[]; for(let j=0;j<17;j++) pieces.push({id:'L.0.'+j,pid:'L',vi:0,len:19.6});
  const st=T.stretches(paths,pieces);
  const ids=Object.keys(st.list);
  assert.equal(ids.length,3,'~333 m → three stretches');
  ids.forEach(id=>assert.ok(st.list[id].len>=T.STRETCH_MIN_M&&st.list[id].len<=160));
});

test('real campus map: every piece belongs to a stretch of reasonable length',()=>{
  const g=JSON.parse(fs.readFileSync(path.join(__dirname,'..','paths.geojson'),'utf8'));
  const paths=g.features.map(f=>({id:f.properties.id,pts:f.geometry.coordinates.map(c=>[c[1],c[0]])}));
  const KX=Math.cos(40.0073*Math.PI/180)*111320, KY=110574;
  const pieces=[];
  paths.forEach(p=>{ for(let i=0;i<p.pts.length-1;i++){
    const A=p.pts[i],B=p.pts[i+1], d=Math.hypot((A[1]-B[1])*KX,(A[0]-B[0])*KY), n=Math.max(1,Math.ceil(d/20));
    for(let j=0;j<n;j++) pieces.push({id:p.id+'.'+i+'.'+j,pid:p.id,vi:i,len:d/n}); } });
  const st=T.stretches(paths,pieces), list=Object.values(st.list);
  pieces.forEach(s=>assert.ok(st.of[s.id],'piece '+s.id+' has a stretch'));
  const lens=list.map(x=>x.len).sort((a,b)=>a-b), med=lens[Math.floor(lens.length/2)];
  console.log('pieces',pieces.length,'stretches',list.length,'median m',med.toFixed(0),'max m',lens[lens.length-1].toFixed(0));
  assert.ok(list.length<pieces.length*0.75,'stretches are longer than the old 20 m pieces');
  assert.ok(lens[lens.length-1]<200,'nothing absurdly long');
});
