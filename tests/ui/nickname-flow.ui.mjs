// End-to-end check of the nickname screens on a phone-sized viewport, against
// the real migrations in a local PostgreSQL database. A tiny stand-in for
// Supabase's REST API runs each request as the signed-in student, so what you
// see is the database's real moderation and uniqueness result. Writes
// screenshots to docs/screenshots/nickname-*.png and prints accessibility checks.
//
//   SUPABASE_JS=path/to/supabase.js LEAFLET_DIR=path/to/leaflet/dist \
//   CHROME=/usr/bin/google-chrome node tests/ui/nickname-flow.ui.mjs
//
// Needs: playwright, psql + a local server (PG* env vars), Chrome or Chromium.
// No real Supabase project, email or student data is used. Demo names only:
// screenshots never show the sensitive moderation fixtures.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const DB = process.env.RR_UI_DB || 'rr_ui_demo';
const SHOTS = path.join(ROOT, 'docs', 'screenshots');
const SB = 'https://ykuxgfrmkixownnzutno.supabase.co';
const lit = v => v === null || v === undefined ? 'null' : typeof v === 'number' || typeof v === 'boolean' ? String(v) : "'" + String(v).replace(/'/g, "''") + "'";
const psql = (sqlText, db = DB) => {
  const r = spawnSync('psql', ['-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-d', db], {input: sqlText, encoding: 'utf8'});
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};
const q = text => JSON.parse(psql(`with t as (${text}) select coalesce(json_agg(t), '[]') from t;`));
function asUser(uid, text) {
  const r = spawnSync('psql', ['-X', '-q', '-At', '-d', DB], {encoding: 'utf8',
    input: `set role ${uid ? 'authenticated' : 'anon'}; set request.jwt.claim.sub = ${lit(uid || '')};\nwith t as (${text}) select coalesce(json_agg(t), '[]') from t;`});
  if (r.status !== 0) return {error: r.stderr.replace(/^psql:[^:]*:\d+: /gm, '').trim()};
  return {data: JSON.parse(r.stdout.trim())};
}

// ---- database ----
psql(`drop database if exists ${DB}`, 'postgres'); psql(`create database ${DB}`, 'postgres');
const apply = f => { const r = spawnSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '--single-transaction', '-d', DB, '-f', f], {encoding: 'utf8'}); if (r.status) throw new Error(r.stderr); };
apply(path.join(ROOT, 'tests', 'supabase-shim.sql'));
fs.readdirSync(path.join(ROOT, 'supabase', 'migrations')).sort().forEach(f => apply(path.join(ROOT, 'supabase', 'migrations', f)));
const mk = (email, name, dorm, segs) => {
  const id = q(`insert into auth.users (email) values (${lit(email)}) returning id`)[0].id;
  if (dorm) psql(`update public.profiles set dorm = ${lit(dorm)} where id = ${lit(id)}`);
  if (name) { asUser(id, `select public.set_username(${lit(name)})`); }
  if (segs) psql(`insert into public.weekly_zone_points (user_id, week, zone, segments) values (${lit(id)}, public.rr_week(), 'norlin', ${segs});
                  insert into public.claims (user_id, segment_id) select ${lit(id)}, 'w' || g || '.0.0' from generate_series(1, ${segs}) g;`);
  return id;
};
const others = [['BoulderBison817', 'Libby Hall', 41], ['FlatironFox731', 'Farrand Hall', 37], ['MackyMaverick358', 'Libby Hall', 29],
                ['SanitasSparrow', 'Baker Hall', 22], ['FoothillScout692', 'Libby Hall', 18], ['NorlinNomad264', 'Kittredge West', 12]]
  .map(([n, d, s], i) => mk(`demo${i}@example.test`, n, d, s));
const me = mk('demo.student@example.test', null, 'Libby Hall', 15);
const admin = mk('demo.mod@example.test', 'HerdModerator_Demo', null, 0);
psql(`update public.profiles set username = null where id = ${lit(admin)}`);   // name not needed for the demo
psql(`insert into public.app_admins (user_id) values (${lit(admin)})`);

// ---- static server ----
const MIME = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.geojson': 'application/json'};
const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/\/$/, '/index.html'));
  if (!p.startsWith(ROOT) || !fs.existsSync(p)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, {'content-type': MIME[path.extname(p)] || 'application/octet-stream'}); fs.createReadStream(p).pipe(res);
}).listen(8123);

// ---- fake Supabase REST, backed by the real database ----
const jwt = uid => ['e30', Buffer.from(JSON.stringify({sub: uid, role: 'authenticated', aud: 'authenticated', exp: 4102444800})).toString('base64url'), 'sig'].join('.');
const session = (uid, email) => JSON.stringify({access_token: jwt(uid), refresh_token: 'r', token_type: 'bearer', expires_in: 3600 * 24 * 365,
  expires_at: 4102444800, user: {id: uid, email, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}}});
const uidOf = req => { try { return JSON.parse(Buffer.from((req.headers()['authorization'] || '').split(' ')[1].split('.')[1], 'base64url')).sub; } catch (e) { return null; } };
async function supabase(route) {
  const req = route.request(), url = new URL(req.url()), uid = uidOf(req);
  const json = (b, s = 200) => route.fulfill({status: s, contentType: 'application/json', body: JSON.stringify(b)});
  if (url.pathname.startsWith('/auth/v1/user')) return json({id: uid, aud: 'authenticated'});
  if (url.pathname.startsWith('/auth/')) return json({});
  const m = url.pathname.match(/^\/rest\/v1\/(rpc\/)?([a-z_]+)$/);
  if (!m) return json({message: 'not found'}, 404);
  if (m[1]) {
    const args = req.postDataJSON() || {};
    const call = `public.${m[2]}(${Object.entries(args).map(([k, v]) => `${k} := ${lit(v)}`).join(', ')})`;
    const srf = psql(`select bool_or(proretset) from pg_proc where proname = ${lit(m[2])}`) === 't';
    const r = asUser(uid, srf ? `select * from ${call}` : `select ${call} as r`);
    if (r.error) return json({message: r.error}, 400);
    return json(srf ? r.data : r.data[0].r);
  }
  const table = m[2], method = req.method();
  const where = [], sp = url.searchParams;
  for (const [k, v] of sp) { const f = v.match(/^eq\.(.*)$/); if (f && !['select', 'order', 'limit'].includes(k)) where.push(`${k} = ${lit(f[1])}`); }
  if (method === 'GET') {
    const order = sp.get('order') ? ' order by ' + sp.get('order').replace(/\.(asc|desc)/, ' $1').replace(/\.nulls\w+/, '') : '';
    const r = asUser(uid, `select ${sp.get('select') || '*'} from public.${table}${where.length ? ' where ' + where.join(' and ') : ''}${order}${sp.get('limit') ? ' limit ' + +sp.get('limit') : ''}`);
    if (r.error) return json({message: r.error}, 400);
    return json(/vnd\.pgrst\.object/.test(req.headers()['accept'] || '') ? (r.data[0] || null) : r.data);
  }
  if (method === 'PATCH') {
    const body = req.postDataJSON();
    const r = asUser(uid, `update public.${table} set ${Object.entries(body).map(([k, v]) => `${k} = ${lit(v)}`).join(', ')} where ${where.join(' and ')} returning id`);
    return r.error ? json({message: r.error}, 403) : json(r.data);
  }
  return json([], 201);   // claim/badge upserts: nothing pending in this demo
}

// ---- browser ----
const browser = await chromium.launch({executablePath: process.env.CHROME || undefined, args: ['--no-sandbox']});
const results = [];
const check = (label, ok, detail = '') => { results.push({label, ok, detail}); console.log((ok ? 'PASS ' : 'FAIL ') + label + (detail ? ' — ' + detail : '')); };
async function newPage(uid, email, width = 390, height = 844) {
  const ctx = await browser.newContext({viewport: {width, height}, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block'});
  await ctx.addInitScript(([k, v]) => { localStorage.setItem(k, v); localStorage.setItem('rr-privacy-seen', '1'); }, ['sb-ykuxgfrmkixownnzutno-auth-token', session(uid, email)]);
  await ctx.route('https://cdn.jsdelivr.net/**', r => r.fulfill({path: process.env.SUPABASE_JS, contentType: 'text/javascript'}));
  await ctx.route('https://unpkg.com/**', r => { const f = path.basename(new URL(r.request().url()).pathname); r.fulfill({path: path.join(process.env.LEAFLET_DIR, f), contentType: f.endsWith('.css') ? 'text/css' : 'text/javascript'}); });
  await ctx.route(/arcgisonline|tile/, r => r.fulfill({status: 204}));
  await ctx.route(SB + '/**', supabase);
  const page = await ctx.newPage();
  page.on('pageerror', e => console.log('page error:', e.message));
  return page;
}
const shot = (page, name) => page.screenshot({path: path.join(SHOTS, `nickname-${name}.png`)});
const msgText = page => page.locator('#nickMsg').innerText();
async function touchTargets(page, scope, label) {
  const small = await page.$$eval(scope + ' button, ' + scope + ' input, ' + scope + ' textarea, ' + scope + ' select',
    els => els.map(e => (e.type === 'radio' || e.type === 'checkbox') && e.closest('label') ? e.closest('label') : e)
      .filter(e => e.offsetParent && e.getBoundingClientRect().height < 44).map(e => e.textContent.trim() || e.id || e.name));
  check(label + ': touch targets are at least 44 px tall', small.length === 0, small.join(', '));
}

const page = await newPage(me, 'demo.student@example.test');
await page.goto('http://localhost:8123/index.html');
await page.waitForSelector('#nickSug:not(:has(.muted))', {timeout: 15000});
const first = await page.locator('#nickSug').innerText();
check('onboarding opens the picker for an account without a nickname', /^[A-Za-z]+[0-9]{0,3}$/.test(first), first);
check('heading and copy', (await page.locator('#mTitle').innerText()) === 'What should the herd call you?' &&
      (await page.locator('#nickUI').innerText()).includes('No real name needed.'));
check('explains it is a public nickname, not complete anonymity', (await page.locator('.nick-note').innerText()).includes('isn’t a guarantee of complete anonymity'));
check('focus moves into the dialog', await page.evaluate(() => document.getElementById('modal').contains(document.activeElement)));
check('status messages are announced (aria-live)', (await page.getAttribute('#nickMsg', 'aria-live')) === 'polite');
await touchTargets(page, '#modal', 'suggestion screen');
await shot(page, '01-suggest');

await page.click('[data-nk=shuffle]');
await page.waitForFunction(f => document.getElementById('nickSug').textContent !== f, first);
const second = await page.locator('#nickSug').innerText();
check('Shuffle offers a different name', second !== first, first + ' → ' + second);
await shot(page, '02-shuffle');

await page.click('[data-nk=own]');
await page.fill('#nickIn', 'Buff Fan');
await page.waitForFunction(() => /letters, numbers, or underscores/.test(document.getElementById('nickMsg').textContent));
check('format message', (await msgText(page)) === 'Use 3–24 letters, numbers, or underscores, including at least one letter.');
check('invalid input is marked aria-invalid', (await page.getAttribute('#nickIn', 'aria-invalid')) === 'true');
check('input has a visible label', await page.$eval('#nickIn', e => !!document.querySelector('label[for="' + e.id + '"]')));
await shot(page, '03-format');

await page.fill('#nickIn', 'boulderbison817');
await page.waitForFunction(() => /taken/.test(document.getElementById('nickMsg').textContent), null, {timeout: 5000});
check('taken message (case-insensitive)', (await msgText(page)) === 'That name is taken. Try another or shuffle a new one.');
await shot(page, '04-taken');

await page.fill('#nickIn', 'CampusPolice');
await page.waitForSelector('[data-nk=review]');
check('guidelines message, without revealing the matched term', (await msgText(page)) === 'That username doesn’t meet our community guidelines. Choose another or use a suggested name.');
check('offers “Suggest a name” and review', await page.isVisible('[data-nk=suggest]') && await page.isVisible('[data-nk=review]'));
await touchTargets(page, '#modal', 'rejection screen');
await shot(page, '05-guidelines');

await page.click('[data-nk=review]');
await page.fill('#nickNote', 'It’s a joke about my campus job, not impersonation.');
await shot(page, '06-review');
await page.click('[data-nk=sendReview]');
await page.waitForFunction(() => /Request sent/.test(document.getElementById('nickMsg').textContent));
check('review request accepted', true);

await page.waitForSelector('#nickSug:not(:has(.muted))');
const chosen = await page.locator('#nickSug').innerText();
await page.click('[data-nk=use]');
await page.waitForFunction(() => !document.getElementById('modal').classList.contains('show'));
check('“Use this name” saves the suggestion exactly', q(`select username from public.profiles where id = ${lit(me)}`)[0].username === chosen, chosen);
await page.click('nav.tabs [data-go=progress]');
await page.waitForSelector('#nickBox .nick');
await page.locator('#cloudBox').scrollIntoViewIfNeeded();
check('account card shows the nickname and review status', (await page.locator('#nickBox').innerText()).includes(chosen) &&
      (await page.locator('#nickBox').innerText()).includes('waiting for a moderator'));
await shot(page, '07-account');

await page.click('[data-act=nick][data-ctx=change]');
await page.waitForSelector('#nickSug:not(:has(.muted))');
await page.click('[data-nk=own]'); await page.fill('#nickIn', 'Chautauqua_Comet'); await page.click('[data-nk=save]');
await page.waitForFunction(() => !document.getElementById('modal').classList.contains('show'));
await page.click('[data-act=nick][data-ctx=change]');
await page.waitForSelector('#nickSug:not(:has(.muted))');
await page.click('[data-nk=use]');
await page.waitForFunction(() => /once every 7 days/.test(document.getElementById('nickMsg').textContent));
check('second change within 7 days explains the limit', true, await msgText(page));
await shot(page, '08-change-limit');
await page.keyboard.press('Escape');

await page.click('nav.tabs [data-go=community]');
await page.waitForSelector('.lb-more');
const comm = await page.locator('#v-community').innerText();
check('community list shows nicknames, never emails', comm.includes('BoulderBison817') && comm.includes('Chautauqua_Comet') && !comm.includes('@'));
check('report buttons have accessible names', (await page.$$eval('.lb-more', b => b.every(x => /^Report the nickname /.test(x.getAttribute('aria-label'))))));
await touchTargets(page, '#v-community', 'community');
await page.locator('.lb-more').first().scrollIntoViewIfNeeded();
await shot(page, '09-community');
await page.locator('.lb-more').first().click();
await page.waitForSelector('input[name=rpReason]');
await touchTargets(page, '#modal', 'report dialog');
await shot(page, '10-report');
await page.click('label.opt:has(input[value=impersonation])');
await page.click('#mBtns .btn.pri');
await page.waitForSelector('.toast');
check('report sent', /review it/.test(await page.locator('.toast').last().innerText()));

// narrow phone: nothing overflows horizontally
const narrow = await newPage(others[5], 'demo5@example.test', 320, 640);
await narrow.goto('http://localhost:8123/index.html');
await narrow.click('nav.tabs [data-go=progress]'); await narrow.waitForSelector('#nickBox .nick');
check('320 px wide: no horizontal overflow', await narrow.evaluate(() => document.documentElement.scrollWidth <= innerWidth));

// administrator hides a name; owner sees the required-change flow
const mod = await newPage(admin, 'demo.mod@example.test');
await mod.goto('http://localhost:8123/admin.html');
await mod.waitForSelector('#reports .card');
await shot(mod, '11-admin-queue');
check('admin queue lists the report with reason and count', /impersonation/.test(await mod.locator('#reports').innerText()));
mod.on('dialog', d => d.accept());
await mod.locator('#reports .card').first().locator('button', {hasText: 'Confirm abusive'}).click();
await mod.waitForSelector('#reports .muted');
const reportedName = q(`select reported_name from public.username_reports order by id limit 1`)[0].reported_name;
const owner = q(`select target_user_id as id from public.username_reports order by id limit 1`)[0].id;
const ownerPage = await newPage(owner, 'owner@example.test');
await ownerPage.goto('http://localhost:8123/index.html');
await ownerPage.waitForSelector('#nickSug:not(:has(.muted))');
check('hidden name: owner is prompted to choose a replacement', (await ownerPage.locator('#mTitle').innerText()) === 'Choose a new nickname');
await shot(ownerPage, '12-required');
const pub = asUser(me, `select name from public.get_weekly_leaderboard(50)`).data.map(r => r.name);
check('hidden name replaced by a neutral placeholder for everyone', !pub.includes(reportedName) && pub.some(n => /^Buff [0-9A-F]{4}$/.test(n)), reportedName);

await browser.close(); server.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} UI checks passed`);
process.exit(failed.length ? 1 : 0);
