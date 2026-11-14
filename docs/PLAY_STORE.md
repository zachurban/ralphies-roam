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

### 1. Domain: buffprints.app (bought on GoDaddy)
Order matters: set up DNS **before** merging the PR that adds the `CNAME` file, or the site points at a domain that doesn't answer yet.
- [ ] GoDaddy → My Products → buffprints.app → **DNS**. Delete any existing `A` record for `@` (GoDaddy's "Parked" one) and any `CNAME` for `www`.
- [ ] Add four `A` records, Name `@`: `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`.
- [ ] Add a `CNAME`, Name `www`, Value `zachurban.github.io`.
- [ ] Merge the PR (it adds `CNAME` containing `buffprints.app`). Then repo Settings → Pages: confirm the custom domain shows `buffprints.app` and its DNS check passes, and tick **Enforce HTTPS** once offered. Certificates can take up to an hour or so. `.app` domains only work over HTTPS, so the site stays blank until then.
- [ ] Optional but recommended: GitHub profile Settings → Pages → **Add a verified domain** (adds a TXT record at GoDaddy), so nobody else can claim the domain on GitHub.
- [ ] Supabase → Authentication → URL Configuration: **Site URL** `https://buffprints.app/`; add Redirect URLs `https://buffprints.app/**` and `https://www.buffprints.app/**`. Keep the old github.io entry for a while.
- [ ] Email: set up forwarding for `hello@buffprints.app` to your inbox (GoDaddy's forwarding if your plan includes it, or a free forwarder like ImprovMX), then set `contactEmail: 'hello@buffprints.app'` in `config.js`.
- [ ] Check `https://buffprints.app/.well-known/assetlinks.json` opens.

Note: progress saved only on a phone (not signed in) is tied to the old address. Signed-in progress comes back on sign-in.

### 2. Build the app
- [ ] Repo Settings → Secrets and variables → Actions → add `ANDROID_KEYSTORE_B64` and `ANDROID_KEYSTORE_PASSWORD` (values are in the key file Claude sent you). **Keep `buffprints-upload.jks` and its password somewhere safe**: it signs every update. If it's ever lost, Play support can reset the upload key.
- [ ] Actions → *Android app (Google Play)* → Run workflow (domain defaults to `buffprints.app`, version `1.0.0`).
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

**App name** (30): `BuffPrints: Campus Roams`

**Short description** (80): `Campus scavenger hunts for CU Boulder. Roam solo or with friends, clear the map.`

**Full description:**

> BuffPrints turns the CU Boulder campus into a scavenger hunt. Pick a roam: five outdoor stops, five puzzles, about 40 minutes. Go solo or invite a herd of friends and solve it together.
>
> • Roams: check in at each stop, crack the puzzle, and climb the weekly herd and dorm standings
> • Walk the map: record a walk and every sidewalk you cover turns gold as the fog clears
> • Claim paths across Norlin Quad, Farrand Field, Engineering, Kittredge, Williams Village, East Campus and the Boulder Creek Path
> • Keep a streak, earn badges and finish whole zones
> • Name a path you've walked, and see what other students called theirs
> • Import your class schedule to see your daily walking commute and scenic routes between classes
> • Flag hazards like broken lights or ice so other walkers know
>
> Privacy built in: your location is used only while you roam or record, and it never leaves your phone. Sign-in is optional, and you can export or delete your data anytime.
>
> BuffPrints is an independent student project. It is not an official University of Colorado Boulder app.

**Category:** Travel & Local (alternative: Health & Fitness). **Contact email:** the forwarding address. **Privacy policy:** `https://buffprints.app/privacy.html`.

**Graphics:** icon `docs/play/app-icon-512.png`; feature graphic `docs/play/feature-graphic.png`; **phone screenshots: take 4–6 real ones on campus** (the Roam home screen, a roam in progress, a finished roam, the Map with gold paths, Herd standings, You). Real satellite map screenshots sell it far better than mockups.

## Data safety (based on PRIVACY.md — double-check before submitting)

- Data collected: **yes**. Shared with third parties: **no** (Supabase only stores data for the app, as a service provider). Encrypted in transit: **yes**. Users can request deletion: **yes** (`https://buffprints.app/delete-account.html`).
- **Location → Approximate location:** collected, *optional*, for *app functionality*. GPS points never leave the phone, but for signed-in users the walkway sections they've claimed (and hazard pins they post) are stored, and those show roughly where they've been. Declaring this is the honest, safer call.
- **Personal info → Email address:** collected, optional (sign-in), for *account management*.
- **Personal info → User IDs:** the public nickname, optional, *app functionality*.
- **App activity → Other user-generated content:** hazard pins, votes, path names, nickname reports. **App activity → Other actions:** badges, streaks, distance, weekly zone totals, roam check-ins ("inside: yes" only).
- Not collected: precise location (on-device only), contacts, photos, files, payments, health, device IDs, ads data.

## Other forms

- **Ads:** none. **In-app purchases:** none. (Roam rewards are demo tokens with no purchase value.)
- **Target audience:** 18 and over is simplest. Choosing under 18 brings extra policy requirements.
- **Content rating:** no violence, sexual content, gambling or drugs. *Users can interact*: **yes** (public nicknames, path names, hazard notes, herd chat-style sharing) — mention moderation and reporting.
- **App access:** "All or some functionality is restricted" → explain that everything works without signing in except Competition Mode and saving progress, which use an emailed sign-in code. No test account needed.
- **Location permission:** the app uses foreground location only, while recording a walk or while a roam is open. It doesn't request background location, so no background-location declaration. If the Console asks for a precise-location declaration, answer: *GPS checks the user in at scavenger-hunt stops (about 30 m across) and tracks which campus walkways they walk during an active recording; approximate location can't do either.*
- **Trademarks:** the store reviews names and imagery. "Buffs" and Ralphie are CU marks. Keep the "not an official CU Boulder app" line, use no CU logos, and consider asking CU Licensing for a written OK.
