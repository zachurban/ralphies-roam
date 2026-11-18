// The roam-first app shell (index.html) on a phone-sized and a desktop screen: four tabs, the
// featured roam on the home screen, walking on Map, and the roam game opening over the app.
//   CHROME=… PLAYWRIGHT=… LEAFLET_DIR=path/to/leaflet/dist node tests/ui/shell.ui.mjs
// Screenshots: docs/screenshots/shell-*.png
import {createRequire} from 'node:module'; import fs from 'node:fs'; import path from 'node:path'; import assert from 'node:assert/strict';
const require=createRequire(import.meta.url); const {chromium}=require(process.env.PLAYWRIGHT||'playwright');
import {startHarness, ROOT} from './herd-harness.mjs';
const SHOT=n=>path.join(ROOT,'docs','screenshots',n);
const h=await startHarness({db:'rr_shell'}); const b=await chromium.launch({executablePath:process.env.CHROME||undefined,args:['--no-sandbox']});
const LD=(process.env.LEAFLET_DIR||'node_modules/leaflet/dist')+'/'; let n=0; const ok=(c,m)=>{ assert.ok(c,m); n++; console.log('  ✓ '+m); };
async function ctx(vp){ const c=await b.newContext({viewport:vp||{width:390,height:844},deviceScaleFactor:2,serviceWorkers:'block'}); await h.wire(c);
  await c.route(/unpkg\.com\/leaflet/,r=>{ const js=r.request().url().endsWith('.js'); r.fulfill({contentType:js?'text/javascript':'text/css',body:fs.readFileSync(LD+(js?'leaflet.js':'leaflet.css'))}); });
  await c.addInitScript(()=>localStorage.setItem('buffprints_onboarded_v1','true'));
  const p=await c.newPage(); p.errs=[]; p.on('pageerror',e=>p.errs.push(e.message)); return {c,p}; }
const view=p=>p.evaluate(()=>document.body.dataset.view);
{ const {c,p}=await ctx(); await p.goto(h.base+'/index.html'); await p.waitForSelector('.rgo'); await p.waitForTimeout(1500);
  ok((await p.$$eval('nav.tabs button',els=>els.map(e=>e.textContent.trim()))).join('·').startsWith('Roam·Map'),'tabs start with Roam · Map');
  ok(await view(p)==='home','the app opens on Roam');
  ok((await p.textContent('.rtitle')).trim().length>2&&(await p.textContent('.rgo')).trim()==='Start roam','home shows the featured roam and one Start roam button');
  ok(await p.locator('.rpin').count()===5,'the roam’s five stops are pinned on the map');
  ok(!(await p.locator('#recIdle').isVisible()),'no Record button on the Roam tab');
  await p.screenshot({path:SHOT('shell-01-roam.png')});
  await p.click('nav.tabs [data-go=explore]'); await p.waitForTimeout(500);
  ok(await p.locator('#recIdle').isVisible(),'Record lives on the Map tab');
  ok(await p.locator('.rpin').count()===0,'the roam’s stops are not shown on the Map tab'); await p.screenshot({path:SHOT('shell-02-map.png')});
  await p.click('nav.tabs [data-go=community]'); await p.waitForTimeout(900);
  const herd=await p.textContent('#v-community'); ok(herd.includes('No herd yet')&&herd.includes('Herds')&&herd.includes('Dorms')&&herd.includes('Walking this week'),'Herd: herd card, roam standings, walking below');
  await p.screenshot({path:SHOT('shell-03-herd.png')});
  await p.click('nav.tabs [data-go=progress]'); await p.waitForTimeout(400);
  ok(await p.locator('.yring').count()===3,'You: three rings (campus, streak, roams)');
  for(const s of ['Class schedule','Safety & hazards','Privacy & data']) ok((await p.textContent('#v-progress')).includes(s),'You links to: '+s);
  await p.screenshot({path:SHOT('shell-04-you.png')});
  await p.click('[data-go=safety]'); await p.waitForTimeout(300);
  ok(await view(p)==='safety'&&await p.evaluate(()=>document.querySelector('nav.tabs [data-go=progress]').classList.contains('act')||document.querySelector('nav.tabs [data-go=progress]').getAttribute('aria-current')==='page'),'Safety opens under the You tab');
  for(const t of ['home','explore','community','progress']){ await p.click('nav.tabs [data-go='+t+']'); await p.waitForTimeout(250);
    ok(!/Herd and Seek|scavenger hunt|\bhunt\b/i.test(await p.evaluate(()=>document.querySelector('.view.act,main .act,#v-'+document.body.dataset.view).innerText)),'no “hunt” wording on '+t); }
  await p.click('nav.tabs [data-go=home]'); await p.waitForTimeout(200); ok(await p.locator('.rpin').count()===5,'back on Roam, the stops are shown again');
  await p.click('.rgo'); const f=p.frameLocator('#herdSheet iframe'); await f.locator('[data-act=mode]').first().waitFor();
  ok((await f.locator('h1.title').textContent()).trim()===(await p.textContent('.rtitle')).trim(),'Start roam opens that roam over the app');
  await p.screenshot({path:SHOT('shell-05-start.png')});
  ok(p.errs.length===0,'no page errors: '+p.errs.join(' | ')); await c.close(); }
{ const {c,p}=await ctx({width:1280,height:800}); await p.goto(h.base+'/index.html'); await p.waitForSelector('.rgo'); await p.waitForTimeout(1500);
  ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'desktop: no horizontal overflow'); await p.screenshot({path:SHOT('shell-06-desktop.png')}); await c.close(); }
await b.close(); await h.close(); console.log('\n'+n+' checks passed');
