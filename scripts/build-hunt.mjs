// Herd and Seek — builds the demo routes from data/hunt/editions.src.json.
//
//   node scripts/build-hunt.mjs                         rebuild herd-editions.js (the copy the app carries for
//                                                       Friends Mode / Demo Practice, and for offline play)
//   node scripts/build-hunt.mjs --answers key.json      hash new answers into the source first
//   node scripts/build-hunt.mjs --sql out.sql           also write seed SQL for a NEW migration
//   node scripts/build-hunt.mjs --check                 fail if herd-editions.js is out of date (used by the tests)
//
// Answers never go in the repository. key.json lives on your own machine and looks like
//   {"demo-1": {"1": ["child"], "2": ["2", "two"]}, "demo-2": {...}}
// Each answer is stored as sha256(salt + ":" + answer with only letters/digits, lowercased).
// The database hashes answers typed into the admin view the same way (hunt_norm_answer / hunt_hash_answer).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const core = require('../herd-core.js');

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SRC = path.join(ROOT, 'data', 'hunt', 'editions.src.json');
const OUT = path.join(ROOT, 'herd-editions.js');
const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(name); return i >= 0 ? (args[i + 1] || true) : null; };

const src = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const cpById = Object.fromEntries(src.checkpoints.map(c => [c.id, c]));

// ---- optional: hash new answers into the source ----
const keyFile = opt('--answers');
if (keyFile) {
  const key = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
  for (const ed of src.editions) for (const p of ed.puzzles) {
    const answers = key[ed.id] && key[ed.id][String(p.no)];
    if (!answers) continue;
    if (!Array.isArray(answers) || !answers.length || answers.some(a => !core.normalizeAnswer(a))) throw new Error(`${ed.id} #${p.no}: answers must be a non-empty list of text`);
    p.answer_salt = crypto.randomBytes(16).toString('hex');
    p.answer_hashes = [];
    for (const a of answers) { const h = await core.hashAnswer(p.answer_salt, a); if (!p.answer_hashes.includes(h)) p.answer_hashes.push(h); }
    p.answer_hashes.sort();   // the database keeps them sorted too, so the two copies compare equal
  }
  fs.writeFileSync(SRC, JSON.stringify(src, null, 2) + '\n');
  console.log('Hashed answers into', path.relative(ROOT, SRC));
}

// ---- validate ----
for (const c of src.checkpoints) {
  if (!/^[a-z0-9-]{2,40}$/.test(c.id)) throw new Error('Bad checkpoint id ' + c.id);
  if (!(c.lat > 39.99 && c.lat < 40.025 && c.lng > -105.29 && c.lng < -105.235)) throw new Error(c.id + ': outside campus bounds');
  if (!(c.radius_m >= 15 && c.radius_m <= 150)) throw new Error(c.id + ': radius must be 15–150 m');
}
for (const ed of src.editions) {
  if (ed.puzzles.length !== core.CHECKPOINTS) throw new Error(ed.id + ': needs exactly ' + core.CHECKPOINTS + ' puzzles');
  ed.puzzles.forEach((p, i) => {
    if (p.no !== i + 1) throw new Error(`${ed.id}: puzzles must be numbered 1–5 in order`);
    if (!cpById[p.checkpoint]) throw new Error(`${ed.id} #${p.no}: unknown checkpoint ${p.checkpoint}`);
    if (!['observe', 'cipher', 'split'].includes(p.kind)) throw new Error(`${ed.id} #${p.no}: unknown kind`);
    if (p.kind === 'split' && !(Array.isArray(p.pieces) && p.pieces.length >= 2 && p.pieces.length <= 6)) throw new Error(`${ed.id} #${p.no}: split puzzles need 2–6 pieces`);
    if (!Array.isArray(p.hints) || p.hints.length !== core.MAX_HINTS) throw new Error(`${ed.id} #${p.no}: needs exactly ${core.MAX_HINTS} hints`);
    if (!p.answer_salt || !Array.isArray(p.answer_hashes) || !p.answer_hashes.length || p.answer_hashes.some(h => !/^[0-9a-f]{64}$/.test(h)))
      throw new Error(`${ed.id} #${p.no}: no hashed answer yet — run with --answers`);
  });
}

// ---- the published shape (the database builds the same thing in hunt_build_content) ----
function content(ed, version) {
  return {
    id: ed.id, version, title: ed.title, theme: ed.theme, style: ed.style, intro: ed.intro, demo: !!ed.demo,
    est_minutes: ed.est_minutes, walk_minutes: ed.walk_minutes,
    checkpoints: ed.puzzles.map(p => {
      const c = cpById[p.checkpoint];
      return {
        no: p.no, id: c.id, name: c.name, spot: c.spot, lat: c.lat, lng: c.lng, radius_m: c.radius_m,
        access_note: c.access_note, entrance_note: c.entrance_note, needs_onsite_check: !!c.needs_onsite_check,
        puzzle: {kind: p.kind, format: p.format, prompt: p.prompt, hints: p.hints, pieces: p.pieces || [],
                 needs_onsite_check: !!p.needs_onsite_check, onsite_note: p.onsite_note || ''}
      };
    })
  };
}
const answerKey = ed => Object.fromEntries(ed.puzzles.map(p => [String(p.no), {salt: p.answer_salt, hashes: p.answer_hashes}]));
const doc = ed => ({title: ed.title, theme: ed.theme, style: ed.style, intro: ed.intro, demo: !!ed.demo, est_minutes: ed.est_minutes, walk_minutes: ed.walk_minutes,
  puzzles: ed.puzzles.map(p => ({no: p.no, checkpoint: p.checkpoint, kind: p.kind, format: p.format, prompt: p.prompt, hints: p.hints, pieces: p.pieces || [],
    needs_onsite_check: !!p.needs_onsite_check, onsite_note: p.onsite_note || '', answer_salt: p.answer_salt, answer_hashes: p.answer_hashes}))});

const bundle = {editions: src.editions.map(ed => ({content: content(ed, 1), key: answerKey(ed)}))};
const js = `/* BuffPrints — Herd and Seek demo routes. GENERATED by scripts/build-hunt.mjs from data/hunt/editions.src.json — do not edit.
   Friends Mode and Demo Practice use this copy when the online service is off or unreachable, so they work with
   no server at all. It holds salted answer hashes, never answers. Competition Mode always asks the server. */
(function(root){
const data=${JSON.stringify(bundle)};
if(typeof module!=='undefined'&&module.exports) module.exports=data; else root.HERD_EDITIONS=data;
})(typeof window!=='undefined'?window:globalThis);
`;
if (args.includes('--check')) {
  if (!fs.existsSync(OUT) || fs.readFileSync(OUT, 'utf8') !== js) { console.error('herd-editions.js is out of date: run node scripts/build-hunt.mjs'); process.exit(1); }
  console.log('herd-editions.js is up to date');
} else {
  fs.writeFileSync(OUT, js);
  console.log('Wrote', path.relative(ROOT, OUT));
}

// ---- optional: seed SQL for a new migration ----
const sqlFile = opt('--sql');
if (sqlFile) {
  const q = v => v === null || v === undefined ? 'null' : typeof v === 'number' || typeof v === 'boolean' ? String(v) : "'" + String(v).replace(/'/g, "''") + "'";
  let sql = `-- BuffPrints — Herd and Seek: demo checkpoints and the three demo routes.
-- GENERATED by scripts/build-hunt.mjs --sql from data/hunt/editions.src.json.
-- Holds salted answer hashes only. Every coordinate and on-site detail is flagged
-- needs_onsite_check until someone walks the route (see docs/HERD_AND_SEEK.md).

insert into public.hunt_checkpoints (id, name, spot, lat, lng, radius_m, access_note, entrance_note, needs_onsite_check, source_note, sort) values
${src.checkpoints.map((c, i) => `  (${[c.id, c.name, c.spot, c.lat, c.lng, c.radius_m, c.access_note, c.entrance_note, !!c.needs_onsite_check, c.source || '', i + 1].map(q).join(', ')})`).join(',\n')};

insert into public.hunt_editions (id, sort, status) values
${src.editions.map((e, i) => `  (${q(e.id)}, ${i + 1}, 'active')`).join(',\n')};

`;
  for (const ed of src.editions) sql += `select public.hunt_publish_internal(${q(ed.id)}, $hunt$${JSON.stringify(doc(ed))}$hunt$::jsonb);\n`;
  sql += `\n-- One row per counter, so play only ever adds 1 to a number that already exists.\nselect public.hunt_seed_metrics(id) from public.hunt_editions;\n`;
  fs.writeFileSync(sqlFile, sql);
  console.log('Wrote', sqlFile);
}
