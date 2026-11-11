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
