# BuffPrints student app, v2 — design and implementation notes

Branch `design/student-app-v2`. Builds on the merged student-experience redesign (PR #1) and everything merged since (satellite map, CU palette, BuffPrints name, privacy notice and account deletion). Storage keys (`ralphies-roam-v1`, IndexedDB `ralphies-roam`) and every database identifier are unchanged, so existing users keep their progress.

## Structure

| File | Role |
|---|---|
| `index.html` | App shell and script. Engines (GPS, claiming, fog, badges, names, cloud sync, hazards) unchanged; the UI layer is new. |
| `app.css` | All styles (replaces the old inline styles and `student.css`). |
| `student-core.js` | Pure, tested logic: goal definitions, path history, walk summaries, route trimming, share-card text, request statuses. |
| `tests/student-core.test.cjs` | 12 regression tests (`node --test tests/student-core.test.cjs`). |
| `icons/` | Regenerated with the hoofprint mark. |

## Design decisions

- **Five destinations, one record control.** Home, Explore, Progress, Community, Safety in a bottom bar. Record is a floating button above the bar on every screen; while recording it becomes a bar with elapsed time, distance, new paths, GPS accuracy and **Finish**.
- **Home is personal, in priority order:** compact weekly goal tiles → an interactive map → one next action → your team this week and recent walks. The welcome line appears only for a brand-new user and can be dismissed; no recurring promotional cards.
- **Map first.** Walked sections are solid gold with a dark casing (readable on satellite imagery); unexplored ones are a thin light dashed line. Paths walked end to end get a small hoofprint at zoom 17+. Zone names show when zoomed out; student path names show when zoomed in. Fog is off by default and toggled from the map. Only two map buttons (center on me, fog); zoom buttons appear on desktop only.
- **Gestures.** On Home the map sits in a card: one finger scrolls the page, two fingers zoom, *Open map* goes full screen. Explore is a full-screen map with a bottom sheet that opens and closes only from its handle. Pinch zoom stays enabled. The Leaflet map is a single instance moved between Home, Explore and the desktop panel.
- **Language.** Goals and summaries speak in paths, zones and walks. Segment counts remain only where they are the real unit (team points, older walk summaries).
- **Calmer motivation.** The streak nudge no longer gets more urgent in the evening, the "Dawn Patrol" badge (which rewarded walking before 7 am) was retired, and copy says rest days are fine.
- **Visual identity.** Warm gold (#CFB87C, #8D7334 for gold text), charcoal (#1E2022) and white; orange is used only for the emergency callout, student hazard pins and warnings; red only for destructive actions. Line icons replace emoji in controls. Reduced-motion users get no animation.

## Goal definitions (all computed from recorded data)

Weeks run Monday 00:00 to Sunday, Boulder time. A **path** is one OpenStreetMap walkway (stable way ID, e.g. `w33869394`); the app tracks it in ~20 m **sections**.

| Goal | Exactly what counts |
|---|---|
| Visit *N* new paths (default 10) | A path you had never visited before, first visited this week. **Visited** means you have walked 30 m of it, or half of it if it is shorter than 60 m. Brushing the end of a crossing sidewalk doesn't count. |
| Complete *N* walks (default 3) | Walks recorded in BuffPrints this week of at least 0.1 mi. Walks from before walk history existed are not counted. |
| Explore a new zone (default on) | A named campus zone where you visited your first path this week. Hidden once every zone is explored. |
| Finish *N* paths end to end (default off) | Paths whose every section is walked, finishing this week. |

Goals are optional, adjustable and stored on the device. Progress is recalculated from claim timestamps and walk history every time, so it never claims history the app cannot establish. Claims on walkway IDs that no longer exist are ignored.

## Completed walk

Distance; **elapsed time** (wall clock); **moving time, estimated from GPS** (time between accepted fixes moving at least 0.3 m/s); new paths visited; paths completed; and one accomplishment: a goal this walk completed (compared before vs. after the walk), a badge earned during it, or progress toward the next goal. The route preview is drawn only from the walk's own GPS points, with 150 m removed from each end, and only when the walk is long enough to hide both ends. **Share summary** uses the Web Share API with a PNG, falling back to a download. The image contains the date, stats and optionally the trimmed shape — no name, place names, time of day, map or exact start or finish.

An unfinished walk is saved on the phone; after a reload the app offers to resume, finish or discard it.

## Community

Your dorm or team comes first: team points, zones led, your contribution (the same server totals as the team score), rank among active teams, and members with recorded walks. If you have no team, there's a join control right there. Zone standings, team standings and a campus-wide student list follow. Nothing is fabricated: empty states say so plainly.

## Safety

Four sections: help and getting home (911, CU Boulder Safe, CU NightRide, CU Boulder Police non-emergency) → community observations (each pin labeled "Student report", with "Student votes: …") → prepare a request (draft only, never sent) → follow up. The follow-up tracker is local to the phone and every entry is labeled **recorded by you** with the source the student entered. BuffPrints shows no official status of its own, and the copy says plainly that an expired or community-cleared pin does not mean CU inspected or repaired anything.

## Validation performed

Headless Chrome with simulated GPS fed through the browser's geolocation API, a fake Supabase server, and placeholder map tiles (the test environment cannot reach Esri). Screenshots in `docs/screenshots/` come from that setup; the walk screenshots use a 5× page clock so the GPS steps match a walking pace.

- 360, 390 and 430 px phones and 1280 px desktop
- Record → walk → finish → share (download fallback) → done; walk recovery after reload; GPS permission denied
- Goal math and persistence across reloads (unit tests plus browser)
- Signed-out, no-team, team, loading, empty, error and offline states for Community and Safety
- Existing user with old saved data: claims, badges, streak and old walk summaries preserved; obsolete IDs ignored
- Keyboard navigation, dialog focus trap and restore, labeled form fields, reduced motion
- axe-core WCAG 2 A/AA checks on all five screens: no violations

**Not tested:** GPS on a physical phone, an installed PWA on iOS/Android, the real Supabase project (sign-in, sync, team totals, hazard writes), real satellite tiles, or the share sheet on a phone.

## Remaining limitations

- **"Paths" are OpenStreetMap ways.** OSM splits campus sidewalks at intersections, so many paths are short and a 15-minute walk can visit 10+. Goal defaults reflect that. Merging ways into longer named routes would make "new path" feel more substantial.
- **Foreground GPS only.** Browsers stop location updates when the phone locks; recording requires the app to stay open.
- **Trust.** Claims and team points are reported by the phone; the server doesn't validate movement.
- **Not built (needs backend work):** friend groups, clubs, an activity feed, cloud sync of walk history and follow-up requests, verified agency updates on reports, moderation tools.
- **Facilities/CUPD follow-up** is self-reported by design; BuffPrints cannot see official ticket systems.
