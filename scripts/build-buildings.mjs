// Builds buildings.json for BuffPrints: CU building codes -> location + simplified outline,
// used to turn a class schedule into walking routes. Data © OpenStreetMap contributors, ODbL.
// Run by .github/workflows/update-paths.yml, or locally: node scripts/build-buildings.mjs
// (set OSM_BUILDINGS_FIXTURE=file.json to build from a saved Overpass response instead of the network).
import fs from 'fs';

const BBOX = [39.985, -105.285, 40.020, -105.235].join(','); // main campus, Grandview, East Campus (west part), Williams Village
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter'
];
const Q = `[out:json][timeout:120];(
  way[building][short_name](${BBOX}); relation[building][short_name](${BBOX});
  way[building][ref](${BBOX});        relation[building][ref](${BBOX});
  way[building][name](${BBOX});       relation[building][name](${BBOX});
  way[amenity=parking][parking=multi-storey](${BBOX});
);out tags geom;`;

async function overpass(q) {
  if (process.env.OSM_BUILDINGS_FIXTURE) return JSON.parse(fs.readFileSync(process.env.OSM_BUILDINGS_FIXTURE, 'utf8'));
  for (let round = 1; round <= 4; round++) {
    for (const url of ENDPOINTS) {
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'buffprints/1.0 (github.com/zachurban/ralphies-roam)' },
          body: 'data=' + encodeURIComponent(q), signal: AbortSignal.timeout(150000)
        });
        if (r.ok) { console.log('Overpass OK via', url); return await r.json(); }
        console.error('round', round, url, 'HTTP', r.status);
      } catch (e) { console.error('round', round, url, e.message); }
    }
    await new Promise(res => setTimeout(res, 30000 * round));
  }
  throw new Error('All Overpass endpoints failed');
}

const r6 = x => Math.round(x * 1e6) / 1e6;
// Outer ring of a way, or the longest member way of a relation; returns [[lat,lng],...]
function ring(e) {
  if (e.geometry) return e.geometry.map(p => [p.lat, p.lon]);
  if (e.members) {
    const outer = e.members.filter(m => m.geometry && m.role !== 'inner').sort((a, b) => b.geometry.length - a.geometry.length)[0];
    if (outer) return outer.geometry.map(p => [p.lat, p.lon]);
  }
  if (e.center) return [[e.center.lat, e.center.lon]];
  return [];
}
// Keep at most n evenly spaced vertices: enough to find the side of the building nearest a walkway.
function thin(pts, n) {
  if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts = pts.slice(0, -1);
  if (pts.length <= n) return pts;
  const out = []; for (let i = 0; i < n; i++) out.push(pts[Math.floor(i * pts.length / n)]); return out;
}
function centroid(pts) { const a = pts.reduce((s, p) => [s[0] + p[0], s[1] + p[1]], [0, 0]); return [a[0] / pts.length, a[1] / pts.length]; }

const HOUSING_NAME = /\b(hall|court|towers?|apartments?|village north|commons)\b/i;
function kindOf(t) {
  if (t.amenity === 'parking' || t.building === 'parking' || /autopark|parking garage/i.test(t.name || '')) return 'parking';
  if (['dormitory', 'residential', 'apartments'].includes(t.building)) return 'home';
  return 'class';
}
function codesOf(t) {
  const out = new Set();
  for (const k of ['short_name', 'alt_name', 'ref']) for (const c of String(t[k] || '').split(/[;,]/)) {
    const v = c.trim().toUpperCase(); if (/^[A-Z][A-Z0-9-]{1,6}$/.test(v)) out.add(v);
  }
  return [...out];
}

const data = await overpass(Q);
const alias = JSON.parse(fs.readFileSync(new URL('../data/building-aliases.json', import.meta.url), 'utf8'));
const byCode = {}, byName = {}, homes = [];
for (const e of data.elements || []) {
  const t = e.tags || {}, pts = ring(e); if (!pts.length || !t.name && !codesOf(t).length) continue;
  const c = centroid(pts), b = {
    name: t.name || codesOf(t)[0], kind: kindOf(t), lat: r6(c[0]), lng: r6(c[1]),
    outline: thin(pts, 16).map(p => [r6(p[0]), r6(p[1])])
  };
  if (t.name) byName[t.name.toLowerCase()] = b;
  for (const code of codesOf(t)) if (!byCode[code]) byCode[code] = Object.assign({ code }, b);
  if (b.kind === 'parking' || b.kind === 'home' || (HOUSING_NAME.test(t.name || '') && t.building !== 'university')) homes.push(Object.assign({ code: codesOf(t)[0] || null }, b));
}
for (const [code, name] of Object.entries(alias.byName)) {
  const b = byName[name.toLowerCase()]; if (b && !byCode[code]) byCode[code] = Object.assign({ code }, b);
  else if (!b) console.warn('alias name not found in OSM:', code, name);
}
const sameAs = {};
for (const [code, target] of Object.entries(alias.sameBuilding)) if (byCode[target] && !byCode[code]) sameAs[code] = target;

// Home/start picker: CU housing that carries an official code (plus hand-named halls), one entry per
// complex (Athens Court A1..C2 -> Athens Court), and multi-storey parking. Everyone else taps the map.
const named = new Set(Object.values(alias.byName).map(n => n.toLowerCase()));
const groups = {};
for (const h of homes) {
  if (h.kind !== 'parking' && !h.code && !named.has(h.name.toLowerCase())) continue;
  if (h.kind !== 'parking' && /ancillary|office|dining|recreation|lofts|apartments/i.test(h.name)) continue;
  if (h.kind === 'parking' && !(h.lat > 39.995 && h.lat < 40.013 && h.lng > -105.28 && h.lng < -105.24)) continue; // campus garages only
  const label = h.name.replace(/\s+(?:[A-Z]{1,2}\d{0,2}|\d{1,2}[A-Z]?)$/, '').replace(/^Hallet Hall$/, 'Hallett Hall').replace(/\s+\d+\/\d+.*$/, '');
  if (label.length < 4) continue;
  (groups[label] = groups[label] || []).push(h);
}
const places = Object.entries(groups).map(([name, hs]) => {
  const pts = hs.flatMap(h => h.outline), c = centroid(hs.map(h => [h.lat, h.lng]));
  return { code: hs.length === 1 ? hs[0].code : null, name, kind: hs[0].kind === 'parking' ? 'parking' : 'home',
    lat: r6(c[0]), lng: r6(c[1]), outline: thin(pts, 24) };
}).sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'home' ? -1 : 1);

const out = {
  attribution: 'Building locations © OpenStreetMap contributors (ODbL)',
  generated: new Date().toISOString().slice(0, 10),
  buildings: Object.values(byCode).sort((a, b) => a.code.localeCompare(b.code)),
  sameAs,
  places
};
fs.writeFileSync(new URL('../buildings.json', import.meta.url), JSON.stringify(out));
console.log('buildings', out.buildings.length, 'aliases', Object.keys(sameAs).length, 'home/parking places', places.length);
