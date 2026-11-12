// End-to-end check of Find the Herd on phone-sized screens with SIMULATED GPS, against the
// real migrations in a local PostgreSQL database (see herd-harness.mjs for the stand-ins).
// Covers: solo flow, encrypted team sync, reload persistence, duplicate-submission
// idempotency, Demo Practice vs Competition isolation, the wallet, standings and the admin view.
// Writes screenshots to docs/screenshots/herd-*.png.
//
//   CHROME=/usr/bin/google-chrome PLAYWRIGHT=/path/to/playwright node tests/ui/herd-flow.ui.mjs
//   (optional) HERD_ANSWERS=/path/to/answers.json  also plays a bundled demo route fully offline
//
// Needs: playwright, psql + a local server (PG* env vars), Chrome or Chromium.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {startHarness, ROOT} from './herd-harness.mjs';
const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');
const core = require('../../herd-core.js');

const SHOTS = path.join(ROOT, 'docs', 'screenshots');
const h = await startHarness();
const browser = await chromium.launch({executablePath: process.env.CHROME || undefined, args: ['--no-sandbox']});
let passed = 0;
const ok = (cond, what) => { assert.ok(cond, what); passed++; console.log('  ✓ ' + what); };
const step = name => console.log('\n' + name);

// ---- a route the test knows the answers to (the demo answers are not in the repository) ----
const admin = h.user('hunt.admin@colorado.edu');
h.psql(`insert into public.admin_allowlist (email) values ('hunt.admin@colorado.edu')`);
const ANS = {1: 'alpha', 2: '42', 3: 'gamma', 4: 'delta', 5: 'omega'};
const CPS = ['norlin-quad', 'macky-south', 'old-main', 'rippon-outside', 'umc-terrace'];
h.rpc(admin, 'hunt_admin_publish', {p_edition: 'test-1', p_doc: {title: 'Test Route', theme: 'Simulated', style: 'Automated test', intro: 'A route with known answers for the browser tests.', demo: true,
  puzzles: CPS.map((cp, i) => ({no: i + 1, checkpoint: cp, kind: i === 2 ? 'split' : 'observe', format: 'One word', prompt: 'Test puzzle ' + (i + 1) + ': type the test answer.',
    hints: ['First hint for ' + (i + 1), 'Second hint for ' + (i + 1)], pieces: i === 2 ? ['Piece one of the clue', 'Piece two of the clue', 'Piece three of the clue', 'Piece four of the clue'] : [], answers: [ANS[i + 1]]}))}});
h.rpc(admin, 'hunt_admin_set_status', {p_edition: 'test-1', p_status: 'active'});
const where = Object.fromEntries(h.q(`select id, lat, lng from public.hunt_checkpoints`).map(c => [c.id, c]));
const gps = (no, metresNorth = 6, accuracy = 8) => ({latitude: where[CPS[no - 1]].lat + metresNorth / 111320, longitude: where[CPS[no - 1]].lng, accuracy});

async function phone({user = null, location = null, reducedMotion = 'no-preference'} = {}) {
  const ctx = await browser.newContext({viewport: {width: 390, height: 844}, deviceScaleFactor: 2, hasTouch: true, isMobile: true, reducedMotion,
    permissions: location ? ['geolocation'] : [], geolocation: location || undefined});
  await h.wire(ctx);
  if (user) await ctx.addInitScript(u => { try { localStorage.setItem('test-auth', JSON.stringify(u)); } catch (e) {} }, user);
  const page = await ctx.newPage();
  page.on('pageerror', e => { console.error('PAGE ERROR', e.message); process.exitCode = 1; });
  return {ctx, page};
}
const cp = no => `section[aria-label^="Checkpoint ${no}:"]`;
// Screenshots: wait for toasts to clear; an open dialog is captured as the phone shows it, anything else full length.
async function shot(page, name) {
  await page.waitForFunction(() => !document.querySelector('#toasts .toast'), null, {timeout: 8000}).catch(() => {});
  const dialog = await page.evaluate(() => document.getElementById('modal')?.classList.contains('show') || false);
  const full = !dialog && !name.includes('admin');
  // sticky bars repeat down a full-length capture, so pin them to the top just for the picture
  if (full) await page.addStyleTag({content: '.htop,.practice-bar{position:static!important}'}).then(t => page.screenshot({path: path.join(SHOTS, 'herd-' + name + '.png'), fullPage: true}).then(() => t.evaluate(n => n.remove())));
  else await page.screenshot({path: path.join(SHOTS, 'herd-' + name + '.png')});
}
async function openCp(page, no) { if (await page.getAttribute(`${cp(no)} .hd`, 'aria-expanded') !== 'true') await page.click(`${cp(no)} .hd`); }
async function checkIn(p, no) { await openCp(p.page, no); await p.ctx.setGeolocation(gps(no)); await p.page.click(`[data-act=checkin][data-no="${no}"]`); await p.page.waitForSelector(`${cp(no)}.here, ${cp(no)}.done, ${cp(no)}.crediting`); }
async function answer(page, no, text) { await page.fill(`#ans${no}`, text); await page.click(`[data-act=answer][data-no="${no}"]`); }
async function start(page, edition, mode, nick, name) {
  await page.goto(h.base + '/herd.html'); await page.waitForSelector(`[data-act=pick][data-id="${edition}"]`);
  await page.click(`[data-act=pick][data-id="${edition}"]`); await page.click(`[data-act=mode][data-mode=${mode}]`);
  await page.waitForSelector('[data-act=privacyOk]');
}
const store = page => page.evaluate(() => ({local: Object.fromEntries(Object.entries(localStorage)), session: Object.fromEntries(Object.entries(sessionStorage)), url: location.href}));
const noCoordinates = () => h.log.requests.every(r => !/40\.0\d\d|105\.2\d|latitude|longitude|"lat"|"lng"|accuracy/i.test(r.url + r.body));
const ciphertextOnly = () => h.log.frames.every(f => f.event === 'm' && Object.keys(f.payload).join() === 'c' && /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/.test(f.payload.c) && /^herd-[0-9a-f]{32}$/.test(f.channel));

try {
// =====================================================================================
step('1. Solo, Friends Mode, simulated GPS');
{
  const p = await phone({location: {latitude: 40.0125, longitude: -105.2711, accuracy: 9}}), {page} = p;
  await page.goto(h.base + '/herd.html'); await page.waitForSelector('[data-act=pick]');
  ok(await page.locator('[data-act=pick]').count() === 4, 'lobby lists the three demo routes and the test route');
  ok((await page.textContent('#hv')).includes('Demo Route — Edition 1') && (await page.textContent('#hv')).includes('Demo Route — Edition 3'), 'demo routes are labelled "Demo Route — Edition 1/2/3"');
  await shot(page, '01-lobby');
  await page.click('[data-act=pick][data-id="test-1"]'); await shot(page, '02-modes');
  await page.click('[data-act=mode][data-mode=friends]');
  const priv = await page.textContent('#hv');
  ok(/Exact coordinates are never sent and never stored/.test(priv) && /nickname, avatar and progress/.test(priv) && /saves nothing about you/.test(priv), 'one-screen privacy summary appears before starting');
  await shot(page, '03-privacy-summary');
  await page.click('[data-act=privacyOk]');
  await page.fill('#fNick', 'Sam Solo'); await page.fill('#fName', 'Quad Squad'); await page.check('input[name=myAv][value=owl]', {force: true});
  await shot(page, '04-setup'); await page.click('[data-act=start]'); await page.waitForSelector(cp(1));
  ok(await page.locator('[data-act=sim]').count() === 0, 'no "Simulate arriving" button outside Demo Practice');

  // far away → honest message with distance and direction
  await page.click('[data-act=checkin][data-no="1"]'); await page.waitForSelector('.statusbox.warn');
  ok(/not at this checkpoint yet/.test(await page.textContent('.statusbox.warn')) && /to the south/.test(await page.textContent('.statusbox.warn')), 'far from the checkpoint: says how far and which way');
  await shot(page, '05-gps-outside');
  // right place, hopeless accuracy → not accepted
  await p.ctx.setGeolocation(gps(1, 6, 400)); await page.click('[data-act=checkin][data-no="1"]');
  await page.waitForFunction(() => /can’t pin down/.test(document.querySelector('.statusbox.warn')?.textContent || ''), null, {timeout: 20000});
  ok(true, 'weak GPS (±400 m) is refused with a retry, even at the right spot');
  await shot(page, '06-gps-weak');
  await checkIn(p, 1);
  ok(/You’re here/.test(await page.textContent(cp(1))), 'inside the checkpoint: checked in');
  await answer(page, 1, 'not it'); await page.waitForSelector(`${cp(1)} .msg.bad`);
  ok(/Not quite/.test(await page.textContent(`${cp(1)} .msg.bad`)), 'wrong answer: gentle retry, no penalty');
  await page.click('[data-act=hint][data-no="1"]'); await page.waitForSelector('.hintlist li');
  await shot(page, '07-puzzle-hint');
  await answer(page, 1, ' ALPHA! '); await page.waitForSelector(`${cp(1)}.done`);
  ok(/Done · 80/.test(await page.textContent(cp(1))), 'solved with one hint: 80 points; punctuation and case ignored');
  for (const no of [2, 3, 4, 5]) {
    await checkIn(p, no);
    if (no === 3) { ok(await page.locator(`${cp(3)} .pieces li`).count() === 0, 'split clue, solo: pieces start hidden behind one button'); await page.click('[data-act=allPieces]'); await page.waitForSelector('.pieces li');
      ok(await page.locator(`${cp(3)} .pieces li:not(.missing)`).count() === 4, 'one tap gives a solo player every piece'); await shot(page, '08-split-solo'); }
    await answer(page, no, ANS[no]); await page.waitForSelector(`${cp(no)}.done`);
  }
  await page.waitForSelector('.finish');
  ok((await page.textContent('.finish .score')).trim() === '580', 'finish: 80 + 4×100 + 100 bonus = 580 of 600');
  await shot(page, '09-finish-friends');

  const s = await store(page), blobs = Object.keys(s.local).filter(k => k.startsWith('bp-herd:'));
  ok(!s.url.includes('#') && !s.url.includes('key='), 'address bar carries no key');
  ok(blobs.length === 1 && /^v1\./.test(s.local[blobs[0]]) && !s.local[blobs[0]].includes('Sam') && !JSON.stringify(s.local).includes('Quad Squad'), 'this phone stores the herd as ciphertext only');
  const raw = Object.entries(s.session).find(([k]) => k.startsWith('bp-herd-raw:'))[1];
  ok(!JSON.stringify(s.local).includes(raw) && !JSON.stringify(h.log.requests).includes(raw) && !JSON.stringify(h.log.frames).includes(raw), 'the herd key never reaches localStorage, a request or the relay');
  ok(JSON.stringify(h.playerRows()) === JSON.stringify({teams: 0, members: 0, checkins: 0, puzzles: 0, tokens: 0}), 'Friends Mode wrote zero rows about anyone');
  ok(h.log.rpc.every(r => ['hunt_get_editions', 'hunt_check_answer', 'increment_hunt_metric'].includes(r.fn) && r.user === null), 'only read-only calls and anonymous counters were made, with no sign-in');
  ok(noCoordinates(), 'no request contained a coordinate');
  ok(ciphertextOnly(), 'the relay carried only sealed frames');
  const m = Object.fromEntries(h.q(`select metric_key, count from public.hunt_metrics where edition_id = 'test-1'`).map(r => [r.metric_key, r.count]));
  ok(m.views === 1 && m.starts === 1 && m.hints_used === 1 && m.completions === 1 && [1, 2, 3, 4, 5].every(n => m[`checkpoint_${n}_completions`] === 1), 'anonymous funnel counted each step exactly once');

  await page.reload(); await page.waitForSelector('.finish');
  ok((await page.textContent('.finish .score')).trim() === '580' && await page.locator('.cp.done').count() === 5, 'reload: progress restored from this phone');
  const m2 = h.q(`select sum(count)::int s from public.hunt_metrics where edition_id = 'test-1'`)[0].s;
  ok(m2 === 9, 'reload did not double-count anything');
  await p.ctx.close();
}

// =====================================================================================
step('2. Two phones, Friends Mode: encrypted sync, split clues, rolling code, reload');
{
  h.log.frames.length = 0; h.log.requests.length = 0; h.log.rpc.length = 0;
  const a = await phone({location: gps(3)}), b = await phone();   // B has location turned off
  await start(a.page, 'test-1', 'friends'); await a.page.click('[data-act=privacyOk]');
  await a.page.fill('#fNick', 'Ana Secretname'); await a.page.fill('#fName', 'Kittredge Crew'); await a.page.click('[data-act=start]'); await a.page.waitForSelector(cp(1));
  await a.page.click('[data-act=invite]'); await a.page.waitForSelector('#invUrl');
  const invite = await a.page.inputValue('#invUrl');
  ok(/herd\.html#key=[A-Za-z0-9_-]{43}$/.test(invite) && await a.page.locator('#modal svg.qr').count() === 1, 'invite is a QR code and a link with the key in the #fragment');
  await shot(a.page, '10-invite'); await a.page.keyboard.press('Escape');

  await b.page.goto(invite); await b.page.waitForSelector('[data-act=privacyOk]');
  ok(!(await b.page.evaluate(() => location.href)).includes('key='), 'the key is removed from the joiner’s address bar straight away');
  ok(/Before you join/.test(await b.page.textContent('#hv')), 'joiners see the privacy summary first');
  await b.page.click('[data-act=privacyOk]'); await b.page.waitForSelector('#fNick');
  ok(/Join Kittredge Crew/.test(await b.page.textContent('#hv')), 'the herd arrived from the teammate’s phone, phone to phone');
  await b.page.fill('#fNick', 'Ben Hiddenname'); await b.page.check('input[name=myAv][value=bear]', {force: true}); await shot(b.page, '11-join'); await b.page.click('[data-act=join]');
  await b.page.waitForSelector(cp(1)); await a.page.waitForFunction(() => document.querySelectorAll('.mem').length === 2);
  ok(/Live with 1 teammate/.test(await a.page.textContent('#linkLine')), 'both phones show the herd');

  // A reaches checkpoint 3 (split clue): the puzzle opens for B too, but only A is checked in
  await checkIn(a, 3);
  await b.page.waitForSelector(`${cp(3)}.unlocked`); await openCp(b.page, 3);
  ok(/A teammate unlocked this puzzle/.test(await b.page.textContent(cp(3))) && await b.page.locator('#ans3').count() === 0, 'B can read the puzzle but can’t answer until B checks in');
  const mineA = await a.page.locator(`${cp(3)} .pieces li:not(.missing)`).count(), mineB = await b.page.locator(`${cp(3)} .pieces li:not(.missing)`).count();
  ok(mineA === 2 && mineB === 2 && await b.page.locator(`${cp(3)} .pieces li.missing`).count() === 2, 'four clue pieces dealt two and two across the phones');
  await shot(b.page, '12-split-team');
  await a.page.click(`${cp(3)} [data-act=pieceQr]`); await a.page.waitForSelector('#modal svg.qr'); ok(true, 'a piece can be handed over as a QR code'); await shot(a.page, '13-piece-qr'); await a.page.keyboard.press('Escape');
  await b.page.click(`${cp(3)} [data-act=pieceSend]`);
  await a.page.waitForFunction(sel => document.querySelectorAll(sel).length === 3, `${cp(3)} .pieces li:not(.missing)`);
  ok(true, 'a piece sent to the herd shows up on the other phone');

  // B's location is off → honest explanation, then B uses A's rolling code instead
  await b.page.click('[data-act=checkin][data-no="3"]'); await b.page.waitForSelector('.statusbox.warn');
  ok(/Location is turned off/.test(await b.page.textContent('.statusbox.warn')) && /never sends it anywhere/.test(await b.page.textContent('.statusbox.warn')), 'location denied: explains, and offers the teammate-code fallback');
  await shot(b.page, '14-gps-denied');
  await a.page.click('[data-act=code][data-no="3"]'); await a.page.waitForSelector('#codeDigits');
  await shot(a.page, '15-rolling-code');
  await b.page.click('[data-act=vouch][data-no="3"]'); await b.page.waitForSelector('#scanText');
  await b.page.fill('#scanText', '000000'); await b.page.click('[data-act=scanTyped]');
  await b.page.waitForFunction(() => /don’t match/.test(document.querySelector('#scanMsg')?.textContent || ''));
  ok(true, 'a wrong code is refused');
  const digits = (await a.page.textContent('#codeDigits')).replace(/\s/g, '');
  await b.page.fill('#scanText', digits); await b.page.click('[data-act=scanTyped]');
  await b.page.waitForSelector(`${cp(3)}.here`); await a.page.keyboard.press('Escape');
  ok(/Checked in with a teammate’s code/.test(await b.page.textContent(cp(3))) && /Together with Ana Secretname/.test(await b.page.textContent(cp(3))), 'B checked in with A’s live code and got the “together” stamp');
  await answer(a.page, 3, 'gamma'); await a.page.waitForSelector(`${cp(3)}.done`); await b.page.waitForSelector(`${cp(3)}.done`);
  ok(/Solved by Ana Secretname/.test(await b.page.textContent(cp(3))), 'A’s answer reaches B; both have credit because both checked in');
  await shot(b.page, '16-team-done');

  // B's browser goes away; A keeps playing; B comes back with no link at all
  await b.page.goto('about:blank');
  await checkIn(a, 1); await answer(a.page, 1, 'alpha'); await a.page.waitForSelector(`${cp(1)}.done`);
  await b.page.goto(h.base + '/herd.html'); await b.page.waitForSelector(`${cp(3)}.done`);
  ok(await b.page.locator('.mem').count() === 2, 'B reopens the app with no invite link: herd and progress are back from this phone');
  await b.page.waitForSelector(`${cp(1)}.solved`);
  ok(true, 'and B catches up on what happened while away (checkpoint 1 solved by A; B still needs their own check-in)');
  const sb = await store(b.page);
  ok(Object.keys(sb.local).filter(k => k.startsWith('bp-herd:')).every(k => /^v1\./.test(sb.local[k])) && !JSON.stringify(sb.local).includes('Hiddenname') && !JSON.stringify(sb.local).includes('gamma'), 'B’s stored copy is still ciphertext');

  ok(h.log.frames.length > 8 && ciphertextOnly(), `the relay carried ${h.log.frames.length} frames, all sealed`);
  const relayed = JSON.stringify(h.log.frames), requested = JSON.stringify(h.log.requests), key = invite.split('#key=')[1];
  ok(['Secretname', 'Hiddenname', 'Kittredge', 'gamma', 'alpha', 'Piece one', key].every(x => !relayed.includes(x)), 'no nickname, herd name, answer, clue or key crossed the relay in the clear');
  ok(['Secretname', 'Hiddenname', 'Kittredge', key].every(x => !requested.includes(x)), 'and no request to the server named a player, the herd or its key (answer guesses for this server-held route are checked read-only)');
  ok(noCoordinates(), 'no request contained a coordinate');
  ok(JSON.stringify(h.playerRows()) === JSON.stringify({teams: 0, members: 0, checkins: 0, puzzles: 0, tokens: 0}), 'still zero rows in the database');

  await b.page.click('[data-act=leave]'); await b.page.click('#mBtns .danger'); await b.page.waitForSelector('[data-act=pick]');
  const after = await store(b.page);
  ok(!Object.keys(after.local).some(k => k.startsWith('bp-herd')) && !Object.keys(after.session).some(k => k.startsWith('bp-herd-raw')), 'leaving wipes the herd from the phone');
  await a.page.waitForSelector('.mem.away'); ok(true, 'the teammate sees that B left');
  await a.ctx.close(); await b.ctx.close();
}

// =====================================================================================
step('3. Competition Mode: sign-in, server check-ins, idempotency, roster lock, token, standings');
{
  h.log.frames.length = 0; h.log.requests.length = 0; h.log.rpc.length = 0;
  const ada = h.user('ada@colorado.edu', 'Libby Hall'), ben = h.user('ben@colorado.edu', 'Libby Hall');
  const a = await phone({location: gps(1)}), {page} = a;
  // sign in through the screen (email code)
  await start(page, 'test-1', 'competition');
  ok(/Competition Mode saves the minimum/.test(await page.textContent('#hv')) && /never who is on a team/.test(await page.textContent('#hv')), 'Competition has its own privacy summary: what is saved and what standings show');
  await page.click('[data-act=privacyOk]');
  ok(await page.locator('#siEmail').count() === 1, 'Competition asks for sign-in');
  await page.fill('#siEmail', 'ada@colorado.edu'); await page.click('[data-act=siSend]'); await page.waitForSelector('#siCode');
  await page.fill('#siCode', '123456'); await page.click('[data-act=siVerify]'); await page.waitForSelector('#fName');
  ok(/✓ colorado\.edu verified/.test(await page.textContent('#hv')) && /Libby Hall/.test(await page.textContent('#hv')), 'verified colorado.edu badge and existing dorm/team shown');
  await page.fill('#fNick', 'Ada'); await page.fill('#fName', 'Name!!'); await page.click('[data-act=start]'); await page.waitForSelector('.msg.bad');
  ok(/3 to 24 letters/.test(await page.textContent('.msg.bad')), 'team name rules are enforced by the server');
  await page.fill('#fName', 'Libby Legends'); await shot(page, '17-competition-setup'); await page.click('[data-act=start]'); await page.waitForSelector(cp(1));
  const team = h.q(`select id from public.hunt_teams`)[0].id;
  ok(await page.locator('[data-act=sim]').count() === 0, 'no simulated check-ins in Competition Mode');

  // Ben joins before the first checkpoint
  await page.click('[data-act=invite]'); const invite = await page.inputValue('#invUrl'); await page.keyboard.press('Escape');
  const b = await phone({user: ben, location: gps(1)});
  await b.page.goto(invite); await b.page.click('[data-act=privacyOk]'); await b.page.waitForSelector('#fNick'); await b.page.fill('#fNick', 'Ben'); await b.page.click('[data-act=join]'); await b.page.waitForSelector(cp(1));
  ok(h.q(`select count(*)::int c from public.hunt_members where team_id = '${team}'`)[0].c === 2, 'teammate joined the server roster using the team id shared inside the encrypted herd');
  ok(!JSON.stringify(h.log.frames).includes(team), 'the team id never appears on the relay in the clear');

  // checkpoint 1: check in, double-tap submit
  await checkIn(a, 1);
  ok(h.playerRows().checkins === 0, 'arriving alone sends nothing to the server (it needs the answer too)');
  await page.fill('#ans1', 'alpha');
  await page.evaluate(() => { const btn = document.querySelector('[data-act=answer][data-no="1"]'); btn.click(); btn.click(); btn.click(); });
  await page.waitForSelector(`${cp(1)}.done`);
  const again = h.rpc(ada, 'hunt_check_in', {p_team: team, p_checkpoint: 1, p_in_geofence: true, p_answer: 'alpha'});
  ok(again.status === 'already' && h.q(`select count(*)::int c from public.hunt_checkins where user_id = '${ada.id}'`)[0].c === 1, 'triple-tap plus a replayed request: still exactly one check-in row');
  const calls = h.log.rpc.filter(r => r.fn === 'hunt_check_in');
  ok(calls.length >= 1 && calls.every(r => Object.keys(r.args).sort().join() === 'p_answer,p_checkpoint,p_in_geofence,p_team' && r.args.p_in_geofence === true), 'the check-in request is: team, checkpoint number, "inside: true", answer — nothing else');
  await shot(page, '18-competition-run');

  // Ben is also at checkpoint 1: the herd already solved it, so his phone only reports that he is there
  await checkIn(b, 1); await b.page.waitForSelector(`${cp(1)}.done`);
  ok(h.q(`select count(*)::int c from public.hunt_checkins where team_id = '${team}' and checkpoint_no = 1`)[0].c === 2, 'each player gets their own attendance row');
  // roster is now frozen
  const late = await phone({user: h.user('cy@colorado.edu')});
  await late.page.goto(invite); await late.page.click('[data-act=privacyOk]'); await late.page.waitForSelector('#fNick'); await late.page.fill('#fNick', 'Cy'); await late.page.click('[data-act=join]');
  await late.page.waitForFunction(() => /roster is locked/.test(document.querySelector('.msg.bad')?.textContent || ''));
  ok(h.q(`select count(*)::int c from public.hunt_members where team_id = '${team}'`)[0].c === 2, 'a late joiner is refused: the roster froze at the first completed checkpoint');
  await shot(late.page, '19-roster-locked'); await late.ctx.close();

  // Ada finishes; Ben stops after checkpoint 1
  await checkIn(a, 2); await page.click('[data-act=hint][data-no="2"]'); await page.waitForSelector(`${cp(2)} .hintlist li`); await answer(page, 2, '42'); await page.waitForSelector(`${cp(2)}.done`);
  for (const no of [3, 4, 5]) { await checkIn(a, no); if (no === 3) await page.click('[data-act=allPieces]'); await answer(page, no, ANS[no]); await page.waitForSelector(`${cp(no)}.done`); }
  await page.waitForSelector('.finish .token');
  const fin = await page.textContent('.finish');
  ok(/DEMO-[0-9A-F]{12}/.test(fin) && fin.includes('Demo reward — not redeemable. No purchase benefit is available.'), 'finishing issues a demo token with the unmistakable not-redeemable notice');
  ok((await page.textContent('.finish .score')).trim() === '340', 'team score is the average: Ada 580, Ben 100 → 340');
  await shot(page, '20-finish-competition');
  const rows = h.q(`select user_id, checkpoint_id, in_geofence, completed_at is not null as timed from public.hunt_checkins where team_id = '${team}'`);
  ok(rows.length === 6 && rows.every(r => r.in_geofence === true && r.timed), 'server holds only checkpoint, time and in_geofence = true per player');
  ok(h.q(`select count(*)::int c from public.hunt_reward_tokens`)[0].c === 1, 'one token, for the one finisher');
  ok(noCoordinates(), 'no request in the whole competitive run contained a coordinate');
  ok(ciphertextOnly(), 'herd sync stayed sealed');

  // reload keeps everything, including the token
  await page.reload(); await page.waitForSelector('.finish .token');
  ok(await page.locator('.cp.done').count() === 5, 'reload: competitive progress and token are restored');

  await page.click('.finish [data-act=standings]'); await page.waitForSelector('.lb');
  const st = await page.textContent('#hv');
  ok(/Libby Legends \(yours\)/.test(st) && /Libby Hall · 2 players/.test(st) && /✓ colorado\.edu/.test(st) && /340/.test(st), 'weekly standings list the team, its dorm and score');
  ok(!/Ada|Ben|@/.test(st.replace('Libby Legends', '')), 'standings never name the players');
  await shot(page, '21-standings');
  await page.click('[data-act=backToRun]'); await page.waitForSelector('.finish'); await page.click('.finish [data-act=wallet]'); await page.waitForSelector('[data-act=useToken]');
  ok((await page.textContent('#hv')).split('Demo reward — not redeemable. No purchase benefit is available.').length >= 3, 'wallet repeats the notice on the page and on the token');
  await shot(page, '22-wallet');
  await page.click('[data-act=useToken]'); await page.click('#mBtns .pri'); await page.waitForFunction(() => /Used/.test(document.querySelector('#hv .card')?.textContent || ''));
  ok(h.q(`select status from public.hunt_reward_tokens`)[0].status === 'used' && await page.locator('[data-act=useToken]').count() === 0, 'a token can be used exactly once');

  // Ben leaves to finish solo: his credit and place on the team are kept
  await b.page.click('[data-act=leave]'); await b.page.click('#mBtns .pri'); await b.page.waitForFunction(() => document.querySelectorAll('.mem').length === 1);
  ok(h.q(`select count(*)::int c from public.hunt_checkins where user_id = '${ben.id}'`)[0].c === 1 && await b.page.locator(`${cp(1)}.done`).count() === 1, 'leaving mid-hunt keeps personal credit; the player carries on solo');
  await checkIn(b, 2); await b.page.waitForSelector(`${cp(2)}.done`);
  ok(h.q(`select final_score s from public.hunt_teams where id = '${team}'`)[0].s === 380, 'and solo check-ins still count for the team (Ben 180, Ada 580 → 380)');
  await a.ctx.close(); await b.ctx.close();
}

// =====================================================================================
step('4. Demo Practice is isolated from Competition');
{
  const before = h.playerRows(), metrics = h.q(`select coalesce(sum(count), 0)::int s from public.hunt_metrics where metric_key <> 'views'`)[0].s;
  h.log.rpc.length = 0; h.log.requests.length = 0;
  const cy = h.user('dee@colorado.edu', 'Baker Hall');
  const p = await phone({user: cy, reducedMotion: 'reduce'}), {page} = p;   // signed in, no location permission at all
  await start(page, 'test-1', 'practice');
  ok(/Demo Practice is a sandbox/.test(await page.textContent('#hv')), 'practice has its own privacy summary');
  await page.click('[data-act=privacyOk]'); await page.fill('#fNick', 'Dee'); await page.click('[data-act=start]'); await page.waitForSelector('.practice-bar');
  ok(/DEMO PRACTICE · simulated check-ins · 0 points · no rewards/.test(await page.textContent('.practice-bar')) && await page.evaluate(() => document.body.classList.contains('practice') && getComputedStyle(document.getElementById('hv')).backgroundImage.includes('DEMO')), 'practice is watermarked: banner plus a repeating DEMO PRACTICE background');
  for (const no of [1, 2, 3, 4, 5]) {
    await openCp(page, no); await page.click(`[data-act=sim][data-no="${no}"]`); await page.waitForSelector(`${cp(no)}.here`);
    if (no === 1) { ok(/Simulated check-in/.test(await page.textContent(cp(1))), 'simulated arrivals are labelled'); await shot(page, '23-practice'); }
    if (no === 3) await page.click('[data-act=allPieces]');
    await answer(page, no, ANS[no]); await page.waitForSelector(`${cp(no)}.done`);
  }
  await page.waitForSelector('.finish');
  const fin = await page.textContent('.finish');
  ok(/Practice complete/.test(fin) && /no points or rewards were earned/.test(fin) && !/DEMO-[0-9A-F]/.test(fin) && await page.locator('.finish .score').count() === 0, 'practice finish: no score, no token');
  await shot(page, '24-practice-finish');
  ok(JSON.stringify(h.playerRows()) === JSON.stringify(before), 'practice wrote no team, check-in or token rows — even while signed in');
  ok(h.q(`select coalesce(sum(count), 0)::int s from public.hunt_metrics where metric_key <> 'views'`)[0].s === metrics, 'practice is not counted in the funnel');
  ok(h.log.rpc.every(r => !['hunt_check_in', 'hunt_create_team', 'hunt_join_team', 'hunt_use_hint'].includes(r.fn)), 'practice never calls a competition function');
  ok(h.q(`select count(*)::int c from public.hunt_standings('test-1') s, jsonb_array_elements(s -> 'teams') t where t ->> 'team_name' ilike '%practice%'`)[0].c === 0, 'nothing from practice reaches the standings');
  ok(await page.evaluate(() => getComputedStyle(document.querySelector('.finish')).animationName === 'none'), 'reduced-motion setting turns the finish animation off');
  // keyboard: every control is reachable and named
  const unnamed = await page.evaluate(() => [...document.querySelectorAll('button, a, input')].filter(e => e.offsetParent && !(e.textContent.trim() || e.getAttribute('aria-label') || (e.id && document.querySelector('label[for="' + e.id + '"]')) || e.closest('label'))).length);
  ok(unnamed === 0, 'every visible control has an accessible name');
  const small = await page.evaluate(() => [...document.querySelectorAll('#hv button')].filter(e => e.offsetParent && e.getBoundingClientRect().height < 36).length);
  ok(small === 0, 'tap targets are comfortably large');
  await p.ctx.close();
}

// =====================================================================================
step('5. With no server at all: the bundled demo routes still work (pre-salted hashes)');
{
  const p = await phone({location: gps(1)}), {page} = p;
  await p.ctx.route(/__rpc|__relay/, r => r.abort());   // the online service is unreachable
  await start(page, 'demo-2', 'friends'); await page.click('[data-act=privacyOk]'); await page.fill('#fNick', 'Off Grid'); await page.fill('#fName', 'No Signal'); await page.click('[data-act=start]'); await page.waitForSelector(cp(1));
  ok(await page.locator('[data-act=mode][data-mode=competition]').count() === 0, 'started a Friends run with the server unreachable');
  await checkIn(p, 1); await answer(page, 1, 'definitely wrong'); await page.waitForSelector(`${cp(1)} .msg.bad`);
  ok(/Not quite/.test(await page.textContent(`${cp(1)} .msg.bad`)), 'answers are checked on the phone against salted hashes');
  if (process.env.HERD_ANSWERS) {
    const key = JSON.parse(fs.readFileSync(process.env.HERD_ANSWERS, 'utf8'))['demo-2'];
    for (const no of [1, 2, 3, 4, 5]) { if (no > 1) await checkIn(p, no); await answer(page, no, key[no][0]); await page.waitForSelector(`${cp(no)}.done`); }
    ok((await page.textContent('.finish .score')).trim() === '600', 'played Demo Route — Edition 2 start to finish offline (answers supplied privately via HERD_ANSWERS)');
  } else console.log('  – skipped the full offline demo run (set HERD_ANSWERS to include it)');
  await p.ctx.close();
}

// =====================================================================================
step('6. Admin view');
{
  const stranger = await phone({user: h.user('ada@colorado.edu')});
  await stranger.page.goto(h.base + '/herd-admin.html'); await stranger.page.waitForFunction(() => /isn’t a hunt administrator/.test(document.getElementById('gate').textContent));
  ok(await stranger.page.locator('#ui.hidden').count() === 1, 'a signed-in student who is not on the allowlist sees nothing');
  await stranger.ctx.close();
  const p = await phone({user: admin}), {page} = p; await page.setViewportSize({width: 1100, height: 900});
  await page.goto(h.base + '/herd-admin.html'); await page.waitForSelector('[data-cp="norlin-quad"]');
  ok(await page.locator('[data-cp] .pill.warn').count() === 5 && /needs_onsite_check: true/.test(await page.textContent('[data-cp="norlin-quad"]')), 'all five checkpoints show needs_onsite_check: true');
  ok(await page.locator('[data-ed]').count() === 4 && /[0-9a-f]{16}…/.test(await page.textContent('[data-ed="demo-1"]')) && !/alpha|gamma|omega/.test(await page.textContent('[data-ed="test-1"]')), 'routes show prompts, flags and hashed answers — never plain answers');
  const funnel = await page.textContent('#metrics');
  ok(/Test Route/.test(funnel) && /Finished/.test(funnel), 'anonymous funnel counters are shown per route');
  await shot(page, '25-admin');
  await page.uncheck('#flag-norlin-quad'); await page.fill('[data-cp="norlin-quad"] input >> nth=4', '45'); await page.click('[data-cp="norlin-quad"] button.pri');
  await page.waitForFunction(() => /checked on site/.test(document.querySelector('[data-cp="norlin-quad"]')?.textContent || ''));
  const c = h.q(`select needs_onsite_check n, radius_m r from public.hunt_checkpoints where id = 'norlin-quad'`)[0];
  ok(c.n === false && c.r === 45 && h.q(`select current_version v from public.hunt_editions where id = 'demo-1'`)[0].v === 2, 'editing a checkpoint saves and republishes the routes that use it');
  await page.click('[data-ed="demo-2"] .btns button'); await page.waitForFunction(() => /paused/.test(document.querySelector('[data-ed="demo-2"] .pill')?.textContent || ''));
  ok(!h.rpc(null, 'hunt_get_editions').some(e => e.id === 'demo-2'), 'pausing a route hides it from new runs');
  await page.click('[data-ed="test-1"] summary'); const ta = page.locator('[data-ed="test-1"] textarea');
  const doc = JSON.parse(await ta.inputValue()); doc.puzzles[0].prompt = 'Edited in the admin view'; doc.puzzles[0].answers = ['beta'];
  await ta.fill(JSON.stringify(doc, null, 2)); await page.click('[data-ed="test-1"] details button.pri');
  await page.waitForFunction(() => /Edited in the admin view/.test(document.querySelector('[data-ed="test-1"]')?.textContent || ''));
  const v = h.q(`select current_version v from public.hunt_editions where id = 'test-1'`)[0].v;
  ok(h.rpc(null, 'hunt_check_answer', {p_edition: 'test-1', p_version: v, p_checkpoint: 1, p_answer: 'Beta'}) === true && h.rpc(null, 'hunt_check_answer', {p_edition: 'test-1', p_version: v, p_checkpoint: 2, p_answer: '42'}) === true,
    'JSON editor: a new answer is hashed on the server; untouched puzzles keep theirs');
  await p.ctx.close();
}

console.log(`\n${passed} checks passed. Screenshots: docs/screenshots/herd-*.png`);
} catch (e) {
  console.error('\nFAILED:', e.message); process.exitCode = 1;
} finally {
  await browser.close(); await h.close();
}
