/* BuffPrints — launch splash and welcome screen.
   Loaded at the top of <body> so it can show before the map starts.
     * Returning users (localStorage buffprints_onboarded_v1 === 'true'): a 1.1 s overlay that
       never blocks taps (pointer-events: none) and removes itself.
     * First-time users, or the "?" button in the header: the full welcome screen.
       "Start Exploring" saves buffprints_onboarded_v1 = 'true'.
   No network calls, nothing sent anywhere. */
(function(){
'use strict';
var KEY='buffprints_onboarded_v1', LOGO='public/hoofprint-logo.svg';
function seen(){ try{ return localStorage.getItem(KEY)==='true'; }catch(e){ return false; } }
function remember(){ try{ localStorage.setItem(KEY,'true'); }catch(e){} }
function standalone(){ try{ return window.matchMedia('(display-mode: standalone)').matches||window.navigator.standalone===true; }catch(e){ return false; } }
function reduced(){ try{ return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }catch(e){ return false; } }
var ico=function(d){ return '<svg class="bp-ico" viewBox="0 0 24 24" aria-hidden="true">'+d+'</svg>'; };
var I={
  cal:ico('<rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>'),
  hunt:ico('<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.4-4.4M11 8v6M8 11h6"/>'),
  meet:ico('<circle cx="8.5" cy="9" r="3"/><circle cx="16.5" cy="10" r="2.5"/><path d="M3 19c.6-3 2.8-4.6 5.5-4.6S13.4 16 14 19M14.5 15.2c.7-.5 1.3-.7 2-.7 2.2 0 3.7 1.4 4.3 4.5"/>'),
  safe:ico('<path d="M12 3.5 4 18.5h16Z"/><path d="M12 9.5v4.2M12 16.3v.2"/>'),
  comm:ico('<path d="M4 5.5h16v10H9.5L5 19.5v-4H4Z"/><path d="M8 10h8"/>'),
  shield:ico('<path d="M12 3 5 6v5.5c0 4.2 2.9 7.8 7 9.5 4.1-1.7 7-5.3 7-9.5V6Z"/><path d="m9 12 2.2 2.2L15.5 10"/>'),
  x:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>'
};
var FEATURES=[
  [I.cal,'Class Schedule','Import your Buff Portal calendar for daily class walks and scenic detours down new paths.'],
  [I.hunt,'Herd and Seek','A 5-checkpoint outdoor scavenger hunt with puzzles. Play solo or in teams.'],
  [I.meet,'Meet-Ups','Share free times with friends and plan when and where to meet.'],
  [I.safe,'Campus Safety','Pin hazards like ice or broken lights, and draft requests to get them fixed.'],
  [I.comm,'Community','Pick a moderated nickname, name paths you’ve walked, and climb weekly leaderboards.']
];

function boot(){
  var el=document.createElement('div'); el.className='bp-boot'; el.setAttribute('aria-hidden','true');
  el.innerHTML='<div class="in"><img src="'+LOGO+'" alt=""><b>BuffPrints</b><span>Explore campus. Leave your mark.</span></div>';
  document.body.appendChild(el);
  if(reduced()) setTimeout(function(){ el.style.opacity='0'; },850);
  setTimeout(function(){ el.remove(); },1100);
}

var open=null, returnTo=null;
function close(){
  if(!open) return; var el=open; open=null; remember();
  document.removeEventListener('keydown',onKey,true);
  if(reduced()) el.remove(); else { el.classList.add('out'); setTimeout(function(){ el.remove(); },200); }
  document.documentElement.style.overflow='';
  var t=returnTo; returnTo=null; if(t&&document.contains(t)) t.focus();
}
function onKey(e){
  if(!open) return;
  if(e.key==='Escape'){ e.preventDefault(); close(); return; }
  if(e.key==='Tab'){   // keep focus inside the dialog
    var f=open.querySelectorAll('button,a[href]'), first=f[0], last=f[f.length-1];
    if(!open.contains(document.activeElement)){ e.preventDefault(); (e.shiftKey?last:first).focus(); }
    else if(e.shiftKey&&document.activeElement===first){ e.preventDefault(); last.focus(); }
    else if(!e.shiftKey&&document.activeElement===last){ e.preventDefault(); first.focus(); }
  }
}
function welcome(){
  if(open) return;
  returnTo=document.activeElement;
  var el=document.createElement('div'); el.className='bp-welcome';
  el.setAttribute('role','dialog'); el.tabIndex=-1; el.setAttribute('aria-modal','true'); el.setAttribute('aria-labelledby','bpTitle');
  el.innerHTML=
    '<button class="x" type="button" data-bp="close" aria-label="Close">'+I.x+'</button>'+
    '<div class="scroll"><div class="wrap">'+
      '<header class="bp-hero"><img src="'+LOGO+'" alt="" width="64" height="64"><h1 id="bpTitle">BuffPrints</h1>'+
        '<p class="tag">Explore campus. Leave your mark.</p><p class="sub">A free walking game for the CU Boulder campus.</p></header>'+
      '<section class="bp-card" aria-labelledby="bpHow"><h2 id="bpHow">How it works</h2>'+
        '<p>Tap <b>Record</b> and walk. Clear the fog off the campus satellite map as you cover paths, earn badges, keep streaks, and score weekly zone points for your dorm or team.</p></section>'+
      '<h2 class="bp-label" id="bpMore">Beyond walking</h2>'+
      '<ul class="bp-grid" aria-labelledby="bpMore">'+FEATURES.map(function(f){ return '<li><b>'+f[0]+f[1]+'</b>'+f[2]+'</li>'; }).join('')+'</ul>'+
      '<div class="bp-privacy">'+I.shield+'<div><b>Privacy built in.</b> Your GPS track and exact location stay on your phone. Signing in is optional; it saves your progress (which paths you’ve covered, totals and badges), never your GPS route. <a href="#" data-bp="privacy">Your data &amp; privacy</a></div></div>'+
      (standalone()?'':'<p class="bp-install"><b>Tip:</b> Add BuffPrints to your phone’s Home Screen for the full app experience.</p>')+
    '</div></div>'+
    '<div class="bp-foot"><div class="wrap"><button class="bp-cta" type="button" data-bp="start">Start Exploring</button>'+
      '<small>Independent student/community project — not an official CU Boulder app.</small></div></div>';
  el.addEventListener('click',function(e){
    var b=e.target.closest('[data-bp]'); if(!b) return; e.preventDefault();
    if(b.dataset.bp==='privacy'){ close(); if(typeof window.openPrivacy==='function') setTimeout(window.openPrivacy,220); }
    else close();
  });
  document.body.appendChild(el); open=el;
  document.documentElement.style.overflow='hidden';
  document.addEventListener('keydown',onKey,true);
  el.focus({preventScroll:true});   // the dialog itself, so screen readers start at the top and no ring is drawn
}

window.BuffSplash={open:welcome, close:close, isOnboarded:seen};
document.addEventListener('click',function(e){ if(e.target.closest&&e.target.closest('#bpInfo')) welcome(); });
if(seen()) boot(); else welcome();
})();
