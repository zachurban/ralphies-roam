// Herd and Seek — engine tests with simulated GPS, a simulated relay and simulated phone storage.
// No browser, network or database needed:   node --test tests/herd-core.test.cjs
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const path = require('node:path');
const core = require('../herd-core');
const bundle = require('../herd-editions');

const ED = bundle.editions[0].content, KEY = bundle.editions[0].key;
const CP = n => ED.checkpoints[n - 1];
// A phone standing `metres` north of a checkpoint, reporting `accuracy` metres.
const fixAt = (cp, metres, accuracy) => ({lat: cp.lat + metres / 111320, lng: cp.lng, accuracy});

// One simulated phone: its own storage, its own clock, a seat on the shared relay.
async function phone(relay, rawKey, opts = {}) {
  const keys = await core.deriveKeys(rawKey);
  const store = opts.store || core.memoryStore();
  const transport = relay.join(keys.channelId);
  const saved = await core.restore(keys, store);
  const clock = opts.clock || {t: 1_800_000_000_000};
  const s = core.createSession({keys, transport, store, now: () => (clock.t += 1000), state: saved && saved.state, self: saved && saved.self, flags: saved && saved.flags});
  return {s, keys, store, transport, clock};
}
const settle = () => new Promise(r => setTimeout(r, 25));

// ---------------------------------------------------------------------------
test('answers: punctuation, spacing and case never matter; the plain answer is never needed to check', async () => {
  assert.equal(core.normalizeAnswer('  Red-Brick! '), 'redbrick');
  assert.equal(core.normalizeAnswer('É1876'), '1876');
  const key = {salt: 'pepper', hashes: [await core.hashAnswer('pepper', 'Old Main')]};
  assert.equal(await core.checkAnswerLocal(key, 'old   main'), true);
  assert.equal(await core.checkAnswerLocal(key, 'OLD-MAIN.'), true);
  assert.equal(await core.checkAnswerLocal(key, 'new main'), false);
  assert.equal(await core.checkAnswerLocal(key, ''), false);
  assert.notEqual(await core.hashAnswer('a', 'x'), await core.hashAnswer('b', 'x'), 'salt changes the hash');
});

test('simulated GPS: inside, near, weak and outside are told apart honestly', () => {
  const cp = CP(1);   // 40 m radius
  assert.equal(core.geofence(fixAt(cp, 10, 8), cp).state, 'inside');
  assert.equal(core.geofence(fixAt(cp, 55, 20), cp).state, 'inside', 'inside when part of the accuracy circle (max 25 m) reaches in');
  assert.equal(core.geofence(fixAt(cp, 70, 40), cp).state, 'near', 'a vague fix that could be inside is "near", not a pass');
  assert.equal(core.geofence(fixAt(cp, 20, 300), cp).state, 'weak', 'a 300 m fix proves nothing even at the right spot');
  assert.equal(core.geofence(fixAt(cp, 20, 300), cp).inside, false);
  const far = core.geofence(fixAt(cp, 400, 10), cp);
  assert.equal(far.state, 'outside'); assert.equal(far.toward, 'south'); assert.ok(Math.abs(far.distance - 400) < 3);
  assert.equal(core.geofence(null, cp).state, 'weak');
  assert.equal(core.geofence({lat: NaN, lng: 0, accuracy: 5}, cp).inside, false);
  // several fixes: one good one is enough; otherwise the most accurate explains the problem
  assert.equal(core.bestFence([fixAt(cp, 20, 300), fixAt(cp, 12, 9)], cp).state, 'inside');
  assert.equal(core.bestFence([fixAt(cp, 400, 90), fixAt(cp, 400, 12)], cp).state, 'outside');
});

test('scoring: 100 a checkpoint, 20 off per hint (never below 60), 100 for all five, 600 at most', () => {
  assert.equal(core.puzzlePoints(0), 100); assert.equal(core.puzzlePoints(1), 80);
  assert.equal(core.puzzlePoints(2), 60); assert.equal(core.puzzlePoints(9), 60);
  const all = {1: true, 2: true, 3: true, 4: true, 5: true};
  const clean = {}; for (let i = 1; i <= 5; i++) clean[i] = {hints: 0, solvedAt: 1};
  assert.equal(core.memberPoints(all, clean), 600);
  const hinted = JSON.parse(JSON.stringify(clean)); hinted[2].hints = 1; hinted[4].hints = 2;
  assert.equal(core.memberPoints(all, hinted), 540);
  assert.equal(core.memberPoints({1: true, 2: true}, clean), 200, 'no completion bonus until all five');
  assert.equal(core.memberPoints({1: true}, {1: {hints: 0, solvedAt: null}}), 0, 'being there is not enough: the puzzle must be solved');
});

test('scoring: a team is its average, so five players cannot outscore two (or one) by headcount', () => {
  assert.equal(core.teamScore([600]), 600);
  assert.equal(core.teamScore([600, 600]), 600);
  assert.equal(core.teamScore([600, 600, 600, 600, 600]), 600);
  assert.equal(core.teamScore([600, 300]), 450);
  assert.equal(core.teamScore([100, 100, 200]), 133);
  assert.equal(core.teamScore([]), 0);
});

test('invite: the key rides in the #fragment and nowhere else', async () => {
  const raw = core.newHerdKey();
  assert.equal(core.validKey(raw), true);
  const url = core.inviteUrl('https://example.test/app/herd.html?x=1#old', raw);
  assert.equal(url, 'https://example.test/app/herd.html?x=1#key=' + raw);
  const u = new URL(url);
  assert.ok(!u.search.includes(raw) && !u.pathname.includes(raw), 'not in the part of the URL a server receives');
  assert.equal(core.parseInvite(url), raw); assert.equal(core.parseInvite('#key=' + raw), raw); assert.equal(core.parseInvite(raw), raw);
  assert.equal(core.parseInvite('https://example.test/herd.html#key=short'), null);
  assert.equal(core.parseInvite('hello'), null);
  const k = await core.deriveKeys(raw);
  assert.match(k.channelId, /^[0-9a-f]{32}$/);
  assert.ok(!k.channelId.includes(raw) && k.aes.extractable === false && k.mac.extractable === false, 'keys cannot be read back out');
  await assert.rejects(() => core.deriveKeys('nope'));
});

test('sealed messages: only the herd key opens them; tampering is detected', async () => {
  const a = await core.deriveKeys(core.newHerdKey()), b = await core.deriveKeys(core.newHerdKey());
  const sealed = await core.seal(a, {nick: 'FlatironFox', answer: 'secret-word'});
  assert.ok(!sealed.includes('FlatironFox') && !sealed.includes('secret'));
  assert.deepEqual(await core.open(a, sealed), {nick: 'FlatironFox', answer: 'secret-word'});
  await assert.rejects(() => core.open(b, sealed), 'another herd cannot read it');
  const parts = sealed.split('.'); const bytes = core.unb64u(parts[2]); bytes[3] ^= 1;
  await assert.rejects(() => core.open(a, parts[0] + '.' + parts[1] + '.' + core.b64u(bytes)), 'a flipped bit is rejected');
  assert.notEqual(sealed, await core.seal(a, {nick: 'FlatironFox', answer: 'secret-word'}), 'fresh nonce every time');
});

test('rolling "we’re together" code: works now, dies within seconds, useless to other herds', async () => {
  const keys = await core.deriveKeys(core.newHerdKey()), other = await core.deriveKeys(core.newHerdKey());
  const t0 = 1_800_000_003_500;
  const code = await core.presenceCode(keys, 'peerAAAAAAAA', 3, t0);
  assert.match(code.digits, /^\d{6}$/); assert.ok(code.msLeft > 0 && code.msLeft <= core.ROLL_MS);
  assert.deepEqual(await core.verifyPresence(keys, code.text, t0 + 2000, {self: 'peerBBBBBBBB'}), {ok: true, peerId: 'peerAAAAAAAA', cp: 3});
  assert.equal((await core.verifyPresence(keys, code.text, t0 + core.ROLL_MS * 2, {})).ok, true, 'still fine a couple of rotations later (time to aim a camera)');
  assert.equal((await core.verifyPresence(keys, code.text, t0 + core.ROLL_MS * 4, {})).reason, 'stale', 'a screenshot sent by text is too old');
  assert.equal((await core.verifyPresence(other, code.text, t0, {})).reason, 'wrong', 'another herd’s key does not verify it');
  assert.equal((await core.verifyPresence(keys, code.text, t0, {self: 'peerAAAAAAAA'})).reason, 'self', 'you cannot vouch for yourself');
  assert.equal((await core.verifyPresence(keys, code.text, t0, {cp: 4})).reason, 'other_checkpoint');
  assert.equal((await core.verifyPresence(keys, code.text.replace(':3:', ':4:'), t0, {})).reason, 'wrong', 'the checkpoint is signed too');
  assert.notEqual((await core.presenceCode(keys, 'peerAAAAAAAA', 3, t0 + core.ROLL_MS)).text, code.text, 'it rotates');
  // camera-free fallback: six digits read aloud
  assert.deepEqual(await core.verifyPresence(keys, code.digits, t0 + 1000, {cp: 3, peers: ['peerAAAAAAAA', 'peerCCCCCCCC'], self: 'peerBBBBBBBB'}), {ok: true, peerId: 'peerAAAAAAAA', cp: 3});
  assert.equal((await core.verifyPresence(keys, code.digits, t0 + core.ROLL_MS * 4, {cp: 3, peers: ['peerAAAAAAAA']})).ok, false);
  assert.equal((await core.verifyPresence(keys, 'garbage', t0, {})).reason, 'format');
});

test('split clues: pieces are dealt across the herd, a solo player holds them all, and a handed-over piece is signed', async () => {
  const solo = core.assignPieces(4, ['me'], 1);
  assert.deepEqual(solo.me, [0, 1, 2, 3]);
  const three = core.assignPieces(4, ['c', 'a', 'b'], 2);
  assert.deepEqual(Object.values(three).flat().sort(), [0, 1, 2, 3], 'every piece is on exactly one screen');
  assert.ok(Object.values(three).every(x => x.length >= 1), 'everyone holds something');
  assert.deepEqual(core.assignPieces(4, ['b', 'c', 'a'], 2), three, 'every phone computes the same deal');
  const keys = await core.deriveKeys(core.newHerdKey());
  const qr = await core.pieceCode(keys, 2, 3);
  assert.deepEqual(await core.verifyPiece(keys, qr), {ok: true, cp: 2, idx: 3});
  assert.equal((await core.verifyPiece(keys, qr.replace(':3:', ':1:'))).ok, false);
  assert.equal(core.scanKind(qr), 'piece'); assert.equal(core.scanKind('BPH1:T:x'), 'presence');
  assert.equal(core.scanKind('https://x.test/herd.html#key=' + core.newHerdKey()), 'invite'); assert.equal(core.scanKind('https://x.test'), 'unknown');
});

test('merging herd state is order-independent and repeatable (so phones can sync in any order)', () => {
  const base = core.newState({mode: 'friends', edition: ED, name: 'Quad Squad', avatar: 'fox', now: 1000});
  const a = JSON.parse(JSON.stringify(base)), b = JSON.parse(JSON.stringify(base));
  a.members.A = {nick: 'Ana', avatar: 'owl', at: 5, seen: 9, leftAt: 0, joinedAt: 5, comp: null, prox: {1: {at: 50, via: 'gps'}}, credit: {}, together: {1: ['B']}};
  a.puzzles[1] = {unlockedAt: 50, unlockedBy: 'A', hints: 1, solvedAt: null, solvedBy: null, answer: null, shared: {0: true}};
  b.members.A = {nick: 'Ana B.', avatar: 'elk', at: 8, seen: 3, leftAt: 0, joinedAt: 5, comp: null, prox: {}, credit: {}, together: {}};
  b.members.B = {nick: 'Ben', avatar: 'bear', at: 6, seen: 7, leftAt: 0, joinedAt: 6, comp: null, prox: {1: {at: 60, via: 'vouch', by: 'A'}}, credit: {}, together: {}};
  b.puzzles[1] = {unlockedAt: 60, unlockedBy: 'B', hints: 2, solvedAt: 90, solvedBy: 'B', answer: 'child', shared: {2: true}};
  b.rosterLockedAt = 90;
  const ab = core.merge(a, b), ba = core.merge(b, a);
  assert.ok(core.sameState(ab, ba), 'a+b equals b+a');
  assert.ok(core.sameState(core.merge(ab, b), ab) && core.sameState(core.merge(ab, ab), ab), 'merging again changes nothing');
  assert.equal(ab.members.A.nick, 'Ana B.', 'newest profile wins');
  assert.equal(ab.members.A.prox[1].via, 'gps', 'a check-in is never lost');
  assert.equal(ab.puzzles[1].hints, 2); assert.equal(ab.puzzles[1].unlockedBy, 'A'); assert.equal(ab.puzzles[1].answer, 'child');
  assert.deepEqual(ab.puzzles[1].shared, {0: true, 2: true}); assert.equal(ab.rosterLockedAt, 90);
});

// ---------------------------------------------------------------------------
test('solo flow (Friends Mode, simulated GPS): check in, solve, finish — with no server anywhere', async () => {
  const relay = core.memoryRelay(), raw = core.newHerdKey();
  const p = await phone(relay, raw);
  await p.s.create({mode: 'friends', edition: ED, name: 'Solo Stroll', avatar: 'pika', nick: 'Sam', myAvatar: 'owl'});
  const me = p.s.self;
  assert.equal(core.checkpointStatus(p.s.state, me, 1), 'todo');
  // not there yet
  assert.equal(core.geofence(fixAt(CP(1), 300, 10), CP(1)).inside, false);
  // walk over; the phone decides it's inside and records only that
  assert.equal(core.geofence(fixAt(CP(1), 8, 10), CP(1)).inside, true);
  await p.s.arrive(1, 'gps');
  assert.equal(core.checkpointStatus(p.s.state, me, 1), 'here');
  assert.deepEqual(Object.keys(p.s.state.members[me].prox[1]).sort(), ['at', 'by', 'via'], 'no coordinates are kept, even locally');
  assert.equal(await core.checkAnswerLocal(KEY['1'], 'wrong'), false);
  // (the tests don't know the real answers; they only prove the stored hash is what gets checked)
  await p.s.hint(1); await p.s.solve(1, 'x');
  assert.equal(core.checkpointStatus(p.s.state, me, 1), 'done');
  for (let cp = 2; cp <= 5; cp++) { await p.s.arrive(cp, 'gps'); await p.s.solve(cp, 'x'); }
  assert.equal(core.finished(p.s.state, me), true);
  const sc = core.herdScore(p.s.state);
  assert.equal(sc.members[me].points, 580, '4×100 + 80 (one hint) + 100 finish bonus');
  assert.equal(sc.team, 580);
  await assert.rejects(() => p.s.arrive(1, 'sim'), /Demo Practice/, 'simulated check-ins are refused outside Demo Practice');
});

test('encrypted team sync: three phones converge, and the relay carries only ciphertext', async () => {
  const relay = core.memoryRelay(), raw = core.newHerdKey();
  const a = await phone(relay, raw);
  await a.s.create({mode: 'friends', edition: bundle.editions[2].content, name: 'Kittredge Crew', avatar: 'elk', nick: 'Avery Secretname', myAvatar: 'fox'});
  // B and C scan the invite: they know only the key
  const b = await phone(relay, core.parseInvite(core.inviteUrl('https://x.test/herd.html', raw)));
  const c = await phone(relay, raw);
  await b.s.hello(); await settle(); await c.s.hello(); await settle();
  assert.ok(b.s.state && c.s.state, 'joiners receive the herd from a teammate’s phone');
  assert.equal(b.s.state.edition.id, 'demo-3', 'including the exact route version the herd is locked to');
  await b.s.joinAs({nick: 'Blake', avatar: 'owl'}); await c.s.joinAs({nick: 'Casey', avatar: 'bear'}); await settle();
  assert.equal(core.activeMembers(a.s.state).length, 3);

  // A reaches checkpoint 2 → the puzzle unlocks for everyone, but only A is checked in
  await a.s.arrive(2, 'gps'); await settle();
  assert.equal(core.checkpointStatus(b.s.state, b.s.self, 2), 'unlocked');
  assert.equal(core.checkpointStatus(a.s.state, a.s.self, 2), 'here');
  // split clue pieces are dealt out; B passes one to the herd
  const deal = core.assignPieces(4, core.activeMembers(a.s.state), 2);
  assert.deepEqual(Object.values(deal).flat().sort(), [0, 1, 2, 3]);
  await b.s.sharePiece(2, deal[b.s.self][0]); await settle();
  assert.equal(c.s.state.puzzles[2].shared[deal[b.s.self][0]], true);
  // C's GPS is weak: C scans A's rolling code instead (verified phone to phone)
  const t = c.clock.t, code = await core.presenceCode(a.keys, a.s.self, 2, t);
  const v = await core.verifyPresence(c.keys, code.text, t + 3000, {self: c.s.self, cp: 2});
  assert.equal(v.ok, true);
  await c.s.arrive(2, 'vouch', v.peerId); await c.s.together(2, v.peerId); await settle();
  // A uses a hint and solves; everyone sees it, B still needs their own check-in
  await a.s.hint(2); await a.s.solve(2, 'the shared answer'); await settle();
  assert.equal(core.checkpointStatus(a.s.state, a.s.self, 2), 'done');
  assert.equal(core.checkpointStatus(c.s.state, c.s.self, 2), 'done');
  assert.equal(core.checkpointStatus(b.s.state, b.s.self, 2), 'solved', 'the herd solving it is not B’s attendance');
  assert.equal(b.s.state.puzzles[2].answer, 'the shared answer');
  await b.s.arrive(2, 'gps'); await settle();
  assert.equal(core.checkpointStatus(a.s.state, b.s.self, 2), 'done');
  assert.ok(core.sameState(strip(a.s.state), strip(b.s.state)) && core.sameState(strip(b.s.state), strip(c.s.state)), 'all three phones agree');
  assert.equal(core.herdScore(a.s.state).team, 80, 'average of three players with 80 each');

  // What did the relay see?
  assert.ok(relay.log.length > 10);
  for (const frame of relay.log) {
    assert.match(frame.text, /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/, 'only sealed frames');
    for (const leak of ['Secretname', 'Kittredge', 'shared answer', 'demo-3', '"nick"', raw])
      assert.ok(!frame.text.includes(leak), 'relay never sees ' + leak);
    assert.match(frame.channel, /^[0-9a-f]{32}$/); assert.ok(!frame.channel.includes(raw));
  }
  // An outsider on the same relay channel learns nothing and can inject nothing
  const outsider = await core.deriveKeys(core.newHerdKey());
  await assert.rejects(() => core.open(outsider, relay.log[0].text));
  const before = JSON.stringify(a.s.state);
  await relay.join(a.keys.channelId).send(await core.seal(outsider, {t: 'state', from: 'evil', s: {v: 1, members: {evil: {}}, puzzles: {}}}));
  await relay.join(a.keys.channelId).send('not even sealed'); await settle();
  assert.equal(JSON.stringify(a.s.state), before); assert.ok(a.s.stats.rejected >= 2);
});
function strip(s) { const o = JSON.parse(JSON.stringify(s)); Object.values(o.members).forEach(m => delete m.seen); return o; }

test('reload persistence: a phone that reloads keeps its progress, and reconnecting catches everyone up', async () => {
  const relay = core.memoryRelay(), raw = core.newHerdKey();
  const a = await phone(relay, raw), bStore = core.memoryStore();
  await a.s.create({mode: 'friends', edition: ED, name: 'Reloaders', avatar: 'bison', nick: 'Ari', myAvatar: 'hawk'});
  let b = await phone(relay, raw, {store: bStore});
  await b.s.hello(); await settle(); await b.s.joinAs({nick: 'Bo Longnickname', avatar: 'trout'}); await settle();
  await b.s.arrive(1, 'gps'); await b.s.solve(1, 'x'); await b.s.setFlag('m:starts'); await settle();
  const bId = b.s.self;

  // What's on B's phone is sealed: nothing readable without the key
  const stored = [...bStore._map.entries()];
  assert.equal(stored.length, 1); assert.match(stored[0][0], /^bp-herd:[0-9a-f]{32}$/);
  assert.match(stored[0][1], /^v1\./); assert.ok(!stored[0][1].includes('Longnickname') && !stored[0][1].includes('Reloaders') && !stored[0][1].includes(raw));
  assert.equal(await core.restore(await core.deriveKeys(core.newHerdKey()), bStore), null, 'another key cannot open it');

  // B's tab dies mid-hunt. While it's gone, A keeps playing.
  b.s.close(); b.transport.drop();
  await a.s.arrive(1, 'gps'); await a.s.arrive(2, 'gps'); await a.s.solve(2, 'y'); await settle();

  // B reloads: progress is back from this phone's own storage, before any network
  b = await phone(relay, raw, {store: bStore});
  assert.equal(b.s.self, bId, 'same identity after reload');
  assert.equal(core.checkpointStatus(b.s.state, bId, 1), 'done');
  assert.equal(b.s.flags['m:starts'], true, 'one-time counters are not re-sent after a reload');
  assert.equal(b.s.state.puzzles[2], undefined, 'not yet caught up');
  // …then one hello and the herd fills in what B missed
  await b.s.hello(); await settle();
  assert.equal(b.s.state.puzzles[2].solvedAt > 0, true);
  assert.equal(core.checkpointStatus(b.s.state, a.s.self, 2), 'done');

  // The other direction: A reloads with stale storage and B (who never went away) knows more
  const aStore = core.memoryStore(); await aStore.set('bp-herd:' + a.keys.channelId, await core.seal(a.keys, {self: a.s.self, state: core.newState({mode: 'friends', edition: ED, name: 'Reloaders', avatar: 'bison', now: 1}), flags: {}}));
  a.s.close(); a.transport.drop();
  const a2 = await phone(relay, raw, {store: aStore});
  await a2.s.hello(); await settle();
  assert.equal(core.checkpointStatus(a2.s.state, bId, 1), 'done');
  assert.ok(a2.s.state.puzzles[2].solvedAt > 0, 'nothing is lost as long as one phone remembers');
});

test('demo practice is its own lane: simulated arrivals exist only there, and are labelled', async () => {
  const relay = core.memoryRelay();
  const p = await phone(relay, core.newHerdKey());
  await p.s.create({mode: 'practice', edition: ED, name: 'Practice', avatar: 'bison', nick: 'Pat', myAvatar: 'pika'});
  await p.s.arrive(1, 'sim');
  assert.equal(p.s.state.members[p.s.self].prox[1].via, 'sim');
  assert.equal(p.s.state.mode, 'practice'); assert.equal(p.s.state.herd.teamId, null, 'never attached to a competition team');
  for (const mode of ['friends', 'competition']) {
    const q = await phone(relay, core.newHerdKey());
    await q.s.create({mode, edition: ED, name: 'Real', avatar: 'bison', nick: 'Q', myAvatar: 'pika'});
    await assert.rejects(() => q.s.arrive(1, 'sim'), /Demo Practice/);
  }
});

test('competition waits for the server: a solved checkpoint is "crediting" until the database confirms it', async () => {
  const relay = core.memoryRelay();
  const p = await phone(relay, core.newHerdKey());
  await p.s.create({mode: 'competition', edition: ED, name: 'Comp', avatar: 'bison', nick: 'C', myAvatar: 'pika', teamId: '00000000-0000-4000-8000-000000000001'});
  await p.s.arrive(1, 'gps'); await p.s.solve(1, 'x');
  assert.equal(core.checkpointStatus(p.s.state, p.s.self, 1), 'crediting');
  await p.s.credit(1);
  assert.equal(core.checkpointStatus(p.s.state, p.s.self, 1), 'done');
});

test('QR round trip: a rolling code drawn by the vendored generator is read back by the vendored scanner', async () => {
  const qrcode = require('../vendor/qrcode.min.js'), jsQR = require('../vendor/jsqr.min.js');
  const keys = await core.deriveKeys(core.newHerdKey()), now = 1_800_000_000_000;
  const invite = core.inviteUrl('https://zachurban.github.io/ralphies-roam/herd.html', core.newHerdKey());
  for (const text of [(await core.presenceCode(keys, 'peerAAAAAAAA', 4, now)).text, await core.pieceCode(keys, 3, 2), invite]) {
    const q = qrcode(0, 'M'); q.addData(text); q.make();
    const n = q.getModuleCount(), scale = 4, margin = 4, w = (n + 2 * margin) * scale, px = new Uint8ClampedArray(w * w * 4).fill(255);
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c))
      for (let y = 0; y < scale; y++) for (let x = 0; x < scale; x++) { const i = (((r + margin) * scale + y) * w + (c + margin) * scale + x) * 4; px[i] = px[i + 1] = px[i + 2] = 0; }
    const read = jsQR(px, w, w);
    assert.equal(read && read.data, text);
  }
  assert.equal((await core.verifyPresence(keys, (await core.presenceCode(keys, 'peerAAAAAAAA', 4, now)).text, now + 1000, {})).ok, true);
});

// ---------------------------------------------------------------------------
test('the three demo routes: five outdoor checkpoints each, flagged for an on-site check, no answers in the repo', () => {
  assert.equal(bundle.editions.length, 3);
  const kinds = bundle.editions.map(e => e.content.checkpoints[0].puzzle.kind);
  assert.deepEqual(kinds, ['observe', 'cipher', 'split']);
  bundle.editions.forEach((e, i) => {
    const c = e.content;
    assert.equal(c.title, 'Demo Route — Edition ' + (i + 1)); assert.equal(c.demo, true); assert.equal(c.version, 1);
    assert.deepEqual(c.checkpoints.map(x => x.id), ['norlin-quad', 'macky-south', 'old-main', 'rippon-outside', 'umc-terrace']);
    let walk = 0;
    c.checkpoints.forEach((cp, j) => {
      assert.equal(cp.needs_onsite_check, true, cp.id + ' coordinate is flagged');
      assert.equal(cp.puzzle.needs_onsite_check, true);
      assert.ok(cp.access_note && cp.entrance_note && /outside|outdoor/i.test(cp.entrance_note + cp.spot));
      assert.ok(cp.radius_m >= 15 && cp.radius_m <= 150);
      assert.equal(cp.puzzle.hints.length, core.MAX_HINTS);
      if (cp.puzzle.kind === 'split') assert.ok(cp.puzzle.pieces.length >= 2); else assert.equal(cp.puzzle.pieces.length, 0);
      assert.ok(!('answer' in cp.puzzle) && !('answers' in cp.puzzle));
      const k = e.key[String(j + 1)];
      assert.ok(k.salt.length >= 16 && k.hashes.length >= 1 && k.hashes.every(h => /^[0-9a-f]{64}$/.test(h)));
      if (j) walk += core.distanceM(c.checkpoints[j - 1].lat, c.checkpoints[j - 1].lng, cp.lat, cp.lng);
    });
    assert.ok(walk > 300 && walk < 1300, 'a short walk between five nearby checkpoints (' + Math.round(walk) + ' m)');
    assert.match(c.checkpoints[3].entrance_note, /Stay outside the theatre/);
  });
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'build-hunt.mjs'), '--check'], {encoding: 'utf8'});
  assert.equal(r.status, 0, 'herd-editions.js matches data/hunt/editions.src.json: ' + r.stderr);
});
