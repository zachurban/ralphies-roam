// Database tests for nicknames, moderation, reports and administrator review.
// Runs every migration against a real PostgreSQL server (with a small Supabase
// stand-in: tests/supabase-shim.sql) and calls the functions the way the app's
// API does: as the "authenticated" role with a JWT subject.
//
//   node --test tests/usernames.sql.test.cjs
//
// Needs `psql` and a server you can create databases on. Connection comes from
// the usual PG* environment variables (PGHOST, PGUSER, PGPASSWORD...). The test
// database is RR_TEST_DB (default rr_username_test) and is dropped and recreated.
// Skips itself if no server is reachable.
const {test, before} = require('node:test');
const assert = require('node:assert/strict');
const {spawnSync, spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DB = process.env.RR_TEST_DB || 'rr_username_test';
const MIG = path.join(ROOT, 'supabase', 'migrations');
const NEW_PREFIX = '20261112190000';   // first nickname migration
const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'username-moderation.json'), 'utf8'));
const rot13 = s => s.replace(/[a-z]/gi, c => String.fromCharCode((c <= 'Z' ? 90 : 122) >= (c = c.charCodeAt(0) + 13) ? c : c - 26));
const BLOCKED = Object.fromEntries(Object.entries(fixtures.blocked_rot13).map(([k, v]) => [k, v.map(rot13)]));

function psql(args, input) {
  return spawnSync('psql', ['-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', ...args], {input, encoding: 'utf8'});
}
const reachable = (() => { try { return psql(['-d', 'postgres', '-c', 'select 1']).status === 0; } catch (e) { return false; } })();
const skip = reachable ? false : 'no PostgreSQL server reachable (set PGHOST/PGUSER, or run on a machine with Postgres)';

const lit = v => v === null || v === undefined ? 'null' : "'" + String(v).replace(/'/g, "''") + "'";
// Run SQL as the database owner; returns rows of the last statement as objects.
function sql(text) {
  const r = psql(['-d', DB], `with t as (${text}) select coalesce(json_agg(t), '[]') from t;`);
  if (r.status !== 0) throw new Error(r.stderr.trim());
  return JSON.parse(r.stdout.trim());
}
function exec(text) {
  const r = psql(['-d', DB], text);
  if (r.status !== 0) throw new Error(r.stderr.trim());
  return r.stdout;
}
// Run SQL the way the REST API does for a signed-in student (or anon if uid is null).
function asUser(uid, text) {
  const pre = uid ? `set role authenticated; set request.jwt.claim.sub = ${lit(uid)};` : 'set role anon;';
  const r = psql(['-d', DB], `${pre}\nwith t as (${text}) select coalesce(json_agg(t), '[]') from t;`);
  if (r.status !== 0) { const e = new Error(r.stderr.replace(/^psql:[^:]*:\d+: /gm, '').trim()); e.sqlError = true; throw e; }
  return JSON.parse(r.stdout.trim());
}
const rpc = (uid, fn, args = '') => asUser(uid, `select public.${fn}(${args}) as r`)[0].r;
const setName = (uid, n) => rpc(uid, 'set_username', lit(n));
const checkName = (uid, n) => rpc(uid, 'check_username', lit(n));
const denied = (uid, text) => assert.throws(() => asUser(uid, text), e => e.sqlError, 'expected the database to refuse: ' + text);
const problem = n => sql(`select coalesce(public.rr_username_problem(${lit(n)}), public.rr_username_digit_problem(${lit(n)})) as p`)[0].p;
let n = 0;
function newUser(email) {
  n++;
  return sql(`insert into auth.users (email, created_at) values (${lit(email || `student${n}@colorado.edu`)}, now() + interval '${n} seconds') returning id`)[0].id;
}
const freshLimits = uid => exec(`delete from public.rate_events where user_id = ${lit(uid)}`);
const profile = uid => sql(`select * from public.profiles where id = ${lit(uid)}`)[0];

// Legacy accounts are created BEFORE the nickname migrations run, to test the upgrade.
const legacy = {};
before(() => {
  if (skip) return;
  psql(['-d', 'postgres', '-c', `drop database if exists ${DB}`]);
  const c = psql(['-d', 'postgres', '-c', `create database ${DB}`]);
  if (c.status !== 0) throw new Error(c.stderr);
  const apply = f => { const r = psql(['-d', DB, '--single-transaction', '-f', f]); if (r.status !== 0) throw new Error(path.basename(f) + ': ' + r.stderr); };
  apply(path.join(__dirname, 'supabase-shim.sql'));
  const files = fs.readdirSync(MIG).filter(f => f.endsWith('.sql')).sort();
  files.filter(f => f < NEW_PREFIX).forEach(f => apply(path.join(MIG, f)));

  // existing accounts, oldest first
  for (const [key, name] of [['valid', 'BuffFan'], ['dupLater', 'bufffan'], ['spaces', 'Zach U'], ['abusive', rot13('FuvgYbeq')],
                             ['short', 'ab'], ['none', null], ['lookalike', 'Buff_Fan']]) {
    const id = newUser(`${key}@colorado.edu`);
    legacy[key] = id;
    if (name !== null) exec(`update public.profiles set display_name = ${lit(name)}, dorm = 'Libby Hall' where id = ${lit(id)}`);
    exec(`insert into public.claims (user_id, segment_id) values (${lit(id)}, 'w1.0.0'), (${lit(id)}, 'w2.0.0')`);
  }
  files.filter(f => f >= NEW_PREFIX).forEach(f => apply(path.join(MIG, f)));
});

// ---------------------------------------------------------------------------
test('existing accounts: valid names kept, nobody renamed, abusive legacy names hidden for review', {skip}, () => {
  assert.equal(profile(legacy.valid).username, 'BuffFan');
  assert.equal(profile(legacy.dupLater).username, null, 'a later case-insensitive duplicate is not given the name');
  assert.equal(profile(legacy.dupLater).display_name, 'bufffan', 'but its legacy name is preserved');
  assert.equal(profile(legacy.lookalike).username, null, 'a look-alike of an older name is not given it');
  assert.equal(profile(legacy.spaces).username, null);
  assert.equal(profile(legacy.spaces).display_name, 'Zach U');
  assert.equal(profile(legacy.spaces).name_state, 'ok');
  assert.equal(profile(legacy.short).name_state, 'ok');
  const ab = profile(legacy.abusive);
  assert.equal(ab.name_state, 'hidden'); assert.equal(ab.name_state_reason, 'automated');
  assert.equal(sql(`select count(*)::int c from public.username_reports where target_user_id = ${lit(legacy.abusive)} and source = 'automated' and status = 'open'`)[0].c, 1);
  // relationships untouched
  for (const id of Object.values(legacy)) assert.equal(sql(`select count(*)::int c from public.claims where user_id = ${lit(id)}`)[0].c, 2);
  assert.equal(profile(legacy.valid).dorm, 'Libby Hall');
});

test('public names: legacy names still show, hidden or missing names show a neutral placeholder, never an email', {skip}, () => {
  const board = asUser(legacy.valid, `select name, is_me, name_ref from public.get_leaderboard(50)`);
  const names = board.map(r => r.name);
  assert.ok(names.includes('BuffFan')); assert.ok(names.includes('Zach U')); assert.ok(names.includes('bufffan'));
  assert.ok(!names.includes(rot13('FuvgYbeq')), 'abusive legacy name is not shown');
  assert.ok(names.includes('Buff ' + legacy.abusive.slice(0, 4).toUpperCase()));
  assert.ok(names.includes('Buff ' + legacy.none.slice(0, 4).toUpperCase()));
  assert.ok(names.every(x => !x.includes('@')), 'no email ever appears');
  assert.ok(board.every(r => r.name_ref && !Object.values(legacy).includes(r.name_ref)), 'refs are opaque, not account ids');
  assert.deepEqual(Object.keys(board[0]).sort(), ['is_me', 'name', 'name_ref']);
});

test('picker is offered to accounts without a nickname (format rules in username-core)', {skip}, () => {
  const core = require('../username-core');
  assert.equal(core.needsPicker(profile(legacy.valid)), false);
  for (const k of ['dupLater', 'spaces', 'abusive', 'short', 'none', 'lookalike']) assert.equal(core.needsPicker(profile(legacy[k])), true, k);
});

// ---------------------------------------------------------------------------
test('suggestions: campus-themed, valid, screened, available, and accepted as-is', {skip}, () => {
  const u = newUser('flatiron.fox.jane.doe@colorado.edu');
  exec(`update public.profiles set dorm = 'Farrand Hall' where id = ${lit(u)}`);
  const seen = new Set();
  for (let i = 0; i < 12; i++) {
    const r = rpc(u, 'suggest_username');
    assert.equal(r.status, 'ok');
    assert.match(r.name, /^[A-Za-z]+[0-9]{0,3}$/); assert.ok(r.name.length <= 24);
    assert.equal(problem(r.name), null);
    assert.ok(!/jane|doe|farrand/i.test(r.name.replace(/^Farrand/, '')) || r.name.startsWith('Farrand'), 'not built from the email or dorm');
    seen.add(r.name);
  }
  assert.ok(seen.size >= 8, 'shuffle gives different names');
  const pick = [...seen][0];
  assert.equal(setName(u, pick).status, 'ok');
  assert.equal(profile(u).username, pick);
  assert.equal(checkName(u, pick).status, 'current');
});

test('every curated combination stays within 24 characters and passes moderation', {skip}, () => {
  const bad = sql(`select r || w || '999' as n from unnest(public.rr_name_refs()) r, unnest(public.rr_name_words()) w
                   where lower(r) <> lower(w)
                     and (char_length(r || w || '999') > 24 or public.rr_username_problem(r || w) is not null
                          or public.rr_username_problem(r || w || '999') is not null)`);
  assert.deepEqual(bad, []);
  const lists = sql(`select array_to_string(public.rr_name_refs() || public.rr_name_words(), ' ') as s`)[0].s;
  assert.doesNotMatch(lists, /\b(admin|staff|police|cop|officer|ranger|guard|patrol|chief|captain|dean|official|security|support|mod|sheriff|marshal|regent)\b/i);
});

test('generation never reads account data', {skip}, () => {
  const src = sql(`select pg_get_functiondef('public.suggest_username()'::regprocedure) as s`)[0].s;
  assert.doesNotMatch(src, /email|display_name|dorm|auth\.users|claims|schedule/i);
});

// ---------------------------------------------------------------------------
test('custom names: valid names persist exactly as typed', {skip}, () => {
  const u = newUser();
  for (const name of ['Zach_U2', 'abc', 'Abcdefghijklmnopqrstuvw1', 'Buff_42', '2Fast4U']) {
    exec(`update public.profiles set username_changed_at = null where id = ${lit(u)}`);
    assert.equal(setName(u, name).status, 'ok', name);
    assert.equal(profile(u).username, name);
  }
});

test('format: unsupported Unicode, invisible characters, spaces and lengths are rejected, never rewritten', {skip}, () => {
  const u = newUser();
  const bad = ['ab', 'A'.repeat(25), '123', '___', '_1_', 'Zach U', ' Zach', 'Zach ', 'Zach-U', 'Zach.U', 'Zäch', 'Ｚach', 'Zach​U',
               'Zach U', 'Аdmin' /* Cyrillic A */, 'Zach😀', 'Zach‮U', 'Zach\tU', "Zach'U", 'Zach<b>', ''];
  const core = require('../username-core');
  for (const name of bad) {
    freshLimits(u);
    assert.equal(core.formatOk(name), false, 'client: ' + JSON.stringify(name));
    assert.equal(checkName(u, name).status, 'format', 'check: ' + JSON.stringify(name));
    assert.equal(setName(u, name).status, 'format', 'set: ' + JSON.stringify(name));
  }
  assert.equal(profile(u).username, null);
  assert.throws(() => exec(`update public.profiles set username = 'Zach​U' where id = ${lit(u)}`), /check constraint/);
});

test('case-insensitive uniqueness with display capitalization kept, plus look-alikes', {skip}, () => {
  const a = newUser(), b = newUser();
  assert.equal(setName(a, 'NorlinNomad264').status, 'ok');
  for (const n of ['norlinnomad264', 'NORLINNOMAD264', 'Norlin_Nomad264', 'Nor1inNomad264', 'NorIinNomad264', 'N0rlinNomad264'])
    assert.equal(setName(b, n).status, 'taken', n);
  assert.equal(checkName(b, 'norlinnomad264').status, 'taken');
  assert.equal(profile(a).username, 'NorlinNomad264');
  // owner may change capitalization anytime (not counted as a change)
  assert.equal(setName(a, 'NORLINnomad264').status, 'ok');
  assert.equal(setName(a, 'NorlinNomad264').status, 'ok');
});

test('simultaneous claims: exactly one of many concurrent requests wins', {skip}, async () => {
  const users = Array.from({length: 8}, () => newUser());
  const name = 'RaceToTheFlatirons';
  const run = uid => new Promise(res => {
    const p = spawn('psql', ['-X', '-q', '-At', '-d', DB]);
    let out = ''; p.stdout.on('data', d => out += d);
    p.on('close', () => res(out.trim()));
    p.stdin.end(`set role authenticated; set request.jwt.claim.sub = ${lit(uid)};
      begin; select public.set_username(${lit(name)})->>'status'; select pg_sleep(0.3); commit;`);
  });
  const results = await Promise.all(users.map(run));
  assert.equal(results.filter(r => r === 'ok').length, 1, results.join(','));
  assert.equal(results.filter(r => r === 'taken').length, users.length - 1);
  assert.equal(sql(`select count(*)::int c from public.profiles where lower(username) = lower(${lit(name)})`)[0].c, 1);
});

test('a slow commit holding a name blocks a look-alike claim until it resolves', {skip}, async () => {
  const a = newUser(), b = newUser();
  const run = (uid, nm, sleep) => new Promise(res => {
    const p = spawn('psql', ['-X', '-q', '-At', '-d', DB]); let out = '';
    p.stdout.on('data', d => out += d); p.on('close', () => res(out.trim()));
    p.stdin.end(`set role authenticated; set request.jwt.claim.sub = ${lit(uid)};
      begin; select public.set_username(${lit(nm)})->>'status'; select pg_sleep(${sleep}); commit;`);
  });
  const first = run(a, 'Hallett_Heron', 1.0);
  await new Promise(r => setTimeout(r, 300));
  const second = run(b, 'HallettHeron', 0);
  const [ra, rb] = await Promise.all([first, second]);
  assert.equal(ra, 'ok'); assert.equal(rb, 'taken');
});

// ---------------------------------------------------------------------------
test('moderation blocks profanity, slurs, sexual content, threats, targeted insults, accusations, impersonation and contact info', {skip}, () => {
  const misses = [];
  for (const [group, list] of Object.entries(BLOCKED)) for (const name of list) if (!problem(name)) misses.push(group + ': ' + rot13(name) + ' (rot13)');
  assert.deepEqual(misses, []);
});

test('moderation resists common evasion (case, underscores, leetspeak, repeated letters, digit padding)', {skip}, () => {
  const u = newUser();
  for (const name of BLOCKED.evasion.filter(x => /^[A-Za-z0-9_]{3,24}$/.test(x))) {
    freshLimits(u);
    const r = setName(u, name);
    assert.equal(r.status, 'guidelines', rot13(name) + ' (rot13)');
    assert.deepEqual(Object.keys(r), ['status'], 'no matched term or rule is revealed');
  }
  assert.equal(profile(u).username, null);
});

test('harmless names, identities, religions, nationalities and viewpoints are allowed', {skip}, () => {
  const wrong = fixtures.harmless.filter(name => problem(name));
  assert.deepEqual(wrong, []);
  const u = newUser();
  assert.equal(checkName(u, 'QueerFox').status, 'ok');
  assert.equal(setName(u, 'MuslimMaverick').status, 'ok');
});

test('check_username reports status only and is rate-limited', {skip}, () => {
  const u = newUser();
  const r = checkName(u, rot13('Shpx_Guvf'));
  assert.deepEqual(r, {status: 'guidelines'});
  let last;
  for (let i = 0; i < 60; i++) last = checkName(u, 'Some_Name' + i);
  assert.equal(last.status, 'rate_limited');
});

test('suggestions and submissions are rate-limited too', {skip}, () => {
  const u = newUser();
  let st;
  for (let i = 0; i < 11; i++) st = setName(u, 'Bad Name ' + i).status;
  assert.equal(st, 'rate_limited');
  exec(`delete from public.rate_events where user_id = ${lit(u)}`);
  for (let i = 0; i < 61; i++) st = rpc(u, 'suggest_username').status;
  assert.equal(st, 'rate_limited');
});

// ---------------------------------------------------------------------------
test('direct API writes cannot bypass moderation or touch name columns', {skip}, () => {
  const u = newUser(), other = newUser();
  const bad = rot13('Shpx_Guvf');
  denied(u, `update public.profiles set username = ${lit(bad)} where id = ${lit(u)} returning id`);
  denied(u, `update public.profiles set display_name = ${lit(bad)} where id = ${lit(u)} returning id`);
  denied(u, `update public.profiles set name_state = 'ok' where id = ${lit(u)} returning id`);
  denied(u, `update public.profiles set public_ref = gen_random_uuid() where id = ${lit(u)} returning id`);
  denied(u, `insert into public.profiles (id, username) values (${lit(u)}, 'Whatever') on conflict (id) do update set username = excluded.username returning id`);
  denied(u, `insert into public.profiles (id, display_name, dorm) values (${lit(u)}, ${lit(bad)}, 'Libby') on conflict (id) do update set display_name = excluded.display_name returning id`);
  // the old client's upsert of display_name now fails instead of saving an unmoderated name
  denied(u, `insert into public.profiles (id, display_name, dorm) values (${lit(u)}, 'Anything', 'Libby') on conflict (id) do update set display_name = excluded.display_name, dorm = excluded.dorm returning id`);
  // internal helpers and protected tables are off-limits
  denied(u, `select public.rr_apply_username(${lit(u)}, ${lit(bad)}, false, ${lit(u)})`);
  denied(u, `select public.rr_username_problem('x')`);
  denied(u, `select public.rr_username_match('x')`);
  for (const t of ['moderation_terms', 'moderation_exceptions', 'username_reports', 'moderation_audit', 'app_admins', 'username_blocked_names', 'rate_events'])
    denied(u, `select * from public.${t}`);
  denied(u, `insert into public.app_admins (user_id) values (${lit(u)}) returning user_id`);
  denied(u, `delete from public.moderation_terms returning id`);
  // anon can't use the nickname functions at all
  denied(null, `select public.check_username('Hello')`);
  denied(null, `select public.set_username('Hello')`);
  // dorm/team still works, only for yourself
  assert.equal(asUser(u, `update public.profiles set dorm = 'Baker Hall' where id = ${lit(u)} returning dorm`)[0].dorm, 'Baker Hall');
  assert.deepEqual(asUser(u, `update public.profiles set dorm = 'Baker Hall' where id = ${lit(other)} returning dorm`), []);
  assert.deepEqual(asUser(u, `select id from public.profiles where id = ${lit(other)}`), [], 'other profiles are not readable');
  assert.equal(profile(u).username, null);
});

test('the guard trigger still blocks name writes even if table grants are widened by mistake', {skip}, () => {
  const u = newUser();
  exec(`grant update on public.profiles to authenticated`);
  try {
    assert.throws(() => asUser(u, `update public.profiles set username = 'Sneaky_One' where id = ${lit(u)} returning id`), /set_username/);
  } finally { exec(`revoke update on public.profiles from authenticated; grant update (dorm) on public.profiles to authenticated`); }
});

test('administrator functions refuse students', {skip}, () => {
  const u = newUser();
  assert.equal(rpc(u, 'am_i_admin'), false);
  for (const call of [`public.admin_open_reports()`, `public.admin_open_reviews()`, `public.admin_audit_log(10)`, `public.admin_list_terms()`,
                      `public.admin_test_username('x')`, `public.admin_rescan_names()`, `public.admin_add_term('zzz','profanity','token')`,
                      `public.admin_moderate_name(gen_random_uuid(), 'hide')`, `public.admin_resolve_review(1, true)`])
    assert.throws(() => asUser(u, `select * from ${call}`), /Not authorized/, call);
});

// ---------------------------------------------------------------------------
function makeAdmin() { const a = newUser('mod@colorado.edu'); exec(`insert into public.app_admins (user_id) values (${lit(a)})`); return a; }
const refOf = uid => profile(uid).public_ref;

test('reports: one per reporter, never self, validated, and never auto-hide however many arrive', {skip}, () => {
  const target = newUser(); setName(target, 'ChautauquaCrow');
  const ref = refOf(target);
  const reporters = Array.from({length: 12}, () => newUser());
  for (const r of reporters) assert.equal(rpc(r, 'report_username', `${lit(ref)}, 'harassment', 'mean name'`).status, 'ok');
  assert.equal(rpc(reporters[0], 'report_username', `${lit(ref)}, 'other', null`).status, 'already_reported');
  assert.equal(rpc(target, 'report_username', `${lit(ref)}, 'other', null`).status, 'self');
  assert.equal(rpc(reporters[1], 'report_username', `${lit(refOf(legacy.valid))}, 'nonsense', null`).status, 'invalid');
  assert.equal(rpc(reporters[1], 'report_username', `${lit(refOf(legacy.valid))}, 'other', ${lit('x'.repeat(281))}`).status, 'invalid');
  assert.equal(rpc(reporters[1], 'report_username', `gen_random_uuid(), 'other', null`).status, 'not_found');
  assert.equal(profile(target).name_state, 'ok', '12 reports do not hide a name');
  assert.ok(asUser(reporters[2], `select name from public.get_weekly_leaderboard(50)`) !== null);
  // report rate limit
  const spammer = newUser(); const victims = Array.from({length: 11}, () => newUser());
  const st = victims.map(v => rpc(spammer, 'report_username', `${lit(refOf(v))}, 'other', null`).status);
  assert.equal(st.filter(s => s === 'ok').length, 10); assert.equal(st[10], 'rate_limited');
});

test('admin queue: require a change, hide a confirmed abusive name, audit trail, owner picks a replacement', {skip}, () => {
  const admin = makeAdmin();
  assert.equal(rpc(admin, 'am_i_admin'), true);
  const target = newUser(); setName(target, 'BluebirdBadger');
  const r1 = newUser(), r2 = newUser();
  rpc(r1, 'report_username', `${lit(refOf(target))}, 'impersonation', null`);
  rpc(r2, 'report_username', `${lit(refOf(target))}, 'impersonation', 'pretends to be my RA'`);
  const q = asUser(admin, `select * from public.admin_open_reports() where target_ref = ${lit(refOf(target))}`)[0];
  assert.equal(q.distinct_reporters, 2); assert.deepEqual(q.notes, ['pretends to be my RA']);

  // require a change: name stays visible until replaced
  assert.equal(rpc(admin, 'admin_moderate_name', `${lit(refOf(target))}, 'require_change', 'confusing'`).status, 'ok');
  assert.equal(profile(target).name_state, 'change_required');
  assert.equal(require('../username-core').needsPicker(profile(target)), true);
  assert.equal(sql(`select count(*)::int c from public.username_reports where target_user_id = ${lit(target)} and status = 'open'`)[0].c, 0);
  // the same name, a capitalization change or a look-alike doesn't satisfy the requirement
  for (const same of ['BluebirdBadger', 'bluebirdbadger', 'Bluebird_Badger']) assert.equal(setName(target, same).status, 'guidelines', same);
  assert.equal(profile(target).name_state, 'change_required');
  // a required change ignores the 7-day limit
  assert.equal(setName(target, 'BluebirdBadger2').status, 'ok');
  assert.equal(profile(target).name_state, 'ok');

  // confirmed abusive: hidden immediately, blocked for everyone (and look-alikes)
  const abuser = newUser(); setName(abuser, 'SewallSnake');
  exec(`insert into public.claims (user_id, segment_id) values (${lit(abuser)}, 'w9.0.0')`);
  exec(`update public.profiles set dorm = 'Sewall Hall' where id = ${lit(abuser)}`);
  rpc(r1, 'report_username', `${lit(refOf(abuser))}, 'harassment', null`);
  assert.equal(rpc(admin, 'admin_moderate_name', `${lit(refOf(abuser))}, 'hide', 'targets a student'`).closed_reports, 1);
  const p = profile(abuser);
  assert.equal(p.name_state, 'hidden'); assert.equal(p.username, 'SewallSnake', 'account and stored name kept for the record');
  const board = asUser(r1, `select name from public.get_leaderboard(100)`).map(x => x.name);
  assert.ok(!board.includes('SewallSnake')); assert.ok(board.includes('Buff ' + abuser.slice(0, 4).toUpperCase()));
  const other = newUser();
  assert.equal(setName(other, 'sewall_snake').status, 'guidelines', 'blocked name (look-alike) cannot be claimed');
  // owner chooses an approved replacement; account, team and activity preserved
  assert.equal(setName(abuser, 'SewallSparrow').status, 'ok');
  const after = profile(abuser);
  assert.equal(after.name_state, 'ok'); assert.equal(after.dorm, 'Sewall Hall');
  assert.equal(sql(`select count(*)::int c from public.claims where user_id = ${lit(abuser)}`)[0].c, 1);
  assert.equal(setName(other, 'SewallSnake').status, 'guidelines', 'still blocked after the owner moved on');

  const audit = asUser(admin, `select action from public.admin_audit_log(50)`).map(a => a.action);
  for (const a of ['admin_require_change', 'admin_hide', 'user_set_username']) assert.ok(audit.includes(a), a);
  denied(r1, `select * from public.admin_audit_log(5)`);
});

test('automated legacy flag: admin dismiss shows the name again', {skip}, () => {
  const admin = makeAdmin();
  assert.equal(profile(legacy.abusive).name_state, 'hidden');
  rpc(admin, 'admin_moderate_name', `${lit(refOf(legacy.abusive))}, 'dismiss', 'test only'`);
  assert.equal(profile(legacy.abusive).name_state, 'ok');
  rpc(admin, 'admin_moderate_name', `${lit(refOf(legacy.abusive))}, 'hide', 'restore the hide'`);
  assert.equal(profile(legacy.abusive).name_state, 'hidden');
});

test('review requests: rejected name can be appealed, approved and assigned; denied stays rejected', {skip}, () => {
  const admin = makeAdmin(), u = newUser(), v = newUser();
  const name = 'Dick_Tracy_Fan';           // blocked by the start-of-word rule, a plausible false positive
  assert.equal(setName(u, name).status, 'guidelines');
  assert.equal(rpc(u, 'request_username_review', `${lit('MesaMarmot')}, null`).status, 'not_needed');
  assert.equal(rpc(u, 'request_username_review', `${lit(name)}, 'the comic detective'`).status, 'ok');
  assert.equal(rpc(u, 'request_username_review', `${lit(name)}, null`).status, 'already_open');
  assert.deepEqual(asUser(u, `select requested_name, status from public.username_review_requests`), [{requested_name: name, status: 'open'}]);
  assert.deepEqual(asUser(v, `select requested_name from public.username_review_requests`), [], 'others cannot see it');
  const q = asUser(admin, `select * from public.admin_open_reviews() where user_id = ${lit(u)}`)[0];
  assert.equal(q.matched_category, 'sexual'); assert.equal(q.available, true);
  assert.equal(rpc(admin, 'admin_resolve_review', `${q.id}, true, 'fine in context'`).assigned, 'ok');
  assert.equal(profile(u).username, name);
  assert.equal(asUser(u, `select status from public.username_review_requests`)[0].status, 'approved');
  // deny path
  const w = newUser();
  rpc(w, 'request_username_review', `${lit(rot13('Shpx_Guvf'))}, null`);
  const q2 = asUser(admin, `select id from public.admin_open_reviews() where user_id = ${lit(w)}`)[0];
  rpc(admin, 'admin_resolve_review', `${q2.id}, false, null`);
  assert.equal(setName(w, rot13('Shpx_Guvf')).status, 'guidelines');
});

test('admin policy controls: add a term, test it, re-scan queues (does not hide) existing names', {skip}, () => {
  const admin = makeAdmin(), u = newUser();
  assert.equal(setName(u, 'Zorblax_Fan').status, 'ok');
  assert.equal(rpc(admin, 'admin_add_term', `'zorblax', 'harassment', 'substring', 'test term'`).status, 'ok');
  assert.equal(rpc(admin, 'admin_add_term', `'(((', 'harassment', 'regex', null`).status, 'invalid');
  const t = asUser(admin, `select * from public.admin_test_username('Zorblax_Fan')`)[0];
  assert.equal(t.category, 'harassment'); assert.equal(t.term, 'zorblax');
  assert.ok(rpc(admin, 'admin_rescan_names').queued >= 1);
  assert.equal(profile(u).name_state, 'ok', 're-scan never hides by itself');
  assert.equal(rpc(admin, 'admin_add_exception', `'zorblax', 'token', null`).status, 'ok');
  assert.equal(problem('Zorblax_Fan'), null);
});

// ---------------------------------------------------------------------------
test('changing a nickname keeps memberships and history; 7-day limit; old name held 30 days', {skip}, () => {
  const u = newUser(), v = newUser();
  assert.equal(setName(u, 'KittredgeKestrel').status, 'ok');
  exec(`update public.profiles set dorm = 'Kittredge West' where id = ${lit(u)};
        insert into public.claims (user_id, segment_id) values (${lit(u)}, 'w55.0.0'), (${lit(u)}, 'w55.0.1');
        insert into public.weekly_zone_points (user_id, week, zone, segments) values (${lit(u)}, public.rr_week(), 'norlin', 4);
        insert into public.path_names (path_id, name, named_by) values ('w55', 'Kestrel Cut', ${lit(u)});`);
  const before = asUser(v, `select rank, segments from public.get_weekly_leaderboard(100) where name = 'KittredgeKestrel'`)[0];
  assert.ok(before);
  // the first pick is free; a second change within 7 days is limited
  assert.equal(setName(u, 'KittredgeKestrel7').status, 'ok');
  const soon = setName(u, 'KittredgeKestrel8');
  assert.equal(soon.status, 'too_soon'); assert.ok(soon.next_at);
  exec(`update public.profiles set username_changed_at = now() - interval '8 days' where id = ${lit(u)}`);
  assert.equal(setName(u, 'KestrelOfKittredge').status, 'ok');
  // same rank, same team, same claims, same path name author
  const after = asUser(v, `select rank, segments from public.get_weekly_leaderboard(100) where name = 'KestrelOfKittredge'`)[0];
  assert.deepEqual(after, before);
  assert.equal(profile(u).dorm, 'Kittredge West');
  assert.equal(sql(`select count(*)::int c from public.claims where user_id = ${lit(u)}`)[0].c, 2);
  const pn = asUser(v, `select named_by_name from public.get_path_names() where path_id = 'w55'`)[0];
  assert.equal(pn.named_by_name, 'KestrelOfKittredge');
  // the name just given up can't be grabbed by someone else for 30 days...
  assert.equal(setName(v, 'KittredgeKestrel7').status, 'taken');
  // ...and no one else can see the history
  assert.ok(asUser(v, `select * from public.get_path_names()`).every(r => !JSON.stringify(r).includes('KittredgeKestrel7')));
});

test('account deletion removes nickname, reports against it, and scrubs names from the audit trail', {skip}, () => {
  const u = newUser(), r = newUser();
  setName(u, 'DeleteMeDrifter');
  rpc(r, 'report_username', `${lit(refOf(u))}, 'other', null`);
  rpc(u, 'delete_my_account');
  assert.equal(sql(`select count(*)::int c from public.username_reports where reported_name = 'DeleteMeDrifter'`)[0].c, 0);
  assert.equal(sql(`select count(*)::int c from public.moderation_audit where detail::text like '%DeleteMeDrifter%'`)[0].c, 0);
  assert.equal(setName(r, 'DeleteMeDrifter').status, 'ok', 'name is free again');
});
