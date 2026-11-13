# Herd and Seek (Phase 1)

A campus scavenger hunt inside BuffPrints: five outdoor checkpoints, five puzzles, 20–40 minutes, solo or with friends. It is built to collect as little as possible. No volunteers, no signs or stickers on campus, no native app, no Web Bluetooth or Web NFC.

Player page: `herd.html`. Admin page: `herd-admin.html`. Privacy notice: [PRIVACY.md](../PRIVACY.md).

## What is in this phase

| | |
|---|---|
| Friends Mode | No sign-in. Nothing written to the database about anyone. |
| Competition Mode | Sign-in. Minimal rows (below). Weekly standings, demo reward token. |
| Demo Practice | Simulated check-ins, watermarked. No points, no tokens, not counted. |
| Herd sync | Phone to phone through an encrypted relay. Reload-safe. |
| Phone-to-phone QR | Join a herd, pass a clue piece, rolling "we're together" code (also the weak-GPS fallback). |
| Routes | Three demo editions on the same five checkpoints: observation, cipher, split-clue. |
| Admin | Allowlisted editor for checkpoints, routes (JSON), flags, status, counters. |

Deferred to Phase 2: sponsor campaigns, inventory reservation locks, a sponsor redemption portal, sponsor audit reports. Hooks: `hunt_reward_tokens.kind` (only `'demo'` is allowed today) and `status`; `hunt_editions`. Nothing in Phase 1 needs to change shape.

## Files

| File | Purpose |
|---|---|
| `herd.html`, `herd.css`, `herd-app.js` | Player screens. |
| `herd-core.js` | The rules: geofence, scoring, encryption, rolling codes, herd state and sync. No DOM; shared with the tests. |
| `herd-editions.js` | Generated copy of the demo routes (salted answer hashes, never answers) so Friends Mode and Demo Practice work with no server. |
| `herd-admin.html` | Admin editor. |
| `data/hunt/editions.src.json`, `scripts/build-hunt.mjs` | Source for the demo routes and the script that builds `herd-editions.js` and seed SQL. |
| `vendor/` | QR generation and scanning (see `vendor/README.md`). |
| `supabase/migrations/20261112210000_find_the_herd.sql` | Tables, lock-down, check-in/scoring/standings/admin functions, account-deletion hook. |
| `supabase/migrations/20261112210100_find_the_herd_seed.sql` | Five checkpoints and three demo routes (generated). |

## How the privacy design works

**The herd key.** Creating a herd makes 32 random bytes on the phone. They go in the invite link after the `#` (`herd.html#key=…`) and in the invite QR. Browsers never send that part of a URL to a server; the page reads it once and removes it from the address bar. From it the phone derives (HKDF) an AES-GCM key, an HMAC key and the relay channel name (a one-way hash).

**The relay.** Supabase Realtime **Broadcast, sent by clients**. Not database-triggered broadcast (that is stored for days) and not Presence (that would tell the server who is online together). Every packet is `v1.<nonce>.<ciphertext>`. The relay sees ciphertext, a channel name it can't reverse, packet sizes and timing, and (like any server) IP addresses.

**On the phone.** The herd is stored in `localStorage` as ciphertext. The derived keys are kept in IndexedDB as *non-extractable* keys: the page can use them after a relaunch but nothing can read them back out. The raw invite key is kept only for the current tab (so the invite QR can be shown again); after a cold relaunch the herd still works but can't mint new invites from that phone.

**Sync.** Herd state only grows (a check-in is never undone), so phones merge in any order. A phone that (re)connects says hello; the others reply with what they have; whoever knows more says so once. If every phone in a herd is closed at once, each still has its own copy.

**Check-in.** "Check in here" asks for foreground GPS, compares distance and reported accuracy with the checkpoint **on the phone**, and discards the fixes. Inside = within the radius, allowing up to 25 m of the accuracy circle; a fix worse than ±65 m proves nothing. Only `inside: true` is kept. In Competition Mode the server receives `(team, checkpoint number, in_geofence: true, answer)`.

**Rolling code.** `HMAC(herd key, peer | checkpoint | 7-second window)` as a QR and as six digits (camera-free fallback). Accepted for the current window, two back and one ahead. Verified phone to phone; no server.

### What the server stores

Friends Mode and Demo Practice: no rows. They call `hunt_get_editions`, `hunt_check_answer` (read-only) and the counter.

Competition Mode:

| Table | Columns |
|---|---|
| `hunt_checkins` | `user_id, team_id, edition_id, checkpoint_id, checkpoint_no, completed_at, in_geofence` (can only be `true`) |
| `hunt_teams` | `id, edition_id, edition_version, week, team_name, avatar, roster_locked, puzzles_solved, final_score` |
| `hunt_members` | `team_id, user_id, edition_id, counts, cu_verified` |
| `hunt_team_puzzles` | `team_id, checkpoint_no, hints_used, solved, points` |
| `hunt_reward_tokens` | `token, user_id, team_id, edition_id, kind, status, issued_week, used_at` |
| `hunt_metrics` | `edition_id, metric_key, count` |

The brief listed per-participant `edition_id, checkpoint_id, completed_at, in_geofence` and per-team name, avatar, edition, puzzle count, score and token. The extra columns are what scoring needs and nothing more: who is on the roster, the version lock and week, hints used per checkpoint (for the 20-point deduction), and two yes/no flags per member. `tests/hunt.sql.test.cjs` pins these column lists, so adding one fails the build.

Every table has RLS on with no policies and no grants; the API can't read or write them. All access is through `SECURITY DEFINER` functions.

## Rules as implemented

- **Checkpoint:** 100 points, needs your own proximity check-in *and* the herd's solved puzzle. Each hint the herd reveals costs 20 (two hints, floor of 60). All five: +100. Maximum 600. No speed or distance bonus.
- **Unlocking:** the puzzle opens for the whole herd when any teammate checks in. Each player still needs their own check-in (GPS, or a present teammate's rolling code) for credit. You must be checked in to submit an answer or reveal a hint.
- **Team score:** the average, over players who have checked in somewhere, of their personal points. Five players can't outscore two.
- **Roster:** freezes when the team completes its first checkpoint. Up to 8 players.
- **Any order.** Checkpoints are numbered for a sensible walk but can be done in any order (so "Checkpoint 1 completed" in the brief became "first completed checkpoint").
- **First run counts:** a player's first competitive run of a route is the one that counts. A second team in the same week, or any run after finishing once, is a repeat: playable, scored on screen, not in standings, no second token. A run belongs to its Monday–Sunday week (`rr_week`, America/Denver); when the week ends, unfinished runs close with their credit kept, and an unfinished first run doesn't block a fresh one next week.
- **Leaving:** before any check-in you are simply removed. After that you keep your credit, stay on the frozen roster, and can finish solo; those check-ins still count for the team.
- **colorado.edu:** anyone can sign in and play. A herd is listed when at least one scoring player has a verified (confirmed) `@colorado.edu` address; it carries the ✓ badge when all do. Tokens and dorm standings are for verified players only.
- **Standings:** per route, per week. Herds (name, avatar, affiliation, score) and dorms/teams (average personal score of verified players, from the existing profile dorm/team field). Ties share a rank.
- **Versions:** every publish is a new immutable version; a run stays on the version it started with.
- **Co-op "together" stamp:** cosmetic. It is worth no points, so solo players lose nothing.
- **Counters:** `increment_hunt_metric(edition_id, metric_key)` adds 1 to an existing row. Friends Mode increments them too (set `METRICS_IN_FRIENDS_MODE = false` in `herd-app.js` to stop); Demo Practice doesn't, apart from the route view counted before a mode is chosen.

## Setup

1. **Review before merging.** Migrations run when this reaches `main`. Until then nothing is deployed.
2. **Realtime:** in Supabase → Realtime → Settings, **Allow public access** must be on (the default). The relay uses public channels named `herd-<32 hex>`; the payloads are ciphertext.
3. **Admins:** in the SQL editor, `insert into public.admin_allowlist (email) values ('you@colorado.edu');` (lowercase). There is no sign-up path. The account's address must be confirmed and match the allowlist.
4. **Sign-in:** the same 6-digit email code as the main app (README → "Home-screen sign-in").
5. **Soft launch:** the Home card and Community link are hidden until you set `findTheHerdLinks: true` in `config.js`. Until then the hunt opens only from a direct link to `herd.html` (invite links work as normal). Walk the route, fix pins and answers in the admin view, then flip the switch.
6. After changing app files, bump `VERSION` in `sw.js` and the `?v=` numbers.

## Admin view (`herd-admin.html`)

- **Funnel:** per-route counters and teams this week.
- **Checkpoints:** name, spot, coordinate, radius, notes and the `needs_onsite_check` flag. Saving republishes the routes that use it.
- **Routes:** status (active/paused), version, puzzle table with stored answer hashes, and a JSON editor. Paused routes aren't offered for new runs; runs under way may finish.
- **Answers** are stored only as salted SHA-256 (`sha256(salt + ":" + letters-and-digits-lowercased)`), so they can't be displayed. To change one, add `"answers": ["new", "also ok"]` to that puzzle and publish. Leaving a puzzle alone keeps its answers.
- **New route:** an id and a document; it starts paused.

### The demo answers

The answers to the three demo routes are **not in this repository** (it is public; the hashes are). Keep the answer key somewhere private. To rebuild the demo routes from a key file: `node scripts/build-hunt.mjs --answers key.json --sql new-migration.sql`. Editing routes in the admin view is the normal path and needs no script.

## Tests

```
node --test tests/*.test.cjs                 # engine (simulated GPS, relay, storage) + database; CI runs this
CHROME=… PLAYWRIGHT=… node tests/ui/herd-flow.ui.mjs   # browser, simulated GPS, real migrations
```

- `tests/herd-core.test.cjs` — geofence states, scoring, key handling, sealed messages, rolling codes, split-clue dealing, merge, solo flow, encrypted three-phone sync, reload persistence, practice isolation, demo-route checks, QR round trip.
- `tests/hunt.sql.test.cjs` — lock-down, column allowlist, zero-write Friends Mode, counters, solo/team scoring, idempotent and concurrent check-ins, roster freeze, leaving, version lock, first-run rule, colorado.edu rule, standings, admin, account deletion.
- `tests/ui/herd-flow.ui.mjs` — the same flows through the real screens on a phone-sized browser, plus the wire checks (no coordinate in any request; only ciphertext on the relay). Screenshots: `docs/screenshots/herd-*.png`.

## Known limits (Phase 1 is a demo; read before attaching real rewards)

- **The geofence is asserted by the phone.** That is the price of never sending coordinates. A modified client can claim `inside: true`. Fine for a demo reward; Phase 2 rewards need something more (staff validation at redemption, device attestation, or a rotating on-site code).
- **Answers and hints are not secrets among players.** Friends share them, the demo routes' hint text ships in the app, and the demo answer hashes can be brute-forced (answers are short). The check-in function has no attempt limit, deliberately: a per-user attempt log would be exactly the event tracking this feature avoids.
- **Counters can be inflated** by anyone calling the function. They are a rough funnel, not billing data.
- **A rolling code is valid for roughly 15–30 seconds,** so a very fast screenshot-and-text could work. It proves "in the herd, just now", not physical touch.
- **A team id is a capability.** Anyone who has it and is signed in can join before the roster locks. It is shared only inside the encrypted herd.
- **Joining needs a teammate online.** The herd lives on phones; a new phone gets it from one of them.
- **Invite links open in the browser,** not the installed home-screen app, on iPhone. Progress then lives in that browser.
- **Deleting an account from the Supabase dashboard** (rather than in the app) removes the rows by cascade but doesn't re-score the team.
- **Route length:** the five pins are about 570 m apart in a straight line (roughly 8–10 minutes on the paths), a little under the 10–15 minute walking target.

## On-campus phone test checklist

Nothing below can be verified from a desk. Use Demo Practice first to learn the screens, then Friends Mode on the route.

**Each checkpoint (5), with an iPhone (Safari) and an Android phone (Chrome)**
- [ ] Stand at the described spot. "Check in here" succeeds within ~10 seconds. Note the ±accuracy the message shows if it doesn't.
- [ ] Walk ~80–100 m away. Check-in is refused with a sensible distance and direction.
- [ ] Try from just inside the nearest building doorway. Note what happens (expected: weak or refused).
- [ ] The pin is where the name says. Record the true coordinate (drop a pin in a maps app) and the radius that feels right.
- [ ] Step-free route to the spot exists; rewrite the accessible-path note from what you see.
- [ ] Entrance note is right; nothing invites people indoors.
- [ ] Then, in the admin view: fix coordinate, radius and notes, and untick **Needs on-site check**.

**Specific spots**
- [ ] Norlin: the west-door inscription is readable from the walk below the steps.
- [ ] Macky: count the towers from the south plaza (Edition 1 expects a number); the name MACKY is visible.
- [ ] Old Main: where the plaque and bell are; whether the year appears.
- [ ] Mary Rippon: after the 2026 renovation, find a spot that is clearly **outside** the seating area and works during a rehearsal or performance; confirm the seating and her name are visible from there. This is the least certain pin.
- [ ] UMC: the South Terrace and the fountain court are on different sides. Pick one, move the pin, shrink the 70 m radius. Check whether the terrace tent blocks it.

**Every puzzle (15)**
- [ ] Solvable on site without the hints; the accepted answers include what a student would actually type. Add spellings in the admin view.
- [ ] Untick the puzzle's on-site flag (edit the route JSON: `"needs_onsite_check": false`).

**Phones together**
- [ ] Scan the invite QR from another phone's screen in daylight (glare, brightness).
- [ ] Rolling code: scan across two phones; then try the six digits.
- [ ] Pass a split-clue piece by QR.
- [ ] Lock one phone for two minutes mid-hunt, unlock: it catches up without a reload.
- [ ] Walk between checkpoints on cellular (campus Wi-Fi handoffs): the green "Live" line recovers.
- [ ] Camera and location permission prompts read sensibly on both platforms; deny each once and follow the fallback.
- [ ] iPhone: open an invite link from Messages; note that it opens Safari, not the home-screen app.
- [ ] Time a full route, solo and as a group of three or four. Target 20–40 minutes.

**Competition (after merge, on the real project)**
- [ ] Sign in with a colorado.edu address: badge shows. Sign in with another address: guest note shows.
- [ ] Finish a run: token appears with "Demo reward — not redeemable. No purchase benefit is available."
- [ ] Standings show the team, never the players.
- [ ] Progress → Privacy & delete my data → delete account; confirm the team is re-scored or removed.
