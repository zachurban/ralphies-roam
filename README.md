# BuffPrints

*Explore campus. Leave your mark.*

Privacy: see [PRIVACY.md](PRIVACY.md) — the same notice is in the app under Progress → Privacy & delete my data.

Design and goal definitions: [docs/STUDENT_APP_V2.md](docs/STUDENT_APP_V2.md). Herd and Seek (scavenger hunt): [docs/HERD_AND_SEEK.md](docs/HERD_AND_SEEK.md). Nicknames and moderation: [docs/USERNAMES.md](docs/USERNAMES.md). Tests: `node --test tests/*.test.cjs` (database tests need a local PostgreSQL; they skip without one).

A fog-of-war walking game for the CU Boulder campus. Real GPS, Leaflet map, installable PWA. No build step, no server code.

## Put it online (GitHub Pages, about 3 minutes)

Phone GPS only works on an `https://` page, so the files need a host.

1. On github.com: **New repository** → name it `ralphies-roam` → Public → Create.
2. **Add file → Upload files** → drag in everything from this folder (keep the `public` folder) → Commit.
3. **Settings → Pages** → Source: *Deploy from a branch* → Branch: `main`, folder `/ (root)` → Save.
4. After a minute the app is live at `https://<your-username>.github.io/ralphies-roam/`.

## Install on a phone

- **iPhone (Safari):** Share → Add to Home Screen.
- **Android (Chrome):** menu → Add to Home screen / Install app.

## Files

| File | Purpose |
|---|---|
| `index.html` | The app shell and script. |
| `app.css` | Styles. |
| `splash.js`, `splash.css` | Launch splash (returning users) and welcome screen (first visit, or the ? button in the header). Remembered in `localStorage` as `buffprints_onboarded_v1`. |
| `student-core.js` | Goal, walk-summary and request logic shared with the tests. |
| `schedule-core.js` | Class schedule (.ics) reading, CU term calendar and walkway routing, shared with the tests. |
| `username-core.js` | Nickname format rules and messages (moderation itself runs only on the server). |
| `admin.html` | Nickname moderation queue for moderators (server-checked; see docs/USERNAMES.md). |
| `herd.html`, `herd.css`, `herd-app.js` | Herd and Seek, the scavenger hunt (see docs/HERD_AND_SEEK.md). |
| `herd-core.js` | Herd and Seek rules shared with the tests: geofence, scoring, encryption, sync. |
| `herd-editions.js` | Generated copy of the demo hunt routes (answer hashes only), built by `scripts/build-hunt.mjs`. |
| `herd-admin.html` | Hunt admin: checkpoints, routes, flags and anonymous counters (allowlisted). |
| `vendor/` | QR code libraries, kept local (see `vendor/README.md`). |
| `buildings.json` | CU building codes → location and outline, built from OpenStreetMap by `scripts/build-buildings.mjs`. |
| `data/building-aliases.json` | Hand-kept fixes for building codes OpenStreetMap lists differently. |
| `public/` | App icons, favicons, `site.webmanifest` (home-screen install) and the hoof print logo (`hoofprint-logo.svg`). |
| `sw.js` | Offline app shell and map-tile cache. |
| `paths.geojson` (optional) | Your own walkways; replaces the built-in set. |

## Correcting the walkways

The built-in paths are hand-placed approximations. To fix them, either edit the `PATHS` array in `index.html`,
or add a `paths.geojson` of LineStrings with properties `zone` (`norlin`, `varsity`, `farrand`, `engineering`,
`kittredge`, `creek`), `name`, and `tags` (any of `stairs`, `bridge`, `goat`). **Live Stats → Export my data**
downloads your recorded GPS track as GeoJSON, which is a handy source for real coordinates.

After changing files, bump `VERSION` in `sw.js` so phones pick up the update.

## Tuning

Top of the script in `index.html`: `CLAIM_M` (15 m snap threshold), `REVEAL_M` (fog hole size),
`ACC_MAX_M` (GPS fixes less accurate than this are ignored), `MAX_SPEED`.

## Backend (Supabase)

Optional. With `config.js` blank, the app runs offline-only exactly as before.

- `supabase/migrations/` — database schema: profiles, claimed segments, badges, distance totals,
  hazard reports, nicknames and their moderation, row-level security (students read and write only their own rows), and leaderboard
  and hazard functions that expose nicknames and totals only. Applied automatically by the Supabase
  GitHub integration on push to `main` when **Deploy to production** is on.
- `config.js` — Supabase Project URL and publishable key (both safe to commit).

**Privacy:** raw GPS never leaves the phone. The server stores which segments a student claimed,
their distance total, badges, and hazard pins they choose to file (campus bounds only).

**Restrict sign-ups to CU** (SQL editor):
`update public.app_settings set value = 'colorado.edu' where key = 'allowed_email_domain';`

**Resolve a hazard:** `update public.hazard_reports set status = 'resolved', resolved_at = now() where id = 123;`

**Home-screen sign-in:** add `{{ .Token }}` to the Magic Link email template so students get a
6-digit code. Tapping the email link opens Safari, not the installed app.

**Before real students:** Supabase's built-in email sender has a very low hourly limit. Set up
custom SMTP (Authentication → Emails) before inviting more than a handful of testers.

Segment IDs come from the path definitions; changing a path's coordinates or ID orphans claims on
that path.

## Walkway data (OpenStreetMap)

`paths.geojson` is generated from OpenStreetMap footways, paths, stairs, bridges and bike paths
inside the main campus box and the Williams Village area by `scripts/build-paths.mjs`, run by the **Update walkways from
OpenStreetMap** GitHub Action (Actions tab → Run workflow). Stairs come from `highway=steps`,
bridges from `bridge=*`, and goat paths from informal or unpaved trails. Zones are boxes drawn
around named OSM landmarks; everything else falls into **Rest of Campus**.

Re-running it only when needed keeps claims stable: claims are tied to OSM way IDs, and
OSM edits that split or redraw a way reset progress on that way.

## Streaks, territory and nudges

- **Streak:** a day counts with 1 newly claimed segment *or* 10 distinct segments walked (Boulder
  time). Every 7-day streak earns a freeze (max 2) that covers one missed day.
- **Territory:** each distinct segment a student walks in a zone this week earns their dorm 1 point;
  the top dorm owns the zone. Weeks start Monday. The server stores per-zone weekly counts only.
- **Nudges:** the gold bar under the stats shows the single best next move (finish a zone, retake
  a zone, keep a streak, pass the person above you, nearby stairs or bridges). Tap it to fly there.
- **Dorm list** comes from OpenStreetMap residence halls (`dorms` in `paths.geojson`), plus
  Off-campus, Faculty & staff, and Other.

## Nicknames

Signed-in students pick a public nickname: a suggested campus one (*FlatironFox482*) or their own. Names are moderated on the server, unique ignoring case and look-alikes, and reportable; moderators work a queue in `admin.html`. Add a moderator: `insert into public.app_admins (user_id) select id from auth.users where email = 'you@colorado.edu';`. Full details, rate limits, the migration plan for existing names and known limitations: [docs/USERNAMES.md](docs/USERNAMES.md).

The profanity list includes the English [List of Dirty, Naughty, Obscene, and Otherwise Bad Words](https://github.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words) (CC BY 4.0), loaded by `scripts/build-moderation-terms.mjs`.

## Student-named paths

Tap any path to see it. A signed-in student who has walked any part
of a path with no official OpenStreetMap name can name it. The first name sticks; only its author
can rename or remove it. Names appear on everyone's map at zoom 17+, signed in or not, and in
toasts and nudges. Limit: 10 new names per student per day.

The profanity/spam filter (`rr_name_problem` in the database) is the real gate; the app runs a copy
for instant feedback. To remove a name: `delete from public.path_names where path_id = 'w123';`
To ban a word, add it to the lists in both `rr_name_problem` (new migration) and `NF` in `index.html`.

## Hazard follow-up

Tap a ⚠️ pin. Reporters see **Delete my report**; other signed-in students see **Still there** and
**Fixed** (one vote each, changeable). A report clears itself when, over the last 14 days, at least
2 students said Fixed and Fixed outnumbers Still there. A Still-there vote keeps a pin visible for
60 days from that confirmation. Voters and reporters are never shown to other students.

## Student experience redesign

See [the product review and roadmap](docs/STUDENT_EXPERIENCE_REVIEW.md).
`student.css` contains the visual refresh; `student-core.js` contains tested goal,
walk-summary, and advocacy-draft helpers. Run `node --test tests/student-core.test.cjs`.
Completed walk summaries and weekly goal preferences are device-local. Drafts are
not saved or submitted. Safety resource links are available without signing in;
community hazard pins still use the existing Supabase policies and functions.

## Class schedule and commute

Students can import their Buff Portal class schedule (an `.ics` calendar file). BuffPrints shows each class day's walks (start → classes → back), routes them on the campus walkways, and offers a **scenic route** when one covers new paths for a minute or two more. Walking a scenic route while recording completes it and earns badges (Scenic Route, Road Less Traveled, Know Your Way). Everything stays on the phone; only course, component, days, times and building codes are kept. Details: [`docs/SCHEDULE_COMMUTE.md`](docs/SCHEDULE_COMMUTE.md).

Each year, update `TERMS` in `schedule-core.js` from the CU academic calendar (first and last day of classes, holidays, breaks, reading days, Monday-schedule days).

## Herd and Seek

A scavenger hunt at `herd.html`: five outdoor checkpoints, five puzzles, 20–40 minutes, solo or as a herd. **Friends Mode** needs no sign-in and writes nothing to the database; teammates sync phone to phone through an encrypted relay whose key lives only in the invite link's `#fragment`. **Competition Mode** (signed in) stores which checkpoints a player completed and a team's name, avatar and score, and feeds weekly herd and dorm standings plus a demo reward token (*Demo reward — not redeemable. No purchase benefit is available.*). **Demo Practice** simulates check-ins for trying it anywhere. The phone compares GPS with the checkpoint itself; coordinates are never sent or stored.

Three demo routes ship with every coordinate and on-site detail flagged `needs_onsite_check` until someone walks them. Add a hunt admin: `insert into public.admin_allowlist (email) values ('you@colorado.edu');` then open `herd-admin.html`. Setup, rules, known limits and the on-campus test checklist: [docs/HERD_AND_SEEK.md](docs/HERD_AND_SEEK.md).
