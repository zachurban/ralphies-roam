# BuffPrints — Your data & privacy

*Last updated November 12, 2026. The same notice appears in the app under Progress → Privacy & delete my data.*

BuffPrints is an independent student project. It is not an official University of Colorado Boulder app, and it is not monitored by CU or emergency services. In an emergency, call 911.

## What stays on your phone

- **Your location**, only while you are recording a walk with the app open. It is used to work out which paths you walk.
- **Your detailed route** (a log of GPS points) is saved only on this device. It is never uploaded.
- Your progress: claimed paths, miles, badges, streaks, goals and walk summaries (with a route shape that leaves out the start and finish).
- Improvement requests you save on the Safety page, and the follow-up notes you add.
- An unfinished walk, so you can resume or finish it after the app closes.
- **Your class schedule**, if you import one: course codes, meeting days and times, and building codes, plus where you start your day and any buildings you place on the map. Room numbers, instructors and everything else in the file are discarded when it is read. Your schedule is never uploaded.
- **Find the Herd:** your herd (nicknames, avatars, progress, shared answers), stored scrambled so it can't be read without the herd's invite key. When you tap Check in, your phone compares its own GPS with the checkpoint and keeps only "inside: yes" — the coordinates are not saved, even here.

## Find the Herd

Find the Herd is the scavenger hunt inside BuffPrints. It was built to work on as little data as possible.

- **Your location never leaves your phone.** When you tap **Check in here**, the phone reads its GPS once, works out on the phone whether you are inside the checkpoint (distance plus the accuracy the phone reports), and throws the reading away. The most that is ever sent is "I'm inside this checkpoint: yes" — never coordinates, accuracy or a route. The server has nowhere to store a coordinate even if one were sent.
- **Your herd syncs phone to phone.** Nicknames, avatars, progress, clue pieces, hints and answers are encrypted on your phone with a key that exists only in your invite link (the part after `#`, which browsers never send to servers) and in the QR code on a teammate's screen. Our relay passes along scrambled messages it can't read and doesn't keep them. "We're together" codes and clue pieces go straight from one screen to another phone's camera.
- **Friends Mode and Demo Practice** save nothing about you or your herd on our servers. No sign-in. (For a route that isn't stored in the app itself, an answer you type is sent to be checked and is not kept.)
- **Competition Mode** (signed in) saves to your account: which checkpoints you completed and when, each marked "inside: yes", and whether your email was a verified colorado.edu address (yes or no — the address isn't copied). For your team: its name and avatar, the route, hints used, puzzles solved and score. Finishing all five earns a demo reward token. *Demo reward — not redeemable. No purchase benefit is available.*
- **Totals, not people.** We count how many times a route is viewed, started, each checkpoint completed, hints used and finishes. These are plain counters — a number that goes up by one — with no account, device or time attached. There is no per-person activity log, and Demo Practice isn't counted.

## What is saved to your account (only if you sign in)

- Your email address, used only to sign you in.
- Your public nickname, your dorm or team, and when you last changed your nickname. A suggested nickname is made from campus words — never from your email, name or schedule.
- If you use them: nickname reports you send (the reason and any note) and review requests for a nickname that was turned down.
- Which path segments you have claimed and when, your total distance, badges and streak.
- For each week, how many path segments you walked in each campus zone (not your route or times).
- Anything you choose to post: hazard pins (location, category, note), your "Still there" / "Fixed" votes, and names you give paths.

## Who can see what

- **Anyone, even signed out:** path names and the nickname of the student who named them.
- **Anyone, even signed out:** Find the Herd weekly standings, which show team names, team avatars, dorm or team names and scores only — never who is on a team, and never times or places.
- **Your herd:** the nickname, avatar and checkpoint progress you share in Find the Herd, for as long as you are in that herd.
- **Signed-in students:** leaderboards (nickname, dorm or team, totals, streak) and hazard pins. Pins never show who reported or voted. Your nickname is public, but it isn't a promise of complete anonymity: your team, the paths you name and when you're active can hint at who you are.
- **BuffPrints moderators** see nickname reports, review requests, and a private log of nickname changes, so they can handle abuse. Reporters are never shown to the person reported, and rejected names and nickname histories are never shown to other students.
- **No one else** sees your email, the paths you have claimed, or your location.
- We do not sell or share your data, show ads, or use analytics or tracking tools.

## Services that help run BuffPrints

Supabase stores account data and relays Find the Herd's encrypted messages between teammates' phones. GitHub Pages hosts the app. Esri provides the satellite map images. unpkg and jsDelivr deliver code libraries. Like any website, these services receive your IP address and basic device information when the app loads from them, and Esri also sees which part of the map you are viewing.

## How long it is kept

Until you delete it. Hazard pins stop showing after 60 days unless someone confirms they are still there.

## Your choices

- **Export** everything stored on this device, including your route log (Progress → Export my data).
- **Reset progress** clears your progress here and in your account but keeps your account.
- **Delete everything** permanently removes your account and all of its data — profile, nickname, progress, hazard pins, votes, path names, and every Find the Herd check-in, team membership and reward token — and erases this device. This cannot be undone.
- **Leave a herd** (Find the Herd → Leave herd) to remove it from this phone.
- **Location:** stop recording at any time, or turn off location for this site in your phone's settings.

Questions or requests: see the contact address shown in the app's privacy notice.
