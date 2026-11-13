// Test harness for the Herd and Seek screens: a throwaway PostgreSQL database with the real
// migrations, a static file server for the app, and a small stand-in for the three pieces of
// Supabase the page uses:
//   * rpc()            → runs the real database function as that signed-in user (or anon)
//   * auth (email code)→ any address, code 123456
//   * Realtime Broadcast → relayed through this process, which RECORDS every frame, so the
//                          tests can prove the relay only ever carried ciphertext
// No real Supabase project, email or student data is involved.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const lit = v => v === null || v === undefined ? 'null' : typeof v === 'number' || typeof v === 'boolean' ? String(v)
  : typeof v === 'object' ? "'" + JSON.stringify(v).replace(/'/g, "''") + "'::jsonb" : "'" + String(v).replace(/'/g, "''") + "'";

export function startHarness({db = process.env.RR_UI_DB || 'rr_herd_ui', port = 0} = {}) {
  const psql = (sqlText, d = db) => {
    const r = spawnSync('psql', ['-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-d', d], {input: sqlText, encoding: 'utf8'});
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout.trim();
  };
  const q = text => JSON.parse(psql(`with t as (${text}) select coalesce(json_agg(t), '[]') from t;`));
  const asUser = (user, text) => {
    const pre = user ? `set role authenticated; set request.jwt.claim.sub = ${lit(user.id)}; set request.jwt.claims = ${lit(JSON.stringify({sub: user.id, email: user.email}))};`
                     : `set role anon; set request.jwt.claims = '{"role":"anon"}';`;
    const r = spawnSync('psql', ['-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-d', db], {encoding: 'utf8', input: `${pre}\nwith t as (${text}) select coalesce(json_agg(t), '[]') from t;`});
    if (r.status !== 0) return {error: {message: r.stderr.replace(/^psql:[^:]*:\d+: /gm, '').trim()}};
    return {data: JSON.parse(r.stdout.trim())};
  };

  // ---- database ----
  psql(`drop database if exists ${db}`, 'postgres'); psql(`create database ${db}`, 'postgres');
  const apply = f => { const r = spawnSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '--single-transaction', '-d', db, '-f', f], {encoding: 'utf8'}); if (r.status) throw new Error(f + ': ' + r.stderr); };
  apply(path.join(ROOT, 'tests', 'supabase-shim.sql'));
  fs.readdirSync(path.join(ROOT, 'supabase', 'migrations')).sort().forEach(f => apply(path.join(ROOT, 'supabase', 'migrations', f)));
  const user = (email, dorm) => {
    const found = q(`select id from auth.users where email = ${lit(email)}`)[0];
    const id = found ? found.id : q(`insert into auth.users (email) values (${lit(email)}) returning id`)[0].id;
    if (dorm) psql(`update public.profiles set dorm = ${lit(dorm)} where id = ${lit(id)}`);
    return {id, email};
  };

  // ---- what the stand-in saw ----
  const log = {rpc: [], frames: [], requests: []};
  const subs = new Map();   // channel -> Set of {id, res}

  const fakeSupabase = `
window.supabase={createClient(){
  const listeners=[], cur=()=>{ try{ return JSON.parse(localStorage.getItem('test-auth')||'null'); }catch(e){ return null; } };
  const sess=()=>{ const u=cur(); return u?{user:{id:u.id,email:u.email}}:null; };
  const post=(url,body)=>fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then(r=>r.json());
  return {
    auth:{
      getSession:async()=>({data:{session:sess()}}),
      onAuthStateChange(cb){ listeners.push(cb); return {data:{subscription:{unsubscribe(){}}}}; },
      signInWithOtp:async()=>({error:null}),
      verifyOtp:async({email,token})=>{ const r=await post('/__auth',{email,token}); if(r.error) return {error:r.error}; localStorage.setItem('test-auth',JSON.stringify(r.user)); listeners.forEach(cb=>cb('SIGNED_IN',sess())); return {error:null}; },
      signOut:async()=>{ localStorage.removeItem('test-auth'); listeners.forEach(cb=>cb('SIGNED_OUT',null)); return {error:null}; }
    },
    rpc:(fn,args)=>post('/__rpc',{fn,args:args||{},user:cur()}),
    channel(name){
      const id=Math.random().toString(36).slice(2), hs=[]; let es=null;
      const ch={ on(type,filter,cb){ hs.push({event:filter.event,cb}); return ch; },
        subscribe(cb){ es=new EventSource('/__relay/sub?ch='+encodeURIComponent(name)+'&id='+id); es.onopen=()=>cb&&cb('SUBSCRIBED');
          es.onmessage=e=>{ const m=JSON.parse(e.data); hs.filter(h=>h.event===m.event).forEach(h=>h.cb({event:m.event,payload:m.payload})); };
          es.onerror=()=>cb&&cb('CHANNEL_ERROR'); return ch; },
        send(msg){ return post('/__relay/pub',{ch:name,id,event:msg.event,payload:msg.payload}).then(()=>'ok'); },
        _close(){ if(es) es.close(); } };
      return ch;
    },
    removeChannel(ch){ ch._close(); }
  };
}};`;

  const types = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.geojson': 'application/json',
                 '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json'};
  const body = req => new Promise(res => { let b = ''; req.on('data', d => b += d); req.on('end', () => res(b)); });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const json = (o, code = 200) => { res.writeHead(code, {'content-type': 'application/json'}); res.end(JSON.stringify(o)); };
    if (url.pathname === '/__supabase.js') { res.writeHead(200, {'content-type': 'text/javascript'}); return res.end(fakeSupabase); }
    if (url.pathname === '/__rpc') {
      const raw = await body(req), {fn, args, user: u} = JSON.parse(raw);
      log.rpc.push({fn, args, user: u ? u.id : null}); log.requests.push({url: req.url, body: raw});
      if (!/^[a-z_]+$/.test(fn)) return json({error: {message: 'bad function'}});
      const named = Object.entries(args).map(([k, v]) => `${k.replace(/[^a-z_]/g, '')} => ${lit(v)}`).join(', ');
      const r = asUser(u, `select public.${fn}(${named}) as r`);
      return json(r.error ? {data: null, error: r.error} : {data: r.data[0].r, error: null});
    }
    if (url.pathname === '/__auth') {
      const {email, token} = JSON.parse(await body(req));
      if (token !== '123456') return json({error: {message: 'Token has expired or is invalid'}});
      return json({user: user(email)});
    }
    if (url.pathname === '/__relay/sub') {
      const ch = url.searchParams.get('ch'), id = url.searchParams.get('id');
      res.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive'}); res.write(':ok\n\n');
      const me = {id, res}; if (!subs.has(ch)) subs.set(ch, new Set()); subs.get(ch).add(me);
      req.on('close', () => subs.get(ch).delete(me));
      return;
    }
    if (url.pathname === '/__relay/pub') {
      const raw = await body(req), m = JSON.parse(raw);
      log.frames.push({channel: m.ch, event: m.event, payload: m.payload}); log.requests.push({url: req.url, body: raw});
      for (const s of subs.get(m.ch) || []) if (s.id !== m.id) s.res.write('data: ' + JSON.stringify({event: m.event, payload: m.payload}) + '\n\n');
      return json({ok: true});
    }
    let file = path.join(ROOT, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    log.requests.push({url: req.url, body: ''});
    res.writeHead(200, {'content-type': types[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store'});
    res.end(fs.readFileSync(file));
  });

  return new Promise(resolve => server.listen(port, '127.0.0.1', () => {
    const base = 'http://127.0.0.1:' + server.address().port;
    resolve({
      base, db, log, q, psql, user, asUser,
      rpc: (u, fn, args = {}) => { const named = Object.entries(args).map(([k, v]) => `${k} => ${lit(v)}`).join(', '); const r = asUser(u, `select public.${fn}(${named}) as r`); if (r.error) throw new Error(r.error.message); return r.data[0].r; },
      // Route the page's CDN requests: Supabase → the stand-in above; everything else off-origin → blocked (tests run offline).
      async wire(context) {
        await context.route(/cdn\.jsdelivr\.net\/npm\/@supabase/, r => r.fulfill({contentType: 'text/javascript', body: fakeSupabase}));
        await context.route(u => !u.href.startsWith(base) && !/jsdelivr\.net\/npm\/@supabase/.test(u.href), r => r.abort());
      },
      playerRows: () => q(`select (select count(*) from public.hunt_teams)::int teams, (select count(*) from public.hunt_members)::int members,
                                  (select count(*) from public.hunt_checkins)::int checkins, (select count(*) from public.hunt_team_puzzles)::int puzzles,
                                  (select count(*) from public.hunt_reward_tokens)::int tokens`)[0],
      close: () => new Promise(r => { for (const set of subs.values()) for (const s of set) s.res.end(); server.close(r); server.closeAllConnections && server.closeAllConnections(); })
    });
  }));
}
