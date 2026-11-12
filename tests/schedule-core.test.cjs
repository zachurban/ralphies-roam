// node --test tests/schedule-core.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
require('../schedule-core.js');
const R = globalThis.RoamSchedule;
const fx = f => fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8');
const KNOWN = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'buildings.json'), 'utf8')).buildings.map(b => b.code);

test('your first sample: building name + code, (LEC) suffix, weekly RRULE with UTC UNTIL', () => {
  const { classes } = R.parseICS(fx('sample-a.ics'), { known: KNOWN });
  assert.equal(classes.length, 2);
  const [lec, rec] = classes;
  assert.deepEqual([lec.course, lec.component, lec.days, lec.start, lec.end, lec.code], ['CSCI 1300', 'Lecture', [1, 3, 5], '10:00', '10:50', 'ECCR']);
  assert.equal(lec.last, '2026-12-10');               // 23:59:59Z on Dec 10 is still Dec 10 in Denver
  assert.deepEqual([rec.component, rec.days, rec.start, rec.code], ['Recitation', [2], '14:00', 'ECCS']);
});

test('your second sample: CSCI 1300-001 summary, bare ECCR 265 location, VTIMEZONE block, component from DESCRIPTION', () => {
  const { classes } = R.parseICS(fx('sample-b.ics'), { known: KNOWN });
  assert.equal(classes.length, 1);
  const c = classes[0];
  assert.deepEqual([c.course, c.title, c.component, c.code], ['CSCI 1300', 'Computer Science 1: Starting Computing', 'Lecture', 'ECCR']);
});

test('privacy: rooms, instructors, sections and class numbers are never kept', () => {
  for (const f of ['sample-a.ics', 'sample-b.ics', 'quirks.ics']) {
    const out = JSON.stringify(R.parseICS(fx(f), { known: KNOWN }));
    for (const bad of ['265', '1B28', 'Jane', 'Doe', 'Smith', '12345', 'Instructor', 'Section', '011B', '102R', 'G125'])
      assert.ok(!out.includes(bad), f + ' leaked "' + bad + '"');
  }
});

test('line folding: CRLF + space and CRLF + tab continuations are joined before parsing', () => {
  const ics = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'DTSTART;TZID=America/Denver:20260825T093',
    ' 000', 'DTEND;TZID=America/Denver:20260825T104500', 'SUMMARY:PHYS 1110-002 - General Physics 1: Calculus-Ba',
    '\tsed', 'LOCATION:Duane Physics\\, DUAN G1', ' 25', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  const c = R.parseICS(ics, { known: KNOWN }).classes[0];
  assert.equal(c.start, '09:30');
  assert.equal(c.title, 'General Physics 1: Calculus-Based');
  assert.equal(c.code, 'DUAN');
});

test('quirks file: escapes, 3- and 4-letter subjects, lettered sections, online/TBA/REMOTE/blank, EXDATE lists, Z start times, COUNT, alarms', () => {
  const { classes, skipped } = R.parseICS(fx('quirks.ics'), { known: KNOWN });
  const by = Object.fromEntries(classes.map(c => [c.course + ' ' + (c.component || ''), c]));
  // escaped comma in SUMMARY and \n in DESCRIPTION
  assert.equal(by['APPM 1350 Lecture'].title, 'Calculus 1 for Engineers, Part A');
  assert.equal(by['APPM 1350 Lecture'].code, 'MATH');
  assert.deepEqual(by['APPM 1350 Lecture'].exdates, ['2026-09-07', '2026-11-23', '2026-11-25']);
  // 3-letter subject, lettered section, component from a section like 011B / description "Lab"
  assert.equal(by['ART 1010 Lab'].code, 'VAC');
  assert.equal(by['EBIO 1210 Recitation'].code, 'RAMY');
  // DTSTART in UTC: 16:00Z is 10:00 in Denver during daylight time
  assert.equal(by['ASTR 1000 Lecture'].start, '10:00');
  // COUNT=3 on Tue/Thu starting Tue Aug 25 -> Tue 25, Thu 27, Tue Sep 1
  assert.equal(by['ASTR 1000 Lecture'].last, '2026-09-01');
  // explicitly online -> online; TBA or blank -> in person, building not set yet (the student picks it)
  for (const k of ['CSCI 2270 Lecture', 'ECON 2010 Lecture']) {
    assert.ok(by[k], 'missing ' + k);
    assert.equal(by[k].online, true, k);
    assert.equal(by[k].code, null, k);
  }
  for (const k of ['WRTG 1150 Seminar', 'PSYC 1001 Lecture']) {
    assert.ok(by[k], 'missing ' + k);
    assert.equal(by[k].online, false, k + ' is not online');
    assert.equal(by[k].code, null, k);
    assert.equal(by[k].unknownPlace, 'TBA', k);
  }
  // building not in the list is kept as a code so the student can place it once
  assert.equal(by['GEOL 1010 Lecture'].code, 'ZZZZ');
  assert.equal(by['GEOL 1010 Lecture'].online, false);
  // a VALARM inside an event doesn't overwrite its fields
  assert.equal(by['EBIO 1210 Recitation'].start, '13:00');
  assert.deepEqual(skipped.map(s => s.reason).sort(), ['cancelled', 'repeats daily (only weekly classes are supported)']);
});

test('CU calendar: holidays, breaks, reading days, Monday-schedule Fridays, and no classes during finals', () => {
  const mwf = { days: [1, 3, 5], first: '2026-08-24', last: '2026-12-10', exdates: [], interval: 1, online: false };
  const mon = Object.assign({}, mwf, { days: [1] }), fri = Object.assign({}, mwf, { days: [5] });
  assert.equal(R.meetsOn(mwf, '2026-08-24'), true);
  assert.equal(R.meetsOn(mwf, '2026-09-07'), false, 'Labor Day');
  assert.equal(R.meetsOn(mwf, '2026-10-08'), false, 'midsemester reading day (Thu) — MWF wouldn’t meet anyway');
  assert.equal(R.meetsOn({ ...mwf, days: [4] }, '2026-10-08'), false, 'reading day');
  assert.equal(R.meetsOn(mwf, '2026-11-23'), false, 'fall break');
  assert.equal(R.meetsOn(mwf, '2026-11-27'), false, 'Thanksgiving');
  assert.equal(R.meetsOn(mon, '2026-12-04'), true, 'Dec 4 follows a Monday schedule');
  assert.equal(R.meetsOn(fri, '2026-12-04'), false, 'Friday-only class does not meet on a Monday-schedule Friday');
  assert.equal(R.meetsOn(mwf, '2026-12-07'), false, 'finals week is not a regular class day even though UNTIL is Dec 10');
  assert.equal(R.meetsOn({ ...mwf, exdates: ['2026-09-09'] }, '2026-09-09'), false, 'EXDATE');
  assert.equal(R.meetsOn({ ...mwf, online: true }, '2026-08-24'), false, 'online');
  assert.equal(R.nextClassDay([mwf], '2026-11-21'), '2026-11-30', 'skips fall break and Thanksgiving');
});

test('day stops: home -> classes in time order -> home; same building back to back is one stop; online skipped', () => {
  const base = { first: '2026-08-24', last: '2026-12-10', exdates: [], interval: 1, online: false, days: [1] };
  const cs = [
    { ...base, id: 'b', code: 'HUMN', start: '13:00', end: '13:50' },
    { ...base, id: 'a', code: 'ECCR', start: '09:05', end: '09:55' },
    { ...base, id: 'c', code: 'ECCR', start: '10:10', end: '11:00' },
    { ...base, id: 'd', code: null, online: true, start: '15:00', end: '16:00' }];
  const s = R.dayStops(cs, '2026-08-31', { name: 'Farrand Hall' });
  assert.deepEqual(s.map(x => x.key), ['home', 'ECCR', 'HUMN', 'home']);
  assert.equal(s[1].classes.length, 2);
  assert.deepEqual(R.dayStops(cs, '2026-09-01', null).length, 1, 'no classes Tuesday -> no legs');
});

// A square: A-B direct 100 m walked; A-C-D-B 160 m all new. Scenic should be offered.
const sq = (lat0, lng0) => {
  const m = (dx, dy) => [lat0 + dy / 111320, lng0 + dx / 85280];
  return { A: m(0, 0), B: m(100, 0), C: m(0, 30), D: m(100, 30) };
};
test('routing: shortest path, scenic detour within the cap, and none when the detour is too long or adds nothing', () => {
  const p = sq(40, -105.26);
  const g = R.buildGraph([{ id: 'ab', pts: [p.A, p.B] }, { id: 'ac', pts: [p.A, p.C] }, { id: 'cd', pts: [p.C, p.D] }, { id: 'db', pts: [p.D, p.B] }]);
  const n = q => R.nearestNode(g, q).node;
  const walked = new Set(['ab.0']);
  const leg = R.commuteLeg(g, n(p.A), n(p.B), k => walked.has(k) ? 0 : (k === 'cd.0' ? 100 : 30));
  assert.ok(Math.abs(leg.direct.meters - 100) < 1);
  assert.deepEqual(leg.direct.keys, ['ab.0']);
  assert.ok(leg.scenic, 'scenic offered');
  assert.deepEqual(leg.scenic.keys, ['ac.0', 'cd.0', 'db.0']);
  assert.ok(leg.scenic.meters - leg.direct.meters <= 120);
  // brand-new player (nothing walked): still offered a different way that covers more new ground
  const fresh = R.commuteLeg(g, n(p.A), n(p.B), k => ({ 'ab.0': 100, 'cd.0': 100 })[k] || 30);
  assert.ok(fresh.scenic, 'new player gets a scenic option');
  assert.deepEqual(fresh.scenic.keys, ['ac.0', 'cd.0', 'db.0']);
  // a piece can never count as more new meters than its length (and the search still terminates)
  assert.ok(R.commuteLeg(g, n(p.A), n(p.B), () => 1e6));
  // everything already walked: no scenic
  assert.equal(R.commuteLeg(g, n(p.A), n(p.B), () => 0).scenic, null);
  // detour far too long (long legs): no scenic
  const q = { A: p.A, B: p.B, C: [p.C[0] + 0.004, p.C[1]], D: [p.D[0] + 0.004, p.D[1]] };
  const g2 = R.buildGraph([{ id: 'ab', pts: [q.A, q.B] }, { id: 'ac', pts: [q.A, q.C] }, { id: 'cd', pts: [q.C, q.D] }, { id: 'db', pts: [q.D, q.B] }]);
  const n2 = x => R.nearestNode(g2, x).node;
  assert.equal(R.commuteLeg(g2, n2(q.A), n2(q.B), k => k === 'ab.0' ? 0 : 400).scenic, null);
  // disconnected
  const g3 = R.buildGraph([{ id: 'x', pts: [p.A, p.C] }, { id: 'y', pts: [p.B, p.D] }]);
  assert.equal(R.shortest(g3, R.nearestNode(g3, p.A).node, R.nearestNode(g3, p.B).node), null);
});

test('real campus data: Farrand Hall -> Engineering classroom wing routes on the walkways at a sensible distance', () => {
  const geo = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'paths.geojson'), 'utf8'));
  const B = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'buildings.json'), 'utf8'));
  const g = R.buildGraph(geo.features.map(f => ({ id: f.properties.id, pts: f.geometry.coordinates.map(c => [c[1], c[0]]) })));
  const home = B.places.find(p => p.name === 'Farrand Hall'), eccr = B.buildings.find(b => b.code === 'ECCR'), eccs = B.buildings.find(b => b.code === 'ECCS');
  const a = R.placeNode(g, home), b = R.placeNode(g, eccr), c = R.placeNode(g, eccs);
  assert.ok(a.gap < R.OFF_NET_M && b.gap < R.OFF_NET_M && c.gap < R.OFF_NET_M, 'buildings sit on the walkway map');
  const r = R.shortest(g, a.node, b.node);
  const straight = R.hav(home.outline[0] ? [home.lat, home.lng] : [home.lat, home.lng], [eccr.lat, eccr.lng]);
  assert.ok(r && r.meters > straight * 0.8 && r.meters < straight * 2.2, 'route ' + Math.round(r && r.meters) + ' m vs straight ' + Math.round(straight) + ' m');
  assert.notEqual(b.node, c.node, 'the two Engineering wings reach the walkways at different points');
});

test('real campus data: East Campus buildings sit on the walkways and connect to main campus', () => {
  const geo = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'paths.geojson'), 'utf8'));
  const B = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'buildings.json'), 'utf8'));
  const g = R.buildGraph(geo.features.map(f => ({ id: f.properties.id, pts: f.geometry.coordinates.map(c => [c[1], c[0]]) })));
  const by = Object.fromEntries(B.buildings.map(b => [b.code, b]));
  for (const c of ['AERO', 'SEEC', 'BIOT', 'SPSC']) assert.ok(R.placeNode(g, by[c]).gap < R.OFF_NET_M, c + ' near a walkway');
  const r = R.shortest(g, R.placeNode(g, by.ECCR).node, R.placeNode(g, by.AERO).node);
  const crow = R.hav([by.ECCR.lat, by.ECCR.lng], [by.AERO.lat, by.AERO.lng]);
  assert.ok(r && r.meters < crow * 1.8, 'Engineering -> Aerospace routes on walkways (' + Math.round(r && r.meters) + ' m)');
});
