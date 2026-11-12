const {test}=require('node:test');
const assert=require('node:assert/strict');
const core=require('../student-core');
test('weekly goal allows only supported finite choices',()=>{
  for(const value of [null,undefined,-5,Infinity,'garbage',51])assert.equal(core.goal(value),50);
  assert.equal(core.goal('100'),100);
});
test('walk summary uses supplied session deltas, clamps negatives and omits GPS',()=>{
  const s=core.session(Date.UTC(2026,10,11),Date.UTC(2026,10,11)+65000,125,7);
  assert.equal(s.seconds,65);assert.equal(s.meters,125);assert.equal(s.newSegments,7);
  assert.deepEqual(Object.keys(s),['at','seconds','meters','newSegments']);
  assert.equal(core.session(1000,0,-1,-2).meters,0);
});
test('advocacy draft preserves observations and clearly states it is unsubmitted',()=>{
  const s=core.draft({category:'Lighting',location:' East of library ',observation:'One light out.',request:'Inspect and provide timeline.',date:'11/11/2026'});
  assert.match(s,/Location: East of library\n/);assert.match(s,/One light out/);
  assert.match(s,/reference number/);assert.match(s,/has not been submitted/);
  assert.doesNotMatch(s,/officially verified|has been submitted successfully/);
});
