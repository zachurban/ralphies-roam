const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const N = require('../username-core');

test('format: 3–24 ASCII letters, digits or underscores with at least one letter', () => {
  for (const ok of ['abc', 'Zach_U', 'FlatironFox482', 'a'.repeat(24), '2Fast4U', '_x_'])
    assert.equal(N.formatOk(ok), true, ok);
  for (const bad of ['ab', 'a'.repeat(25), '123', '___', 'Zach U', ' Zach', 'Zach ', 'Zäch', 'Ｚach', 'Zach​U', 'Zach⁠U',
                     'Zach😀', 'Аdmin', 'Zach-U', '', null, undefined, 42])
    assert.equal(N.formatOk(bad), false, JSON.stringify(bad));
});

test('the exact public wording from the spec, with no matched term or rule', () => {
  assert.equal(N.message({status: 'guidelines'}), 'That username doesn’t meet our community guidelines. Choose another or use a suggested name.');
  assert.equal(N.message({status: 'taken'}), 'That name is taken. Try another or shuffle a new one.');
  assert.equal(N.message({status: 'format'}), 'Use 3–24 letters, numbers, or underscores, including at least one letter.');
  assert.equal(N.message({status: 'guidelines', term: 'x', rule: 'y'}), N.MESSAGES.guidelines);
  assert.match(N.message({status: 'too_soon', next_at: '2026-11-19T18:00:00Z'}, 'en-US'), /once every 7 days\. Next change: .*Nov/);
  assert.equal(N.message({status: 'weird'}), N.MESSAGES.error);
});

test('typing hint never rewrites input', () => {
  assert.equal(N.typingHint(''), null);
  assert.equal(N.typingHint('Good_Name'), null);
  assert.equal(N.typingHint('Bad Name'), N.MESSAGES.format);
});

test('picker shows for missing, hidden or change-required nicknames only', () => {
  assert.equal(N.needsPicker(null), false);
  assert.equal(N.needsPicker({username: null, display_name: 'Zach U', name_state: 'ok'}), true);
  assert.equal(N.needsPicker({username: 'Buff', name_state: 'ok'}), false);
  assert.equal(N.needsPicker({username: 'Buff', name_state: 'change_required'}), true);
  assert.equal(N.needsPicker({username: 'Buff', name_state: 'hidden'}), true);
});

test('report reasons match the server list', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20261112190000_usernames.sql'), 'utf8');
  const fn = sql.slice(sql.indexOf('create function public.report_username'));
  for (const [code] of N.REPORT_REASONS) assert.ok(fn.includes(`'${code}'`), code);
});

test('the client ships no moderation word lists', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'username-core.js'), 'utf8');
  const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'username-moderation.json'), 'utf8'));
  const rot13 = s => s.replace(/[a-z]/gi, c => String.fromCharCode((c <= 'Z' ? 90 : 122) >= (c = c.charCodeAt(0) + 13) ? c : c - 26));
  for (const w of ['profanity', 'slurs', 'sexual'].flatMap(g => fixtures.blocked_rot13[g]).map(rot13))
    assert.ok(!src.toLowerCase().includes(w.toLowerCase()), 'client contains a fixture term');
});

test('LDNOOBW import: whole words only, reviewed exclusions honored, digits skipped', async () => {
  const m = await import('../scripts/build-moderation-terms.mjs');
  const rows = m.buildRows(['Big Black', 'cornhole', 'shota', 'santorum', '2g1c', 'G-Spot', 'strap on', 'xx', 'xxx', 'hardcore']);
  assert.deepEqual(rows.map(r => [r.term, r.match]), [['g spot', 'phrase'], ['strap on', 'phrase'], ['xxx', 'token']]);
  assert.equal(m.categorize('nigger'), 'slur');
  assert.match(m.toSQL(rows, 'test'), /on conflict \(term, match\) do update set enabled = true;/);
});
