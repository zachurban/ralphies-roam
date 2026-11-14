const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const path=require('path');
const R=f=>fs.readFileSync(path.join(__dirname,'..',f),'utf8');

test('privacy.html is in step with PRIVACY.md (Play Store privacy policy URL)',()=>{
  const md=R('PRIVACY.md'), html=R('privacy.html');
  const updated=md.match(/Last updated ([^.]+)\./)[1];
  assert.ok(html.includes('Last updated '+updated),'regenerate privacy.html from PRIVACY.md');
  for(const h of md.match(/^## .+$/gm)) assert.ok(html.includes(h.slice(3).replace(/&/g,'&amp;')),'missing section '+h);
});

test('account deletion page explains in-app and web deletion (Play Store requirement)',()=>{
  const html=R('delete-account.html');
  for(const s of ['BuffPrints','Delete everything','Without the app','What is deleted']) assert.ok(html.includes(s),s);
});

test('Android app and asset links agree on the package',()=>{
  const twa=JSON.parse(R('android/twa-manifest.json')), al=JSON.parse(R('.well-known/assetlinks.json'));
  assert.equal(al[0].target.package_name,twa.packageId);
  assert.ok(al[0].target.sha256_cert_fingerprints.every(f=>/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(f)));
});
