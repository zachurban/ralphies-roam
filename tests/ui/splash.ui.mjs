// Launch splash and welcome screen (splash.js) on phone, small-phone and desktop screens.
//   CHROME=… PLAYWRIGHT=… LEAFLET_DIR=path/to/leaflet/dist node tests/ui/splash.ui.mjs
// Screenshots: docs/screenshots/splash-*.png
import {createRequire} from 'node:module'; import fs from 'node:fs'; import path from 'node:path'; import assert from 'node:assert/strict';
const require=createRequire(import.meta.url); const {chromium}=require(process.env.PLAYWRIGHT||'playwright');
import {startHarness, ROOT} from './herd-harness.mjs';
const SHOT=n=>path.join(ROOT,'docs','screenshots',n);
const h=await startHarness({db:'rr_splash'}); const b=await chromium.launch({executablePath:process.env.CHROME||undefined,args:['--no-sandbox']});
const LD=(process.env.LEAFLET_DIR||'node_modules/leaflet/dist')+'/'; let n=0; const ok=(c,m)=>{ assert.ok(c,m); n++; console.log('  ✓ '+m); };
async function ctx(o={}){ const c=await b.newContext({viewport:o.vp||{width:390,height:844},deviceScaleFactor:2,reducedMotion:o.rm||'no-preference'});
  await c.route(/unpkg\.com\/leaflet/,r=>{ const js=r.request().url().endsWith('.js'); r.fulfill({contentType:js?'text/javascript':'text/css',body:fs.readFileSync(LD+(js?'leaflet.js':'leaflet.css'))}); });
  await c.route(/jsdelivr/,r=>r.fulfill({contentType:'text/javascript',body:''})); await c.route(u=>!u.href.startsWith(h.base)&&!/unpkg|jsdelivr/.test(u.href),r=>r.abort());
  const p=await c.newPage(); p.errs=[]; p.on('pageerror',e=>p.errs.push(e.message)); return {c,p}; }
{ const {c,p}=await ctx();
  await p.goto(h.base+'/index.html'); await p.waitForSelector('.bp-welcome .bp-cta');
  ok(await p.locator('.bp-boot').count()===0,'first visit: full welcome screen, no boot overlay');
  const t=await p.textContent('.bp-welcome');
  for(const s of ['Explore campus. Leave your mark.','A free walking game for the CU Boulder campus.','Tap Record and walk','Class Schedule','Herd and Seek','Meet-Ups','Campus Safety','Community','Privacy built in','Add BuffPrints to your phone’s Home Screen','Start Exploring','not an official CU Boulder app']) ok(t.includes(s),'shows: '+s);
  ok(await p.evaluate(()=>document.activeElement.classList.contains('bp-welcome')),'focus starts on the welcome screen itself');
  ok(await p.evaluate(()=>{ const r=document.querySelector('.bp-foot').getBoundingClientRect(); return r.bottom<=innerHeight+1; }),'button is pinned at the bottom of the screen');
  await p.waitForFunction(()=>document.querySelector('.bp-hero img').complete);
  const logo=await p.evaluate(()=>{ const i=document.querySelector('.bp-hero img'); return {w:i.width,h:i.height,nw:i.naturalWidth,c:i.complete}; }); console.log(logo);
  ok(logo.c&&logo.w===64&&await p.evaluate(async()=>(await fetch(document.querySelector('.bp-hero img').src)).status===200),'logo loads at 64 px');
  await p.waitForTimeout(600); await p.screenshot({path:SHOT('splash-welcome-390.png')});
    await p.click('.bp-cta'); await p.waitForSelector('.bp-welcome',{state:'detached'});
  ok(await p.evaluate(()=>localStorage.getItem('buffprints_onboarded_v1'))==='true','Start Exploring saves buffprints_onboarded_v1 = true');
  ok(await p.evaluate(()=>getComputedStyle(document.documentElement).overflow!=='hidden'),'page scrolls again after closing');
  // returning
  await p.reload(); await p.waitForSelector('.bp-boot',{state:'attached'}); await p.waitForTimeout(250); await p.screenshot({path:SHOT('splash-boot.png')});
  ok(await p.evaluate(()=>getComputedStyle(document.querySelector('.bp-boot')).pointerEvents==='none'),'returning visit: boot overlay, taps pass through');
  ok(await p.locator('.bp-welcome').count()===0,'returning visit: no welcome screen');
  await p.click('[data-go=progress]',{force:true}); ok(await p.evaluate(()=>document.body.dataset.view==='progress'),'app is usable while the overlay is still showing');
  await p.waitForTimeout(1000); ok(await p.locator('.bp-boot').count()===0,'overlay removes itself after 1.1 s');
  // re-entry
  await p.click('#bpInfo'); await p.waitForSelector('.bp-welcome .bp-cta'); ok(true,'"?" in the header reopens it');
  await p.keyboard.press('Tab'); await p.keyboard.press('Tab'); await p.keyboard.press('Tab'); await p.keyboard.press('Tab');
  ok(await p.evaluate(()=>!!document.activeElement.closest('.bp-welcome')),'Tab stays inside the dialog');
  await p.keyboard.press('Escape'); await p.waitForSelector('.bp-welcome',{state:'detached'});
  ok(await p.evaluate(()=>document.activeElement&&document.activeElement.id==='bpInfo'),'Escape closes it and focus returns to the "?" button');
  await p.click('#bpInfo'); await p.click('[data-bp=privacy]'); await p.waitForSelector('#modal.show');
  ok((await p.textContent('#mTitle')).includes('privacy'),'privacy link opens the full privacy notice');
  ok(p.errs.length===0,'no page errors: '+p.errs.join('; '));
  await c.close(); }
for(const [name,vp] of [['360',{width:360,height:640}],['desktop',{width:1280,height:800}]]){
  const {c,p}=await ctx({vp}); await p.goto(h.base+'/index.html'); await p.waitForSelector('.bp-cta'); await p.waitForTimeout(600);
  await p.screenshot({path:SHOT('splash-welcome-'+name+'.png')});
  if(name==='360') ok(await p.evaluate(()=>{ const s=document.querySelector('.bp-welcome .scroll'); return s.scrollHeight>s.clientHeight && document.querySelector('.bp-cta').getBoundingClientRect().bottom<=innerHeight; }),'small phone (360×640): content scrolls inside, button stays visible');
  await c.close(); }
{ const {c,p}=await ctx({rm:'reduce'}); await p.goto(h.base+'/index.html'); await p.waitForSelector('.bp-cta');
  ok(await p.evaluate(()=>getComputedStyle(document.querySelector('.bp-hero img')).animationName==='none'),'reduced motion: no stamp animation'); await c.close(); }
{ const {c,p}=await ctx(); await c.addInitScript(()=>{ const mm=window.matchMedia; window.matchMedia=q=>q.includes('standalone')?{matches:true,addEventListener(){},removeEventListener(){}}:mm.call(window,q); });
  await p.goto(h.base+'/index.html'); await p.waitForSelector('.bp-cta'); ok(await p.locator('.bp-install').count()===0,'installed app: no Home Screen tip'); await c.close(); }
console.log(n+' checks passed'); await b.close(); await h.close();
