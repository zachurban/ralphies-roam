# Ralphie's Roam

A fog-of-war walking game for the CU Boulder campus. Real GPS, Leaflet map, installable PWA. No build step, no server code.

## Put it online (GitHub Pages, about 3 minutes)

Phone GPS only works on an `https://` page, so the files need a host.

1. On github.com: **New repository** → name it `ralphies-roam` → Public → Create.
2. **Add file → Upload files** → drag in everything from this folder (keep the `icons` folder) → Commit.
3. **Settings → Pages** → Source: *Deploy from a branch* → Branch: `main`, folder `/ (root)` → Save.
4. After a minute the app is live at `https://<your-username>.github.io/ralphies-roam/`.

## Install on a phone

- **iPhone (Safari):** Share → Add to Home Screen.
- **Android (Chrome):** menu → Add to Home screen / Install app.

## Files

| File | Purpose |
|---|---|
| `index.html` | The whole app (HTML, CSS, JS). Works on its own. |
| `manifest.json`, `icons/` | Home-screen install. |
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
  hazard reports, row-level security (students read and write only their own rows), and leaderboard
  and hazard functions that expose names and totals only. Applied automatically by the Supabase
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
inside the campus box by `scripts/build-paths.mjs`, run by the **Update walkways from
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

## Student-named paths

Tap any path to see it. A signed-in student who has walked any part
of a path with no official OpenStreetMap name can name it. The first name sticks; only its author
can rename or remove it. Names appear on everyone's map at zoom 17+, signed in or not, and in
toasts and nudges. Limit: 10 new names per student per day.

The profanity/spam filter (`rr_name_problem` in the database) is the real gate; the app runs a copy
for instant feedback. To remove a name: `delete from public.path_names where path_id = 'w123';`
To ban a word, add it to the lists in both `rr_name_problem` (new migration) and `NF` in `index.html`.
