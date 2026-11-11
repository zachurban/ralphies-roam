// Builds paths.geojson for Ralphie's Roam from OpenStreetMap walkways.
// Run by .github/workflows/update-paths.yml (or locally: node scripts/build-paths.mjs).
// Data © OpenStreetMap contributors, ODbL.
import fs from 'fs';

const BBOX = [39.9985, -105.2785, 40.0142, -105.2565]; // south, west, north, east — CU Boulder main campus
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter'
];
const bb = BBOX.join(',');

async function overpass(q) {
  if (process.env.OSM_FIXTURE) return JSON.parse(fs.readFileSync(process.env.OSM_FIXTURE, 'utf8'))[q.includes('highway') ? 'paths' : 'marks'];
  for (let round = 1; round <= 4; round++) {          // public servers are often busy: retry with backoff
    for (const url of ENDPOINTS) {
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'ralphies-roam/1.0 (github.com/zachurban/ralphies-roam)' },
          body: 'data=' + encodeURIComponent(q),
          signal: AbortSignal.timeout(150000)
        });
        if (r.ok) { console.log('Overpass OK via', url); return await r.json(); }
        console.error('round', round, url, 'HTTP', r.status);
      } catch (e) { console.error('round', round, url, e.message); }
    }
    await new Promise(res => setTimeout(res, 30000 * round));
  }
  throw new Error('All Overpass endpoints failed');
}

const paths = await overpass(`[out:json][timeout:120];way["highway"~"^(footway|path|pedestrian|steps|cycleway|track|bridleway|living_street)$"](${bb});out geom;`);
const marks = await overpass(`[out:json][timeout:60];nwr["name"~"Norlin|Farrand Field|Engineering Center|Kittredge|Varsity|Old Main|Macky",i](${bb});out geom;`);

// ---- zones: boxes around named OSM landmarks (fallbacks if a name isn't found) ----
const M_LAT = 111320, M_LNG = 111320 * Math.cos(40.007 * Math.PI / 180);
const ZONES = [
  { id: 'norlin',      match: /norlin/i,                 pad: 70, fallback: [40.0080, -105.2735, 40.0098, -105.2700] },
  { id: 'varsity',     match: /varsity|old main|macky/i, pad: 50, fallback: [40.0090, -105.2740, 40.0108, -105.2700] },
  { id: 'farrand',     match: /farrand field/i,          pad: 60, fallback: [40.0050, -105.2675, 40.0072, -105.2640] },
  { id: 'engineering', match: /engineering center/i,     pad: 70, fallback: [40.0060, -105.2650, 40.0085, -105.2610] },
  { id: 'kittredge',   match: /kittredge/i,              pad: 60, fallback: [40.0015, -105.2615, 40.0045, -105.2575] }
];
function pts(el) {
  if (el.type === 'node') return [[el.lat, el.lon]];
  if (el.geometry) return el.geometry.map(p => [p.lat, p.lon]);
  if (el.members) return el.members.flatMap(m => (m.geometry || []).map(p => [p.lat, p.lon]));
  if (el.bounds) return [[el.bounds.minlat, el.bounds.minlon], [el.bounds.maxlat, el.bounds.maxlon]];
  return [];
}
for (const z of ZONES) {
  const hits = marks.elements.filter(el => el.tags && !el.tags.highway && !/townhouse|apartment|pump station/i.test(el.tags.name || '') && z.match.test(el.tags.name || ''));
  const all = hits.flatMap(pts);
  if (all.length) {
    const dLat = z.pad / M_LAT, dLng = z.pad / M_LNG;
    z.box = [Math.min(...all.map(p => p[0])) - dLat, Math.min(...all.map(p => p[1])) - dLng,
             Math.max(...all.map(p => p[0])) + dLat, Math.max(...all.map(p => p[1])) + dLng];
    z.from = [...new Set(hits.map(h => h.tags.name))].join('; ');
  } else { z.box = z.fallback; z.from = 'fallback box'; }
  console.log('zone', z.id, '←', z.from);
}
const inBox = (p, b) => p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3];

// ---- walkways ----
const UNPAVED = /^(dirt|ground|earth|grass|mud|sand|unpaved|gravel|fine_gravel|compacted|woodchips|rock)$/;
function label(t) {
  if (t.name) return t.name;
  if (t.highway === 'steps') return 'Stairs';
  if (t.bridge && t.bridge !== 'no') return 'Footbridge';
  if (t.footway === 'crossing') return 'Crosswalk';
  if (t.footway === 'sidewalk') return 'Sidewalk';
  if (t.highway === 'path' || t.highway === 'track') return 'Trail';
  if (t.highway === 'cycleway') return 'Bike & walk path';
  return 'Walkway';
}
let km = 0;
const features = [];
for (const w of paths.elements) {
  const t = w.tags || {};
  if (w.type !== 'way' || !w.geometry || w.geometry.length < 2) continue;
  if (/^(private|no)$/.test(t.access || '') || /^(no)$/.test(t.foot || '')) continue;
  if (t.area === 'yes' || t.indoor === 'yes' || t.level && t.level !== '0' && t.indoor) continue;
  const coords = w.geometry.map(p => [+p.lon.toFixed(6), +p.lat.toFixed(6)]);
  const mid = w.geometry[Math.floor(w.geometry.length / 2)];
  const midP = [mid.lat, mid.lon];
  const tags = [];
  if (t.highway === 'steps') tags.push('stairs');
  if (t.bridge && t.bridge !== 'no') tags.push('bridge');
  if (t.informal === 'yes' || t.highway === 'track' || (t.highway === 'path' && UNPAVED.test(t.surface || ''))) tags.push('goat');
  let zone = /boulder creek/i.test(t.name || '') ? 'creek' : (ZONES.find(z => inBox(midP, z.box)) || { id: 'campus' }).id;
  for (let i = 1; i < w.geometry.length; i++) {
    const a = w.geometry[i - 1], b = w.geometry[i];
    km += Math.hypot((a.lat - b.lat) * M_LAT, (a.lon - b.lon) * M_LNG) / 1000;
  }
  features.push({ type: 'Feature', properties: { id: 'w' + w.id, zone, name: label(t), tags },
                  geometry: { type: 'LineString', coordinates: coords } });
}
features.sort((a, b) => a.properties.id.localeCompare(b.properties.id, 'en', { numeric: true }));
const out = {
  type: 'FeatureCollection',
  attribution: '© OpenStreetMap contributors, ODbL',
  bbox: [BBOX[1], BBOX[0], BBOX[3], BBOX[2]],
  features
};
fs.writeFileSync(process.env.OUT || 'paths.geojson', JSON.stringify(out));
const by = {};
features.forEach(f => by[f.properties.zone] = (by[f.properties.zone] || 0) + 1);
console.log(features.length, 'walkways,', km.toFixed(1), 'km;', JSON.stringify(by),
  'stairs', features.filter(f => f.properties.tags.includes('stairs')).length,
  'bridges', features.filter(f => f.properties.tags.includes('bridge')).length,
  'goat', features.filter(f => f.properties.tags.includes('goat')).length);
if (features.length < (process.env.OSM_FIXTURE ? 1 : 50)) { console.error('Suspiciously few walkways — not writing a broken file'); process.exit(1); }
