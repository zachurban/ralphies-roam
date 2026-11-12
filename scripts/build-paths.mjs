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
  if (process.env.OSM_FIXTURE) {
    const fx = JSON.parse(fs.readFileSync(process.env.OSM_FIXTURE, 'utf8'));
    return fx[q.includes('highway') ? 'paths' : q.includes('dormitory') ? 'dorms' : q.includes('Williams Village') ? 'wv' : 'marks'] || { elements: [] };
  }
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

// ---- Williams Village (separate area southeast of main campus): outline from its named buildings ----
const M_LAT0 = 111320, M_LNG0 = 111320 * Math.cos(40.0 * Math.PI / 180);
const WV_FALLBACK = [39.9945, -105.2530, 40.0010, -105.2435];
const wvEls = await overpass(`[out:json][timeout:60];nwr["name"~"Williams Village|Darley|Stearns|Bear Creek Apartments",i](39.985,-105.265,40.008,-105.235);out geom;`);
// only buildings and grounds — skip bus routes, roads and businesses that merely share the name
const wvKeep = e => e.tags && !e.tags.highway && !e.tags.route && e.tags.type !== 'route' && !e.tags.shop && !/liquor/i.test(e.tags.name || '') &&
  (e.tags.building || e.tags.amenity || e.tags.leisure || e.tags.landuse);
const wvPts = wvEls.elements.filter(wvKeep).flatMap(e =>
  e.type === 'node' ? [[e.lat, e.lon]] : (e.geometry || (e.members || []).flatMap(m => m.geometry || [])).map(g => [g.lat, g.lon]));
let WV = WV_FALLBACK, wvFrom = 'fallback box';
if (wvPts.length) {
  const pad = 70;
  WV = [Math.min(...wvPts.map(p => p[0])) - pad / M_LAT0, Math.min(...wvPts.map(p => p[1])) - pad / M_LNG0,
        Math.max(...wvPts.map(p => p[0])) + pad / M_LAT0, Math.max(...wvPts.map(p => p[1])) + pad / M_LNG0];
  wvFrom = [...new Set(wvEls.elements.filter(wvKeep).map(e => e.tags.name))].join('; ');
}
// sanity: never let a bad match balloon the area past ~1.5 km
if ((WV[2] - WV[0]) * M_LAT0 > 1500 || (WV[3] - WV[1]) * M_LNG0 > 1500) { WV = WV_FALLBACK; wvFrom += ' (too large — fallback used)'; }
const wvbb = WV.map(v => v.toFixed(5)).join(',');

// Prefer CU's actual Williams Village property outline over a rectangle (keeps out neighborhood sidewalks)
const wvAreas = wvEls.elements.filter(e => e.tags && !e.tags.building && !e.tags.route && e.type !== 'node' &&
  (e.tags.amenity === 'university' || e.tags.landuse || e.tags.place) && /williams village/i.test(e.tags.name || ''))
  .map(e => ({ name: e.tags.name,
    edges: (e.type === 'way' ? [e.geometry || []] : (e.members || []).filter(m => m.geometry).map(m => m.geometry))
      .flatMap(g => g.slice(1).map((q, i) => [[g[i].lat, g[i].lon], [q.lat, q.lon]])) }))
  .filter(a => a.edges.length >= 3);
function pip(p, edges) {        // even-odd ray cast; works for multipolygons split across member ways
  let inside = false;
  for (const [a, b] of edges) {
    if ((a[0] > p[0]) !== (b[0] > p[0]) && p[1] < (b[1] - a[1]) * (p[0] - a[0]) / (b[0] - a[0]) + a[1]) inside = !inside;
  }
  return inside;
}
function edgeDist(p, edges) {   // meters to the outline
  let best = Infinity;
  for (const [a, b] of edges) {
    const ax = (a[1] - p[1]) * M_LNG0, ay = (a[0] - p[0]) * M_LAT0, bx = (b[1] - p[1]) * M_LNG0, by = (b[0] - p[0]) * M_LAT0;
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}
const inWV = p => wvAreas.length ? wvAreas.some(a => pip(p, a.edges) || edgeDist(p, a.edges) < 20) : inBox(p, WV);
console.log('Williams Village outline:', wvAreas.length ? wvAreas.map(a => a.name + ' (' + a.edges.length + ' edges)').join('; ') : 'none found — using box');
console.log('Williams Village box', wvbb, Math.round((WV[2]-WV[0])*M_LAT0)+' x '+Math.round((WV[3]-WV[1])*M_LNG0)+' m', '←', wvFrom);

const HW = '"highway"~"^(footway|path|pedestrian|steps|cycleway|track|bridleway|living_street)$"';
const paths = await overpass(`[out:json][timeout:120];(way[${HW}](${bb});way[${HW}](${wvbb}););out geom;`);
const marks = await overpass(`[out:json][timeout:60];nwr["name"~"Norlin|Farrand Field|Engineering Center|Kittredge|Varsity|Old Main|Macky",i](${bb});out geom;`);

// Residence halls for the dorm pick list (wider box to include Williams Village)
const dormEls = await overpass(`[out:json][timeout:60];nwr["building"="dormitory"]["name"](39.985,-105.285,40.020,-105.235);out tags;`);
const dorms = [...new Set(dormEls.elements.map(e => (e.tags && e.tags.name || '').trim())
  .filter(n => n && n.length <= 40 && !/parking|garage|dining|center$/i.test(n)))].sort((a, b) => a.localeCompare(b));
console.log('dorms', dorms.length, dorms.join(' | '));

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
function inBox(p, b) { return p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3]; }

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
const seenWays = new Set();
for (const w of paths.elements) {
  if (seenWays.has(w.id)) continue; seenWays.add(w.id);
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
  const isWV = inWV(midP);
  if (!isWV && !inBox(midP, BBOX)) continue;   // came from the Williams Village query but lies outside CU's property
  let zone = /boulder creek/i.test(t.name || '') ? 'creek'
           : isWV ? 'williams'
           : (ZONES.find(z => inBox(midP, z.box)) || { id: 'campus' }).id;
  for (let i = 1; i < w.geometry.length; i++) {
    const a = w.geometry[i - 1], b = w.geometry[i];
    km += Math.hypot((a.lat - b.lat) * M_LAT, (a.lon - b.lon) * M_LNG) / 1000;
  }
  features.push({ type: 'Feature', properties: { id: 'w' + w.id, zone, name: label(t), tags, ...(t.name ? { named: true } : {}) },
                  geometry: { type: 'LineString', coordinates: coords } });
}
features.sort((a, b) => a.properties.id.localeCompare(b.properties.id, 'en', { numeric: true }));
const out = {
  type: 'FeatureCollection',
  attribution: '© OpenStreetMap contributors, ODbL',
  bbox: [Math.min(BBOX[1], WV[1]), Math.min(BBOX[0], WV[0]), Math.max(BBOX[3], WV[3]), Math.max(BBOX[2], WV[2])],
  dorms,
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
