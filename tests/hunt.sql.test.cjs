// Database tests for Find the Herd: Competition Mode check-ins and scoring, the
// zero-storage guarantees of Friends Mode, anonymous counters, the admin editor,
// standings, the demo wallet and account deletion.
// Runs every migration against a real PostgreSQL server (with the small Supabase
// stand-in in tests/supabase-shim.sql) and calls the functions the way the app's
// API does: as "anon" or as "authenticated" with a JWT subject and email.
//
//   node --test tests/hunt.sql.test.cjs
//
// Needs `psql` and a server you can create databases on (PG* environment variables).
// The test database is RR_HUNT_DB (default rr_hunt_test); it is dropped and recreated.
// Skips itself if no server is reachable.
const {test, before} = require('node:test');
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../herd-core');
const bundle = require('../herd-editions');

const ROOT = path.join(__dirname, '..');
const DB = process.env.RR_HUNT_DB || 'rr_hunt_test';
const MIG = path.join(ROOT, 'supabase', 'migrations');

function psql(args, input) {
  return spawnSync('psql', ['-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', ...args], {input, encoding: 'utf8'});
}
const reachable = (() => { try { return psql(['-d', 'postgres', '-c', 'select 1']).status === 0; } catch (e) { return false; } })();
const skip = reachable ? false : 'no PostgreSQL server reachable (set PGHOST/PGUSER, or run on a machine with Postgres)';

const lit = v => v === null || v === undefined ? 'null' : typeof v === 'boolean' || typeof v === 'number' ? String(v) : "'" + String(v).replace(/'/g, "''") + "'";
function sql(text) {
  const r = psql(['-d', DB], `with t as (${text}) select coalesce(json_agg(t), '[]') from t;`);
  if (r.status !== 0) throw new Error(r.stderr.trim());
  return JSON.parse(r.stdout.trim());
}
function exec(text) { const r = psql(['-d', DB], text); if (r.status !== 0) throw new Error(r.stderr.trim()); return r.stdout; }
// The way the REST API runs a request: as anon, or as a signed-in user with their JWT claims.
const users = {};   // id -> email
function as(uid, text, claimEmail) {
  const email = claimEmail !== undefined ? claimEmail : users[uid];
  const pre = uid
    ? `set role authenticated; set request.jwt.claim.sub = ${lit(uid)}; set request.jwt.claims = ${lit(JSON.stringify({sub: uid, email, role: 'authenticated'}))};`
    : `set role anon; set request.jwt.claims = '{"role":"anon"}';`;
  const r = psql(['-d', DB], `${pre}\nwith t as (${text}) select coalesce(json_agg(t), '[]') from t;`);
  if (r.status !== 0) { const e = new Error(r.stderr.replace(/^psql:[^:]*:\d+: /gm, '').trim()); e.sqlError = true; throw e; }
  return JSON.parse(r.stdout.trim());
}
const rpc = (uid, fn, args = '') => as(uid, `select public.${fn}(${args}) as r`)[0].r;
const denied = (uid, text, msg) => assert.throws(() => as(uid, text), e => e.sqlError, msg || 'expected the database to refuse: ' + text);
let n = 0;
function newUser(email, opts = {}) {
  n++; email = email || `player${n}@colorado.edu`;
  const id = sql(`insert into auth.users (email, email_confirmed_at) values (${lit(email)}, ${opts.unconfirmed ? 'null' : 'now()'}) returning id`)[0].id;
  users[id] = email;
  if (opts.dorm) exec(`update public.profiles set dorm = ${lit(opts.dorm)} where id = ${lit(id)}`);
  return id;
}
const count = (table, where = 'true') => sql(`select count(*)::int c from public.${table} where ${where}`)[0].c;
const HUNT_TABLES = ['hunt_teams', 'hunt_members', 'hunt_team_puzzles', 'hunt_checkins', 'hunt_reward_tokens'];
const playerRows = () => Object.fromEntries(HUNT_TABLES.map(t => [t, count(t)]));

// A route with answers the tests know (the real demo answers are not in the repository).
const ANS = {1: 'Alpha One', 2: '42', 3: 'gamma', 4: 'delta', 5: 'omega'};
const testDoc = (answers = ANS, title = 'Test Route') => ({
  title, theme: 'Testing', style: 'Unit', intro: 'For automated tests.', demo: true,
  puzzles: ['norlin-quad', 'macky-south', 'old-main', 'rippon-outside', 'umc-terrace'].map((cp, i) => ({
    no: i + 1, checkpoint: cp, kind: i === 2 ? 'split' : 'observe', format: 'A word', prompt: 'Test prompt ' + (i + 1),
    hints: ['first hint', 'second hint'], pieces: i === 2 ? ['piece a', 'piece b'] : [], answers: [answers[i + 1], 'alt ' + (i + 1)]}))
});
const createTeam = (uid, name = 'Quad Squad', edition = 'test-1', avatar = 'fox') => rpc(uid, 'hunt_create_team', `${lit(edition)}, ${lit(name)}, ${lit(avatar)}`);
const checkIn = (uid, team, cp, inside = true, answer = ANS[cp]) => rpc(uid, 'hunt_check_in', `${lit(team)}, ${cp}, ${inside === null ? 'null' : inside}, ${lit(answer)}`);
const finish = (uid, team, from = 1) => { let r; for (let cp = from; cp <= 5; cp++) r = checkIn(uid, team, cp); return r; };

let admin;
before(() => {
  if (skip) return;
  psql(['-d', 'postgres', '-c', `drop database if exists ${DB}`]);
  const c = psql(['-d', 'postgres', '-c', `create database ${DB}`]);
  if (c.status !== 0) throw new Error(c.stderr);
  const apply = f => { const r = psql(['-d', DB, '--single-transaction', '-f', f]); if (r.status !== 0) throw new Error(path.basename(f) + ': ' + r.stderr); };
  apply(path.join(__dirname, 'supabase-shim.sql'));
  fs.readdirSync(MIG).filter(f => f.endsWith('.sql')).sort().forEach(f => apply(path.join(MIG, f)));
  admin = newUser('hunt.admin@colorado.edu');
  exec(`insert into public.admin_allowlist (email) values ('hunt.admin@colorado.edu')`);
  const r = rpc(admin, 'hunt_admin_publish', `'test-1', ${lit(JSON.stringify(testDoc()))}::jsonb`);
  assert.deepEqual(r, {status: 'ok', version: 1});
  rpc(admin, 'hunt_admin_set_status', `'test-1', 'active'`);
});

// ---------------------------------------------------------------------------
test('seed: three active demo routes, identical to the copy the app carries, flagged for on-site checks', {skip}, () => {
  const eds = rpc(null, 'hunt_get_editions').filter(e => e.id.startsWith('demo-'));
  assert.equal(eds.length, 3);
  const canon = x => JSON.stringify(x, (k, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(key => [key, v[key]])) : v);
  eds.forEach((e, i) => {
    assert.equal(canon(e), canon(bundle.editions[i].content), e.id + ': database and bundled copy match');
    assert.ok(e.checkpoints.every(c => c.needs_onsite_check === true && c.puzzle.needs_onsite_check === true));
    const key = sql(`select answer_key from public.hunt_edition_versions where edition_id = ${lit(e.id)} and version = 1`)[0].answer_key;
    assert.equal(canon(key), canon(bundle.editions[i].key));
  });
  assert.equal(count('hunt_checkpoints', 'needs_onsite_check'), 5, 'every seeded coordinate is flagged');
  const text = JSON.stringify(rpc(null, 'hunt_get_editions'));
  for (const leak of ['"answers"', 'answer_salt', 'answer_hashes', 'answer_key', '"salt"', '"hashes"']) assert.ok(!text.includes(leak), 'players never receive ' + leak);
  assert.ok(!/[0-9a-f]{32}/.test(text), 'no salts or hashes in what players download');
});

test('answers are checked against salted hashes with the same normalization as the phone', {skip}, async () => {
  for (const [input, ok] of [['alpha one', true], ['ALPHA-ONE!', true], ['  Alpha   One ', true], ['alt 1', true], ['alpha two', false], ['', false], ['!!!', false]])
    assert.equal(rpc(null, 'hunt_check_answer', `'test-1', 1, 1, ${lit(input)}`), ok, JSON.stringify(input));
  assert.equal(rpc(null, 'hunt_check_answer', `'test-1', 1, 2, 'alpha one'`), false, 'an answer only fits its own checkpoint');
  assert.equal(rpc(null, 'hunt_check_answer', `'nope', 1, 1, 'alpha one'`), false);
  const key = sql(`select answer_key from public.hunt_edition_versions where edition_id = 'test-1' and version = 1`)[0].answer_key;
  assert.equal(await core.checkAnswerLocal(key['1'], 'Alpha one'), true, 'herd-core.js and the database agree on the hash');
  assert.equal(sql(`select public.hunt_norm_answer('Réd  Brick-9') as x`)[0].x, core.normalizeAnswer('Réd  Brick-9'));
  // the plain answers are nowhere in the database
  const dump = JSON.stringify(sql(`select content, answer_key, doc from public.hunt_edition_versions where edition_id = 'test-1'`)).toLowerCase();
  for (const a of ['alpha one', 'gamma', 'omega', 'alt 3']) assert.ok(!dump.includes(a), 'plain answer is not stored: ' + a);
});

test('lockdown: no hunt table can be read or written through the API, by anyone', {skip}, () => {
  const u = newUser();
  for (const t of [...HUNT_TABLES, 'hunt_checkpoints', 'hunt_editions', 'hunt_edition_versions', 'hunt_metrics', 'admin_allowlist']) {
    for (const who of [null, u]) {
      denied(who, `select * from public.${t} limit 1`);
      denied(who, `delete from public.${t} returning 1`);
    }
    assert.equal(sql(`select relrowsecurity r from pg_class where oid = 'public.${t}'::regclass`)[0].r, true, t + ' has RLS on');
  }
  denied(u, `insert into public.admin_allowlist (email) values ('me@colorado.edu') returning 1`, 'no self-signup as admin');
  denied(u, `insert into public.hunt_checkins (team_id, user_id, edition_id, checkpoint_id, checkpoint_no, in_geofence) values (gen_random_uuid(), '${u}', 'test-1', 'x', 1, true) returning 1`);
  for (const fn of [`hunt_publish_internal('test-1', '{}'::jsonb)`, `hunt_forget_user('${u}')`, `hunt_recompute(gen_random_uuid())`, `hunt_answer_ok('test-1', 1, 1, 'x')`,
                    `hunt_hash_answer('a', 'b')`, `hunt_verified_email()`, `hunt_team_summary(gen_random_uuid(), '${u}')`])
    denied(u, `select public.${fn}`, 'internal function is not callable: ' + fn);
  for (const fn of ['hunt_create_team(\'test-1\', \'Abc\', \'fox\')', 'hunt_my_wallet()', 'hunt_whoami()', 'hunt_admin_overview()', 'delete_my_account()'])
    denied(null, `select public.${fn}`, 'signed-out callers cannot call ' + fn);
});

test('what the server can store: exactly the listed columns, and nowhere to put a coordinate', {skip}, () => {
  const cols = t => sql(`select column_name c from information_schema.columns where table_schema = 'public' and table_name = ${lit(t)} order by 1`).map(r => r.c);
  assert.deepEqual(cols('hunt_checkins'), ['checkpoint_id', 'checkpoint_no', 'completed_at', 'edition_id', 'in_geofence', 'team_id', 'user_id']);
  assert.deepEqual(cols('hunt_teams'), ['avatar', 'edition_id', 'edition_version', 'final_score', 'id', 'puzzles_solved', 'roster_locked', 'team_name', 'week']);
  assert.deepEqual(cols('hunt_members'), ['counts', 'cu_verified', 'edition_id', 'team_id', 'user_id']);
  assert.deepEqual(cols('hunt_team_puzzles'), ['checkpoint_no', 'hints_used', 'points', 'solved', 'team_id']);
  assert.deepEqual(cols('hunt_reward_tokens'), ['edition_id', 'issued_week', 'kind', 'status', 'team_id', 'token', 'used_at', 'user_id']);
  assert.deepEqual(cols('hunt_metrics'), ['count', 'edition_id', 'metric_key'], 'counters carry no user id and no timestamp');
  const all = HUNT_TABLES.flatMap(cols).join(' ');
  assert.ok(!/lat|lng|lon|coord|accuracy|geo(?!fence)|position|email|ip/.test(all.replace(/in_geofence/g, '')), 'no location, email or IP columns');
  const args = sql(`select pg_get_function_identity_arguments('public.hunt_check_in'::regproc) a`)[0].a;
  assert.equal(args, 'p_team uuid, p_checkpoint integer, p_in_geofence boolean, p_answer text', 'the check-in takes a yes/no, never coordinates');
  denied(newUser(), `select public.hunt_check_in(gen_random_uuid(), 1, true, 'x', 40.0, -105.2)`, 'extra coordinate arguments are rejected');
});

test('Friends Mode and Demo Practice: read-only calls write no row about anyone', {skip}, () => {
  const before = playerRows(), metricsBefore = sql(`select coalesce(sum(count), 0)::int s, count(*)::int rows from public.hunt_metrics`)[0];
  const rateBefore = count('rate_events');
  for (let i = 0; i < 3; i++) {
    rpc(null, 'hunt_get_editions'); rpc(null, 'hunt_get_edition_version', `'demo-1', 1`);
    rpc(null, 'hunt_check_answer', `'demo-1', 1, 1, 'guess'`); rpc(null, 'hunt_check_answer', `'test-1', 1, 2, '42'`);
    rpc(null, 'hunt_standings', `'demo-1'`);
  }
  assert.deepEqual(playerRows(), before, 'no team, member, check-in, puzzle or token rows appear');
  assert.equal(count('rate_events'), rateBefore, 'no per-user event rows either');
  assert.deepEqual(sql(`select coalesce(sum(count), 0)::int s, count(*)::int rows from public.hunt_metrics`)[0], metricsBefore, 'and reading never touches a counter');
  assert.equal(count('profiles'), Object.keys(users).length, 'no accounts created');
});

test('anonymous counters: a number goes up by one — no ids, no timestamps, no new rows', {skip}, () => {
  const rows = count('hunt_metrics');
  const get = k => sql(`select count from public.hunt_metrics where edition_id = 'demo-2' and metric_key = ${lit(k)}`)[0].count;
  assert.equal(get('views'), 0);
  rpc(null, 'increment_hunt_metric', `'demo-2', 'views'`); rpc(null, 'increment_hunt_metric', `'demo-2', 'views'`);
  rpc(newUser(), 'increment_hunt_metric', `'demo-2', 'checkpoint_3_completions'`);
  assert.equal(get('views'), 2); assert.equal(get('checkpoint_3_completions'), 1); assert.equal(get('starts'), 0);
  rpc(null, 'increment_hunt_metric', `'demo-2', 'hunt_viewed_by_zach'`); rpc(null, 'increment_hunt_metric', `'no-such-route', 'views'`);
  assert.equal(count('hunt_metrics'), rows, 'unknown keys or routes do nothing; counters are a fixed set of rows');
  assert.deepEqual(sql(`select metric_key k from public.hunt_metrics where edition_id = 'demo-2' order by 1`).map(r => r.k), [...core.METRIC_KEYS].sort());
  exec(`update public.hunt_metrics set count = 0`);
});

// ---------------------------------------------------------------------------
test('solo competitive run: geofence yes/no + answer, hints, 600 max, one demo token', {skip}, () => {
  const u = newUser(null, {dorm: 'Libby Hall'});
  assert.deepEqual(rpc(u, 'hunt_whoami'), {signed_in: true, cu_verified: true, admin: false, nickname: 'Buff ' + u.slice(0, 4).toUpperCase(), affiliation: 'Libby Hall'});
  const t = createTeam(u, 'Solo Stroll');
  assert.equal(t.status, 'ok'); assert.equal(t.counts, true); assert.equal(t.cu_verified, true); assert.equal(t.edition_version, 1);
  const team = t.team_id, base = playerRows();

  // refused check-ins store nothing
  assert.equal(checkIn(u, team, 1, false).status, 'not_in_geofence');
  assert.equal(checkIn(u, team, 1, null).status, 'not_in_geofence', 'a missing yes/no is a no');
  assert.equal(checkIn(u, team, 1, true, 'wrong').status, 'wrong_answer');
  assert.equal(checkIn(u, team, 1, true, ANS[2]).status, 'wrong_answer');
  assert.deepEqual(playerRows(), base, 'a refused check-in leaves no trace');
  assert.equal(rpc(u, 'hunt_my_run', `'test-1'`).team_score, 0);

  let r = checkIn(u, team, 1, true, ' alpha-ONE ');
  assert.equal(r.status, 'ok'); assert.equal(r.my_points, 100); assert.equal(r.team_score, 100); assert.equal(r.roster_locked, true); assert.equal(r.completed, false);
  const row = sql(`select * from public.hunt_checkins where team_id = '${team}'`)[0];
  assert.equal(row.in_geofence, true); assert.equal(row.checkpoint_id, 'norlin-quad'); assert.equal(row.edition_id, 'test-1'); assert.ok(row.completed_at);

  // hints: 20 off each, at most two, never below 60; no effect once solved
  assert.deepEqual(rpc(u, 'hunt_use_hint', `'${team}', 1`), {status: 'solved', hints_used: 0});
  assert.deepEqual(rpc(u, 'hunt_use_hint', `'${team}', 2`), {status: 'ok', hints_used: 1});
  assert.equal(checkIn(u, team, 2).my_points, 180);
  rpc(u, 'hunt_use_hint', `'${team}', 3`); assert.deepEqual(rpc(u, 'hunt_use_hint', `'${team}', 3`), {status: 'ok', hints_used: 2});
  assert.deepEqual(rpc(u, 'hunt_use_hint', `'${team}', 3`), {status: 'max', hints_used: 2});
  assert.equal(checkIn(u, team, 3).my_points, 240, '100 + 80 + 60');
  r = checkIn(u, team, 4); assert.equal(r.my_points, 340); assert.equal(r.reward_token, null);
  r = checkIn(u, team, 5);
  assert.equal(r.status, 'ok'); assert.equal(r.completed, true); assert.equal(r.my_points, 540, '100+80+60+100+100 plus the 100 finish bonus');
  assert.equal(r.team_score, 540); assert.equal(r.puzzles_solved, 5);
  assert.match(r.reward_token, /^DEMO-[0-9A-F]{12}$/);
  assert.deepEqual(playerRows(), {hunt_teams: base.hunt_teams, hunt_members: base.hunt_members, hunt_team_puzzles: base.hunt_team_puzzles + 5,
    hunt_checkins: base.hunt_checkins + 5, hunt_reward_tokens: base.hunt_reward_tokens + 1});

  // a clean run is exactly 600
  const v = newUser(); const t2 = createTeam(v, 'Clean Sweep').team_id;
  assert.equal(finish(v, t2).team_score, 600);
  assert.deepEqual(sql(`select puzzles_solved, final_score from public.hunt_teams where id = '${t2}'`)[0], {puzzles_solved: 5, final_score: 600});
});

test('duplicate submissions are idempotent: same answer back, no second row, no second token', {skip}, () => {
  const u = newUser(); const team = createTeam(u, 'Double Tap').team_id;
  const first = checkIn(u, team, 1);
  const rows = playerRows();
  for (let i = 0; i < 3; i++) {
    const again = checkIn(u, team, 1);
    assert.equal(again.status, 'already'); assert.equal(again.my_points, first.my_points); assert.equal(again.team_score, first.team_score);
  }
  assert.equal(checkIn(u, team, 1, false, 'whatever').status, 'already', 'a repeat can’t undo or change a check-in');
  assert.deepEqual(playerRows(), rows);
  const done = finish(u, team, 2), token = done.reward_token;
  for (let i = 0; i < 3; i++) {
    const again = checkIn(u, team, 5);
    assert.equal(again.status, 'already'); assert.equal(again.reward_token, token, 'the same token, not a new one'); assert.equal(again.my_points, 600);
  }
  assert.equal(count('hunt_reward_tokens', `user_id = '${u}'`), 1);
  assert.equal(count('hunt_checkins', `user_id = '${u}'`), 5);
  // two simultaneous submissions (double tap on a slow connection)
  const w = newUser(); const t2 = createTeam(w, 'Race Cond').team_id;
  const input = `set role authenticated; set request.jwt.claim.sub = '${w}'; set request.jwt.claims = '${JSON.stringify({sub: w, email: users[w]})}'; select public.hunt_check_in('${t2}', 1, true, '${ANS[1]}') ->> 'status';`;
  const {spawn} = require('node:child_process');
  return Promise.all([0, 1, 2, 3].map(() => new Promise(res => { const p = spawn('psql', ['-X', '-q', '-At', '-d', DB]); let out = ''; p.stdout.on('data', d => out += d); p.on('close', () => res(out.trim())); p.stdin.end(input); })))
    .then(results => {
      assert.deepEqual(results.sort(), ['already', 'already', 'already', 'ok']);
      assert.equal(count('hunt_checkins', `team_id = '${t2}'`), 1);
      assert.equal(sql(`select final_score s from public.hunt_teams where id = '${t2}'`)[0].s, 100);
    });
});

test('wallet: a demo token is single-use and is plainly not redeemable for anything', {skip}, () => {
  const u = newUser(), other = newUser(); const team = createTeam(u, 'Token Test').team_id;
  const token = finish(u, team).reward_token;
  const w = rpc(u, 'hunt_my_wallet');
  assert.equal(w.length, 1); assert.deepEqual(Object.keys(w[0]).sort(), ['edition_id', 'kind', 'status', 'title', 'token', 'week']);
  assert.equal(w[0].kind, 'demo'); assert.equal(w[0].status, 'issued'); assert.equal(w[0].token, token);
  assert.deepEqual(rpc(other, 'hunt_my_wallet'), [], 'tokens are private to their owner');
  assert.deepEqual(rpc(other, 'hunt_use_token', lit(token)), {status: 'not_found'}, 'nobody else can use it');
  assert.deepEqual(rpc(u, 'hunt_use_token', lit(token)), {status: 'ok'});
  assert.deepEqual(rpc(u, 'hunt_use_token', lit(token)), {status: 'already_used'});
  assert.equal(rpc(u, 'hunt_my_wallet')[0].status, 'used');
  denied(u, `insert into public.hunt_reward_tokens (user_id, edition_id, issued_week) values ('${u}', 'demo-1', current_date) returning 1`, 'tokens can’t be minted through the API');
  assert.equal(sql(`select count(*)::int c from information_schema.check_constraints where constraint_schema = 'public' and check_clause like '%demo%' and check_clause like '%kind%'`)[0].c >= 1, true, 'only demo tokens exist in Phase 1');
});

test('team names are moderated like nicknames; avatars come from a fixed set', {skip}, () => {
  const u = newUser();
  for (const bad of ['ab', 'x'.repeat(25), 'Name!', '12345', 'emoji 🦬', 'Zach@colorado.edu', 'under_score'])
    assert.equal(createTeam(u, bad).status === 'ok', false, 'rejected: ' + JSON.stringify(bad));
  assert.equal(createTeam(u, 'Name!').status, 'name_format');
  const rot13 = s => s.replace(/[a-z]/gi, c => String.fromCharCode((c <= 'Z' ? 90 : 122) >= (c = c.charCodeAt(0) + 13) ? c : c - 26));
  for (const rude of ['Fuvg Urnqf', 'gur shpxref', 'FUVG']) assert.equal(createTeam(u, rot13(rude)).status, 'name_guidelines');
  assert.equal(createTeam(u, 'Quad Squad', 'test-1', 'dragon').status, 'bad_avatar');
  assert.equal(createTeam(u, 'Quad Squad', 'no-such-route').status, 'unavailable');
  const ok = createTeam(u, '  Libby   Legends 2 ');
  assert.equal(ok.status, 'ok'); assert.equal(ok.team_name, 'Libby Legends 2', 'spacing is tidied');
  assert.equal(rpc(u, 'hunt_leave_team', `'${ok.team_id}'`).status, 'left');
  assert.equal(count('hunt_teams', `id = '${ok.team_id}'`), 0, 'an abandoned, empty team leaves nothing behind');
});

// ---------------------------------------------------------------------------
test('teams: everyone needs their own check-in, the roster freezes at the first completed checkpoint, the score is an average', {skip}, () => {
  const [a, b, c, late] = [newUser(), newUser(), newUser(), newUser()];
  const team = createTeam(a, 'Kittredge Crew').team_id;
  assert.equal(rpc(b, 'hunt_join_team', `'${team}'`).status, 'ok');
  assert.equal(rpc(c, 'hunt_join_team', `'${team}'`).status, 'ok');
  assert.equal(rpc(c, 'hunt_join_team', `'${team}'`).status, 'ok', 'joining twice is harmless');
  assert.equal(count('hunt_members', `team_id = '${team}'`), 3);
  assert.equal(rpc(late, 'hunt_join_team', `'${crypto.randomUUID()}'`).status, 'not_found');
  assert.equal(checkIn(late, team, 1).status, 'not_member', 'knowing a team id is not membership');
  assert.equal(rpc(late, 'hunt_use_hint', `'${team}', 1`).status, 'not_member');

  // A solves checkpoint 1 with one hint → 80 for A; the team is the average of players who checked in (just A)
  rpc(b, 'hunt_use_hint', `'${team}', 1`);
  let r = checkIn(a, team, 1);
  assert.equal(r.my_points, 80); assert.equal(r.team_score, 80); assert.equal(r.roster_locked, true);
  // roster is frozen now
  assert.equal(rpc(late, 'hunt_join_team', `'${team}'`).status, 'roster_locked');
  // B is elsewhere: the puzzle being solved isn't B's attendance
  assert.equal(checkIn(b, team, 1, false, ANS[1]).status, 'not_in_geofence');
  assert.equal(rpc(b, 'hunt_my_run', `'test-1'`).my_points, 0);
  // B arrives: no answer needed any more (the herd shared it), but B must be inside the checkpoint
  r = checkIn(b, team, 1, true, null);
  assert.equal(r.status, 'ok'); assert.equal(r.my_points, 80); assert.equal(r.team_score, 80, 'two players with 80 each');
  // A carries on alone to checkpoint 2
  r = checkIn(a, team, 2);
  assert.equal(r.my_points, 180); assert.equal(r.team_score, 130, 'average of 180 and 80; C has not checked in anywhere so is not counted');
  r = checkIn(c, team, 2, true, null);
  assert.equal(r.my_points, 100); assert.equal(r.team_score, 120, 'average of 180, 80 and 100');
  assert.equal(r.players, 3); assert.equal(r.puzzles_solved, 2);

  // a full herd of five finishing cleanly scores exactly what a solo player does
  const five = [newUser(), newUser(), newUser(), newUser(), newUser()];
  const big = createTeam(five[0], 'Five Alive').team_id;
  five.slice(1).forEach(u => rpc(u, 'hunt_join_team', `'${big}'`));
  let last; five.forEach(u => { last = finish(u, big); });
  assert.equal(last.team_score, 600); assert.equal(count('hunt_reward_tokens', `team_id = '${big}'`), 5, 'each finisher gets their own token');
  const solo = newUser(); assert.equal(finish(solo, createTeam(solo, 'Party Of One').team_id).team_score, 600);
  // a herd is capped at eight
  const cap = [...Array(9)].map(() => newUser()); const capTeam = createTeam(cap[0], 'Big Herd').team_id;
  cap.slice(1, 8).forEach(u => assert.equal(rpc(u, 'hunt_join_team', `'${capTeam}'`).status, 'ok'));
  assert.equal(rpc(cap[8], 'hunt_join_team', `'${capTeam}'`).status, 'full');
});

test('leaving mid-hunt: personal credit stays, and the player can finish solo', {skip}, () => {
  const [a, b] = [newUser(), newUser()];
  const team = createTeam(a, 'Split Up').team_id; rpc(b, 'hunt_join_team', `'${team}'`);
  checkIn(a, team, 1); checkIn(b, team, 1, true, null);
  assert.equal(rpc(b, 'hunt_leave_team', `'${team}'`).status, 'kept');
  assert.equal(count('hunt_checkins', `user_id = '${b}'`), 1, 'credit is kept');
  // B finishes alone; A stops. B's phone can recover the run from the server.
  const run = rpc(b, 'hunt_my_run', `'test-1'`);
  assert.equal(run.team_id, team); assert.deepEqual(run.my_checkpoints, [1]); assert.equal(run.content.id, 'test-1');
  const done = finish(b, team, 2);
  assert.equal(done.completed, true); assert.equal(done.my_points, 600); assert.match(done.reward_token, /^DEMO-/);
  assert.equal(done.team_score, 350, 'average of B (600) and A (100): the frozen roster still counts A');
});

test('an edit mid-run never breaks a run: it stays on the version it started with', {skip}, () => {
  const u = newUser(); const t = createTeam(u, 'Version Lock');
  assert.equal(t.edition_version, 1);
  checkIn(u, t.team_id, 1);
  // the administrator changes every answer and a prompt, and moves a checkpoint
  const NEW = {1: 'new1', 2: 'new2', 3: 'new3', 4: 'new4', 5: 'new5'};
  assert.equal(rpc(admin, 'hunt_admin_publish', `'test-1', ${lit(JSON.stringify(testDoc(NEW, 'Test Route (edited)')))}::jsonb`).version, 2);
  const moved = rpc(admin, 'hunt_admin_save_checkpoint', lit(JSON.stringify({id: 'old-main', name: 'Old Main', spot: 'By the bell', lat: 40.00925, lng: -105.2731, radius_m: 30, needs_onsite_check: false})) + '::jsonb');
  assert.ok(moved.republished.some(x => x.id === 'test-1' && x.version === 3), 'routes using the checkpoint are republished');
  assert.equal(sql(`select current_version v from public.hunt_editions where id = 'demo-1'`)[0].v, 2);
  // the run in progress still accepts the answers it started with, and still sees its own route
  assert.equal(checkIn(u, t.team_id, 2, true, NEW[2]).status, 'wrong_answer');
  assert.equal(checkIn(u, t.team_id, 2, true, ANS[2]).status, 'ok');
  assert.equal(rpc(u, 'hunt_my_run', `'test-1'`).content.title, 'Test Route');
  assert.equal(rpc(null, 'hunt_get_edition_version', `'test-1', 1`).checkpoints[2].radius_m, 35, 'old versions are immutable');
  assert.equal(finish(u, t.team_id, 3).team_score, 600);
  // a new run gets the new version, new answers and the moved checkpoint
  const v = newUser(); const t2 = createTeam(v, 'Fresh Start');
  assert.equal(t2.edition_version, 3);
  assert.equal(checkIn(v, t2.team_id, 1, true, ANS[1]).status, 'wrong_answer');
  assert.equal(checkIn(v, t2.team_id, 1, true, NEW[1]).status, 'ok');
  const cur = rpc(null, 'hunt_get_editions').find(e => e.id === 'test-1');
  assert.equal(cur.version, 3); assert.equal(cur.title, 'Test Route (edited)');
  assert.equal(cur.checkpoints[2].radius_m, 30); assert.equal(cur.checkpoints[2].needs_onsite_check, false);
  // put things back for the remaining tests
  rpc(admin, 'hunt_admin_publish', `'test-1', ${lit(JSON.stringify(testDoc()))}::jsonb`);
});

test('only a player’s first competitive run of a route counts: no farming by replaying', {skip}, () => {
  const u = newUser(null, {dorm: 'Baker Hall'});
  const first = createTeam(u, 'First Run'); assert.equal(first.counts, true);
  // a second team in the same week does not count, even before the first is finished
  const second = createTeam(u, 'Second Try'); assert.equal(second.counts, false);
  finish(u, first.team_id);
  const replay = finish(u, second.team_id);
  assert.equal(replay.completed, true); assert.equal(replay.reward_token, null); assert.equal(replay.reward_note, 'repeat_run');
  assert.equal(count('hunt_reward_tokens', `user_id = '${u}'`), 1);
  // after finishing once, later weeks don't count either
  exec(`update public.hunt_teams set week = week - 7 where id in ('${first.team_id}', '${second.team_id}')`);
  const third = createTeam(u, 'Third Time'); assert.equal(third.counts, false);
  finish(u, third.team_id);
  const names = rpc(u, 'hunt_standings', `'test-1'`).teams.map(t => t.team_name);
  assert.ok(!names.includes('Third Time') && !names.includes('Second Try'), 'repeat runs are not on the standings');
  // …but an unfinished run from an earlier week doesn't block a fresh start
  const w = newUser(); const old = createTeam(w, 'Half Done'); checkIn(w, old.team_id, 1);
  exec(`update public.hunt_teams set week = week - 7 where id = '${old.team_id}'`);
  assert.equal(checkIn(w, old.team_id, 2).status, 'expired', 'last week’s run is closed; its credit is kept');
  assert.equal(rpc(w, 'hunt_use_hint', `'${old.team_id}', 2`).status, 'expired');
  assert.equal(checkIn(w, old.team_id, 1).status, 'already');
  const fresh = createTeam(w, 'Try Again'); assert.equal(fresh.counts, true);
  // joining a friend's team as a repeat player: you play, they score
  const friend = newUser(); const ft = createTeam(friend, 'With A Vet').team_id;
  const j = rpc(u, 'hunt_join_team', `'${ft}'`); assert.equal(j.status, 'ok'); assert.equal(j.counts, false);
  finish(u, ft); checkIn(friend, ft, 1, true, null);
  assert.equal(rpc(friend, 'hunt_my_run', `'test-1'`).team_score, 100, 'only the first-run player’s points make the team score');
});

test('colorado.edu: anyone can play, but standings and rewards need a verified CU address', {skip}, () => {
  const guest = newUser('visitor@gmail.com'), cu = newUser(null, {dorm: 'Sewall Hall'});
  const spoof = newUser('sneaky@colorado.edu.evil.test'), unconfirmed = newUser('pending@colorado.edu', {unconfirmed: true});
  assert.equal(rpc(guest, 'hunt_whoami').cu_verified, false);
  assert.equal(rpc(spoof, 'hunt_whoami').cu_verified, false);
  assert.equal(rpc(unconfirmed, 'hunt_whoami').cu_verified, false, 'an unconfirmed address proves nothing');
  assert.equal(as(guest, `select public.hunt_whoami() as r`, 'someone@colorado.edu')[0].r.cu_verified, false, 'a token claim that doesn’t match the account proves nothing');
  // a guest plays a full run: scored, but no token and not listed
  const g = createTeam(guest, 'Just Visiting'); assert.equal(g.status, 'ok'); assert.equal(g.cu_verified, false);
  const done = finish(guest, g.team_id);
  assert.equal(done.team_score, 600); assert.equal(done.reward_token, null); assert.equal(done.reward_note, 'not_cu');
  assert.equal(count('hunt_reward_tokens', `user_id = '${guest}'`), 0);
  assert.ok(!rpc(null, 'hunt_standings', `'test-1'`).teams.some(t => t.team_name === 'Just Visiting'));
  // a mixed herd is listed (it has a verified player) but doesn't carry the all-verified badge
  const m = createTeam(cu, 'Town And Gown').team_id; const guest2 = newUser('friend@gmail.com'); rpc(guest2, 'hunt_join_team', `'${m}'`);
  finish(cu, m); finish(guest2, m);
  const row = rpc(cu, 'hunt_standings', `'test-1'`).teams.find(t => t.team_name === 'Town And Gown');
  assert.equal(row.verified, false); assert.equal(row.is_mine, true); assert.equal(row.score, 600);
  assert.equal(count('hunt_reward_tokens', `team_id = '${m}'`), 1, 'only the verified player gets a token');
});

test('weekly standings: names, avatars, affiliations and scores only; ties share a rank', {skip}, () => {
  exec(`delete from public.hunt_teams where edition_id = 'demo-3'`);
  const mk = (name, dorms, hints) => {
    const us = dorms.map(d => newUser(null, {dorm: d}));
    const id = rpc(us[0], 'hunt_create_team', `'demo-3', ${lit(name)}, 'elk'`).team_id;
    us.slice(1).forEach(u => rpc(u, 'hunt_join_team', `'${id}'`));
    // demo answers aren't known to the tests: mark puzzles solved the way a correct answer would
    exec(`insert into public.hunt_team_puzzles (team_id, checkpoint_no, hints_used, solved, points) select '${id}', g, ${hints}, true, greatest(60, 100 - 20 * ${hints}) from generate_series(1, 5) g`);
    us.forEach(u => { for (let cp = 1; cp <= 5; cp++) rpc(u, 'hunt_check_in', `'${id}', ${cp}, true, null`); });
    return {id, us};
  };
  const a = mk('Libby Legends', ['Libby Hall', 'Libby Hall'], 0), b = mk('Farrand Flyers', ['Farrand Hall'], 0);
  mk('Mixed Bag', ['Libby Hall', 'Baker Hall', null], 1); mk('No Dorm', [null], 2);
  const s = rpc(a.us[0], 'hunt_standings', `'demo-3'`);
  assert.deepEqual(s.teams.map(t => [t.rank, t.team_name, t.score]), [[1, 'Farrand Flyers', 600], [1, 'Libby Legends', 600], [3, 'Mixed Bag', 500], [4, 'No Dorm', 400]]);
  assert.deepEqual(Object.keys(s.teams[0]).sort(), ['affiliation', 'avatar', 'finished', 'is_mine', 'players', 'rank', 'score', 'team_name', 'verified']);
  assert.deepEqual(s.teams.map(t => t.affiliation), ['Farrand Hall', 'Libby Hall', 'Mixed herd', null]);
  assert.deepEqual(s.teams.map(t => t.is_mine), [false, true, false, false]);
  assert.deepEqual(s.affiliations.map(x => [x.rank, x.affiliation, x.score, x.players]), [[1, 'Farrand Hall', 600, 1], [2, 'Libby Hall', 567, 3], [3, 'Baker Hall', 500, 1]]);
  assert.equal(s.affiliations.find(x => x.affiliation === 'Libby Hall').is_mine, true);
  const text = JSON.stringify(s);
  for (const id of [a.id, b.id, ...a.us, ...b.us]) assert.ok(!text.includes(id), 'no team ids or account ids');
  assert.ok(!/@|completed_at|\d{2}:\d{2}/.test(text), 'no emails or times');
  assert.equal(s.week, sql(`select public.rr_week()::text w`)[0].w, 'Monday–Sunday week, Boulder time');
  // signed-out visitors see the same board (minus "mine"); last week is a separate board
  const anon = rpc(null, 'hunt_standings', `'demo-3'`);
  assert.deepEqual(anon.teams.map(t => t.team_name), s.teams.map(t => t.team_name)); assert.ok(anon.teams.every(t => t.is_mine === false));
  assert.deepEqual(rpc(null, 'hunt_standings', `'demo-3', (public.rr_week() - 7)`).teams, []);
});

// ---------------------------------------------------------------------------
test('admin view: allowlist by verified email only; editing, pausing and reading the counters', {skip}, () => {
  const student = newUser(), spoof = newUser('not.admin@colorado.edu');
  const unconfirmed = newUser('second.admin@colorado.edu', {unconfirmed: true});
  exec(`insert into public.admin_allowlist (email) values ('second.admin@colorado.edu')`);
  const doc = lit(JSON.stringify(testDoc())) + '::jsonb';
  for (const who of [student, spoof, unconfirmed]) {
    assert.equal(rpc(who, 'hunt_am_i_admin'), false);
    for (const call of ['hunt_admin_overview()', `hunt_admin_publish('test-1', ${doc})`, `hunt_admin_set_status('demo-1', 'paused')`,
                        `hunt_admin_save_checkpoint('{"id":"old-main","name":"x","lat":40.009,"lng":-105.273}'::jsonb)`])
      denied(who, `select public.${call}`, 'not an administrator');
  }
  // a forged email claim on someone else's session doesn't work: the account's own confirmed address must match
  assert.equal(as(student, `select public.hunt_am_i_admin() as r`, 'hunt.admin@colorado.edu')[0].r, false);
  denied(student, `select public.hunt_admin_overview()`);
  assert.equal(rpc(admin, 'hunt_am_i_admin'), true);
  exec(`update auth.users set email_confirmed_at = now() where id = '${unconfirmed}'`);
  assert.equal(rpc(unconfirmed, 'hunt_am_i_admin'), true, 'allowlisted once the address is confirmed');

  rpc(null, 'increment_hunt_metric', `'demo-1', 'starts'`);
  const o = rpc(admin, 'hunt_admin_overview');
  assert.equal(o.checkpoints.length, 5); assert.ok('needs_onsite_check' in o.checkpoints[0] && 'access_note' in o.checkpoints[0] && 'lat' in o.checkpoints[0]);
  const t1 = o.editions.find(e => e.id === 'test-1');
  assert.equal(t1.status, 'active'); assert.equal(t1.doc.puzzles.length, 5);
  assert.match(t1.doc.puzzles[0].answer_hashes[0], /^[0-9a-f]{64}$/); assert.ok(t1.doc.puzzles[0].answer_salt.length >= 16);
  assert.ok(!JSON.stringify(o).toLowerCase().includes('alpha one'), 'even administrators see hashes, not answers');
  assert.equal(o.metrics.find(m => m.edition_id === 'demo-1' && m.metric_key === 'starts').count, 1);
  assert.deepEqual(Object.keys(o.metrics[0]).sort(), ['count', 'edition_id', 'metric_key']);

  // saving the document exactly as shown keeps the answers (hashes round-trip)
  const v = rpc(admin, 'hunt_admin_publish', `'test-1', ${lit(JSON.stringify(t1.doc))}::jsonb`).version;
  assert.equal(rpc(null, 'hunt_check_answer', `'test-1', ${v}, 1, 'alpha one'`), true);
  // changing one prompt without touching answers keeps that puzzle's answers too
  const edited = JSON.parse(JSON.stringify(t1.doc)); edited.puzzles[1].prompt = 'A better prompt'; delete edited.puzzles[1].answer_salt; delete edited.puzzles[1].answer_hashes;
  const v2 = rpc(admin, 'hunt_admin_publish', `'test-1', ${lit(JSON.stringify(edited))}::jsonb`).version;
  assert.equal(rpc(null, 'hunt_check_answer', `'test-1', ${v2}, 2, '42'`), true);
  assert.equal(rpc(null, 'hunt_get_editions').find(e => e.id === 'test-1').checkpoints[1].puzzle.prompt, 'A better prompt');
  // validation
  const bad = JSON.parse(JSON.stringify(t1.doc)); bad.puzzles.pop();
  denied(admin, `select public.hunt_admin_publish('test-1', ${lit(JSON.stringify(bad))}::jsonb)`, 'needs five puzzles');
  const bad2 = JSON.parse(JSON.stringify(t1.doc)); bad2.puzzles[0].checkpoint = 'the-moon';
  denied(admin, `select public.hunt_admin_publish('test-1', ${lit(JSON.stringify(bad2))}::jsonb)`);
  const noAns = testDoc(); noAns.puzzles.forEach(p => delete p.answers);
  denied(admin, `select public.hunt_admin_publish('brand-new', ${lit(JSON.stringify(noAns))}::jsonb)`, 'a new route must come with answers');
  denied(admin, `select public.hunt_admin_save_checkpoint('{"id":"far-away","name":"Denver","lat":39.74,"lng":-104.99}'::jsonb)`, 'checkpoints must be on campus');

  // a new route starts paused; pausing hides a route from new runs but lets runs in progress finish
  assert.equal(rpc(admin, 'hunt_admin_publish', `'brand-new', ${lit(JSON.stringify(testDoc()))}::jsonb`).version, 1);
  assert.ok(!rpc(null, 'hunt_get_editions').some(e => e.id === 'brand-new'));
  assert.equal(count('hunt_metrics', `edition_id = 'brand-new'`), 9);
  const u = newUser(); const team = createTeam(u, 'Pause Proof').team_id; checkIn(u, team, 1);
  rpc(admin, 'hunt_admin_set_status', `'test-1', 'paused'`);
  assert.ok(!rpc(null, 'hunt_get_editions').some(e => e.id === 'test-1'));
  assert.equal(createTeam(newUser(), 'Too Late').status, 'unavailable');
  assert.equal(checkIn(u, team, 2).status, 'ok', 'a run already under way is not cut off');
  rpc(admin, 'hunt_admin_set_status', `'test-1', 'active'`);
  denied(admin, `select public.hunt_admin_set_status('test-1', 'deleted')`);
});

test('delete my account wipes every hunt record and token, and fixes up the teams left behind', {skip}, () => {
  const [a, b, loner] = [newUser(), newUser(), newUser()];
  const team = createTeam(a, 'Goodbye Crew').team_id; rpc(b, 'hunt_join_team', `'${team}'`);
  rpc(a, 'hunt_use_hint', `'${team}', 1`);
  finish(a, team); checkIn(b, team, 1, true, null);
  const soloTeam = createTeam(loner, 'Lone Buff').team_id; finish(loner, soloTeam);
  assert.equal(count('hunt_reward_tokens', `user_id in ('${a}', '${loner}')`), 2);
  assert.equal(sql(`select final_score s from public.hunt_teams where id = '${team}'`)[0].s, 330, 'average of 580 and 80');

  as(a, `select public.delete_my_account() is null as r`);
  for (const t of ['hunt_checkins', 'hunt_members', 'hunt_reward_tokens']) assert.equal(count(t, `user_id = '${a}'`), 0, t + ' rows are gone');
  assert.equal(sql(`select count(*)::int c from auth.users where id = '${a}'`)[0].c, 0);
  assert.equal(count('hunt_checkins', `user_id = '${b}'`), 1, 'a teammate’s credit is untouched');
  assert.deepEqual(sql(`select final_score, puzzles_solved from public.hunt_teams where id = '${team}'`)[0], {final_score: 80, puzzles_solved: 5}, 'the team is re-scored without them');

  as(loner, `select public.delete_my_account() is null as r`);
  assert.equal(count('hunt_teams', `id = '${soloTeam}'`), 0, 'a team with nobody left is deleted, name and all');
  assert.equal(count('hunt_team_puzzles', `team_id = '${soloTeam}'`), 0);
  assert.equal(count('hunt_reward_tokens', `user_id = '${loner}'`), 0);
  assert.ok(!JSON.stringify(rpc(null, 'hunt_standings', `'test-1'`)).includes('Lone Buff'));
  // deleting an account that never played still works
  const never = newUser(); as(never, `select public.delete_my_account() is null as r`);
  assert.equal(sql(`select count(*)::int c from auth.users where id = '${never}'`)[0].c, 0);
});
