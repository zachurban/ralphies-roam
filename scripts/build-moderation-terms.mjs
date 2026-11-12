#!/usr/bin/env node
// Builds a Supabase migration that loads the English "List of Dirty, Naughty,
// Obscene, and Otherwise Bad Words" (LDNOOBW, CC BY 4.0) into
// public.moderation_terms as whole-word and phrase rules.
//
//   node scripts/build-moderation-terms.mjs                  # latest from the npm registry
//   node scripts/build-moderation-terms.mjs --from en.json   # a local copy
//   node scripts/build-moderation-terms.mjs --version 1.2.0 --out supabase/migrations/<stamp>_moderation_baseline_ldnoobw.sql
//
// Why whole words only: the maintained list is broad, and as substrings many of
// its entries would block ordinary names. Substring, leetspeak and stretched-
// letter coverage for the worst terms comes from the app policy in
// 20261112190000_usernames.sql. Re-running writes a NEW migration that adds new
// terms and re-enables existing ones (it never deletes; disable a term with
// admin_set_term_enabled).
//
// EXCLUDED lists entries we reviewed and chose not to block in nicknames because
// they are ordinary words, names, games, or identity/viewpoint references
// (the policy moderates harmful content, not who someone is or what they think).
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';

const EXCLUDED = new Set([
  // ordinary words, hobbies, games, names
  'suck', 'sucks', 'escort', 'eunuch', 'hardcore', 'snatch', 'twinkie', 'scat', 'swinger', 'hooker', 'fingering',
  'skeet', 'barenaked', 'bareback', 'domination', 'shrimping', 'snowballing', 'scissoring', 'figging', 'cornhole',
  'shota', 'guro', 'xx', 'santorum',
  // identity or reclaimed terms that aren't harmful by themselves
  'twink', 'sexuality',
  // phrases that are harmless in a nickname ("BigBlackBear", "TiedUpInKnots")
  'big black', 'hot chick', 'tied up', 'tainted love', 'girl on', 'girl on top', 'taste my', 'tongue in a', 'tight white',
  'jelly donut', 'dirty pillows', 'pleasure chest', 'leather restraint', 'leather straight jacket', 'prince albert piercing',
  'mound of venus', 'venus mound', 'violet wand', 'chocolate rosebuds', 'blonde action', 'blonde on blonde action',
  'brunette action', 'sultry women', 'wrapping men', 'girls gone wild', 'lemon party', 'alaskan pipeline', 'rosy palm',
  'mr hands', 'ball kicking', 'hard core', 's m'
]);

// Category for the database (used only for admin triage, never shown to students).
const SLURS = new Set(['beaner', 'beaners', 'coon', 'coons', 'darkie', 'fag', 'faggot', 'honkey', 'jigaboo', 'jiggaboo',
  'jiggerboo', 'kike', 'mong', 'negro', 'nigga', 'nigger', 'paki', 'pikey', 'poof', 'raghead', 'shemale', 'slanteye',
  'spastic', 'spic', 'towelhead', 'tranny', 'wetback', 'carpetmuncher', 'fudgepacker', 'bulldyke', 'nig nog', 'neonazi',
  'swastika', 'white power', 'fudge packer', 'carpet muncher']);
const VIOLENCE = new Set(['how to kill', 'how to murder', 'rape', 'raping', 'rapist', 'date rape', 'daterape']);
const PROFANITY = new Set(['apeshit', 'arsehole', 'ass', 'asshole', 'assmunch', 'bastard', 'bastardo', 'bitch', 'bitches',
  'bollocks', 'bullshit', 'cunt', 'fuck', 'fuckin', 'fucking', 'fucktards', 'motherfucker', 'shit', 'shitty', 'shitblimp',
  'tosser', 'twat', 'wank', 'god damn', 'piece of shit', 'clusterfuck', 'dingleberry', 'dingleberries']);
const SPAM = new Set(['cialis', 'viagra', 'thumbzilla', 'voyeurweb', 'worldsex', 'bangbros', 'bangbus', 'babeland']);

function args() {
  const a = process.argv.slice(2), o = {};
  for (let i = 0; i < a.length; i++) if (a[i].startsWith('--')) o[a[i].slice(2)] = a[i + 1] && !a[i + 1].startsWith('--') ? a[++i] : true;
  return o;
}

// Minimal tar reader (npm tarballs are plain ustar)
function untar(buf) {
  const files = {};
  for (let off = 0; off + 512 <= buf.length;) {
    const name = buf.subarray(off, off + 100).toString().replace(/\0.*$/s, '');
    if (!name) break;
    const size = parseInt(buf.subarray(off + 124, off + 136).toString().replace(/\0.*$/s, '').trim() || '0', 8);
    files[name] = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

async function load(o) {
  if (o.from) return { words: JSON.parse(fs.readFileSync(o.from, 'utf8')), version: o.version || 'local' };
  const meta = await (await fetch('https://registry.npmjs.org/naughty-words/' + (o.version || 'latest'))).json();
  const tgz = Buffer.from(await (await fetch(meta.dist.tarball)).arrayBuffer());
  const files = untar(zlib.gunzipSync(tgz));
  return { words: JSON.parse(files['package/en.json'].toString('utf8')), version: meta.version };
}

export function normalize(entry) {
  const t = String(entry).toLowerCase().replace(/[^a-z]+/g, ' ').trim().replace(/ +/g, ' ');
  return t;
}

export function categorize(t) {
  if (SLURS.has(t)) return 'slur';
  if (VIOLENCE.has(t)) return 'violence';
  if (PROFANITY.has(t)) return 'profanity';
  if (SPAM.has(t)) return 'spam';
  return 'sexual';
}

export function buildRows(words) {
  const rows = new Map();
  for (const w of words) {
    if (/[0-9]/.test(w)) continue;                       // "2g1c"-style codes don't survive leet normalization
    const t = normalize(w);
    if (t.length < 3 || EXCLUDED.has(t)) continue;
    rows.set(t, { term: t, match: t.includes(' ') ? 'phrase' : 'token', category: categorize(t) });
  }
  return [...rows.values()].sort((a, b) => a.term.localeCompare(b.term));
}

export function toSQL(rows, version) {
  const q = s => "'" + s.replace(/'/g, "''") + "'";
  return `-- GENERATED by scripts/build-moderation-terms.mjs — do not edit by hand.
-- Source: List of Dirty, Naughty, Obscene, and Otherwise Bad Words (English),
-- npm "naughty-words" ${version}, https://github.com/LDNOOBW — licensed CC BY 4.0.
-- Loaded as whole-word / phrase rules; reviewed exclusions are listed in the script.
insert into public.moderation_terms (term, category, match, source) values
${rows.map(r => `  (${q(r.term)}, ${q(r.category)}, ${q(r.match)}, 'ldnoobw')`).join(',\n')}
on conflict (term, match) do update set enabled = true;
`;
}

if (import.meta.url === 'file://' + path.resolve(process.argv[1])) {
  const o = args();
  const { words, version } = await load(o);
  const rows = buildRows(words);
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const out = o.out || `supabase/migrations/${stamp}_moderation_baseline_ldnoobw.sql`;
  fs.writeFileSync(out, toSQL(rows, version));
  console.log(`Wrote ${rows.length} terms from naughty-words ${version} to ${out}`);
}
