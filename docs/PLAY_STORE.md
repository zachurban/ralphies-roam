# BuffPrints on Google Play

BuffPrints ships to Android as a **Trusted Web Activity (TWA)**: a small Android app (`com.buffprints.app`) that opens the live site full screen in Chrome, with no browser bar. Updates to the website show up in the app right away; the Android build only needs re-running for icon, name or version changes.

What's in the repo:

| File | What it does |
|---|---|
| `android/twa-manifest.json` | Bubblewrap settings for the Android app (package, colors, icons, location delegation) |
| `.github/workflows/android.yml` | Builds the signed Play bundle (`.aab`) and a test `.apk` — Actions → *Android app (Google Play)* → Run workflow |
| `.well-known/assetlinks.json` | Proves the app and the site belong together (without it the app shows a browser bar) |
| `privacy.html` | Privacy policy URL for the store (generated from `PRIVACY.md`) |
| `delete-account.html` | Account-deletion URL the store requires |
| `docs/play/` | Feature graphic (1024×500) and 512 px icon |

## Checklist

### 1. Domain (one time)
- [ ] Buy the domain (e.g. `buffprints.app`). Turn on the registrar's free email forwarding, e.g. `hello@` → your inbox.
- [ ] DNS: four `A` records for the bare domain → `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`; `CNAME` `www` → `zachurban.github.io`.
- [ ] Repo Settings → Pages → Custom domain → enter the domain, then tick **Enforce HTTPS** once it's offered. (This adds a `CNAME` file to the repo.) The old `github.io` address redirects to the new one.
- [ ] Supabase → Authentication → URL Configuration: set **Site URL** to `https://<domain>/` and add `https://<domain>/**` to Redirect URLs, or email sign-in links will break.
- [ ] `config.js`: set `contactEmail` to the forwarding address (shows on the privacy notice and the deletion page).
- [ ] Check `https://<domain>/.well-known/assetlinks.json` opens.

Note: progress saved only on a phone (not signed in) is tied to the old address. Signed-in progress comes back on sign-in.

### 2. Build the app
- [ ] Repo Settings → Secrets and variables → Actions → add `ANDROID_KEYSTORE_B64` and `ANDROID_KEYSTORE_PASSWORD` (values are in the key file Claude sent you). **Keep `buffprints-upload.jks` and its password somewhere safe**: it signs every update. If it's ever lost, Play support can reset the upload key.
- [ ] Actions → *Android app (Google Play)* → Run workflow → enter the domain and version `1.0.0`.
- [ ] Download the `buffprints-android` artifact: `app-release-bundle.aab` goes to Play; `app-release-signed.apk` can be installed on an Android phone to try it.

### 3. Play Console
- [ ] Create a **personal** developer account ($25, ID verification, plus verifying with an Android phone).
- [ ] Create app → name *BuffPrints*, App, Free.
- [ ] Testing → **Closed testing** → create a track, upload the `.aab`, opt in to **Play App Signing**.
- [ ] Setup → App signing: copy the **app signing key SHA-256** and add it to `.well-known/assetlinks.json` next to the upload key's (keep both). Push. Without this the store-installed app shows a browser bar.
- [ ] Fill in the store listing, data safety, content rating and app content forms below.
- [ ] Add testers (an email list or Google Group) and share the opt-in link.

### 4. The 12-tester rule
New personal accounts need **12 testers opted in for 14 days in a row** on the closed track before applying for production. Testers need **Android** phones and should actually use the app (Google checks engagement). Good sources: family, friends, CU students, Troop 240 parents (adults). Recruit 15–20 so drop-outs don't matter. Ask them to record a walk or two and send feedback during the two weeks. Then **Apply for production** (answers about testing and readiness; review takes about a week).

## Store listing (drafts)

**App name** (30): `BuffPrints: Campus Walks`

**Short description** (80): `Walk CU Boulder, claim paths, clear the fog, and play Herd and Seek with friends.`

**Full description:**

> BuffPrints turns the walk between classes into a game. Record a walk, and every stretch of campus sidewalk and walkway you cover turns gold on the map. The fog of war clears as you explore.
>
> • Claim paths across Norlin Quad, Farrand Field, Engineering, Kittredge, Williams Village, East Campus and the Boulder Creek Path
> • Keep a streak, earn badges and finish whole zones
> • Name a path you've walked, and see what other students called theirs
> • Herd and Seek: a five-checkpoint campus scavenger hunt to play solo or with friends
> • Import your class schedule to see your daily walking commute and scenic routes between classes
> • Flag hazards like broken lights or ice so other walkers know
>
> Privacy built in: your location is used only while you record, and your route never leaves your phone. Sign-in is optional, and you can export or delete your data anytime.
>
> BuffPrints is an independent student project. It is not an official University of Colorado Boulder app.

**Category:** Health & Fitness (alternative: Travel & Local). **Contact email:** the forwarding address. **Privacy policy:** `https://<domain>/privacy.html`.

**Graphics:** icon `docs/play/app-icon-512.png`; feature graphic `docs/play/feature-graphic.png`; **phone screenshots: take 4–6 real ones on campus** (Explore map with gold paths, a finished walk, Progress, Herd and Seek, Class Schedule). Real satellite map screenshots sell it far better than mockups.

## Data safety (based on PRIVACY.md — double-check before submitting)

- Data collected: **yes**. Shared with third parties: **no** (Supabase only stores data for the app, as a service provider). Encrypted in transit: **yes**. Users can request deletion: **yes** (`https://<domain>/delete-account.html`).
- **Location → Approximate location:** collected, *optional*, for *app functionality*. GPS points never leave the phone, but for signed-in users the walkway sections they've claimed (and hazard pins they post) are stored, and those show roughly where they've been. Declaring this is the honest, safer call.
- **Personal info → Email address:** collected, optional (sign-in), for *account management*.
- **Personal info → User IDs:** the public nickname, optional, *app functionality*.
- **App activity → Other user-generated content:** hazard pins, votes, path names, nickname reports. **App activity → Other actions:** badges, streaks, distance, weekly zone totals, Herd and Seek check-ins ("inside: yes" only).
- Not collected: precise location (on-device only), contacts, photos, files, payments, health, device IDs, ads data.

## Other forms

- **Ads:** none. **In-app purchases:** none. (Herd and Seek rewards are demo tokens with no purchase value.)
- **Target audience:** 18 and over is simplest. Choosing under 18 brings extra policy requirements.
- **Content rating:** no violence, sexual content, gambling or drugs. *Users can interact*: **yes** (public nicknames, path names, hazard notes, herd chat-style sharing) — mention moderation and reporting.
- **App access:** "All or some functionality is restricted" → explain that everything works without signing in except Competition Mode and saving progress, which use an emailed sign-in code. No test account needed.
- **Location permission:** the app uses foreground location only, while recording. It doesn't request background location, so no background-location declaration. If the Console asks for a precise-location declaration, answer: *GPS tracks which campus walkways the user walks during an active recording; approximate location can't tell adjacent walkways apart.*
- **Trademarks:** the store reviews names and imagery. "Buffs" and Ralphie are CU marks. Keep the "not an official CU Boulder app" line, use no CU logos, and consider asking CU Licensing for a written OK.
