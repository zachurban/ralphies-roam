# BuffTracks: student experience review

Reviewed November 11, 2026. Scope: repository UI, tracking, storage, map generation, and Supabase migrations; desktop and 390px mobile browser preview. Production database settings and authenticated workflows were not inspected or changed. Recommendations below are product hypotheses, not measured student demand.

## Product direction

Make BuffTracks the app that makes the walk between classes more interesting and helps students improve the places they use. Borrow Strava's clear recording action, activity summaries, progressive disclosure, and small-group accountability. Keep CU identity through gold, campus geography, dorms, and student-named paths. Do not compete with CU's emergency-response system.

The strongest return loop is: useful campus trip → small discovery → satisfying summary → an achievable next outing. A feed alone will be empty at launch. Utility must work before friends join.

## Implemented in this branch

- White surfaces, quieter cards, consistent typography, orange recording action, restrained CU gold.
- Five destinations: Today, Explore, Progress, Community, Safety. Mobile map with expandable sheet; desktop map beside the panel.
- Today dashboard with an editable weekly segment goal (25/50/100/200), based on existing distinct weekly visits. No new tracking or reward backend.
- Recent completed walk summaries: distance, elapsed time, new segments. Latest 50 on this device, newest five on Today. Raw GPS remains in the existing local store. Summary counters use actual session movement/claim deltas, so cloud lifetime totals do not inflate a walk.
- Record / Finish labels and a foreground-tracking explanation, replacing the misleading “passive” label.
- Light map option and fog off by default for new installations. Existing saved preferences and claims preserved.
- Safety hub with honest community-report loading/error/empty states and verified CU resource links.
- Editable advocacy draft: concern, landmark, observation, requested remedy; copy for manual submission. Not automatically sent, not saved, no agency acknowledgment implied.
- Keyboard focus management for dialogs, pinch zoom restored, reduced-motion styling, labeled map controls.
- No SQL migration, live backend setting change, official report submission, or automatic location sharing.

## Prioritized next work

| Priority | Feature | Why students return | What is required |
|---|---|---|---|
| 1 | Saved campus destinations and “I have 10/20/30 minutes” walks | Useful between classes, independent of social adoption | Curated connected routes; entrance locations; closures; realistic travel times; field validation |
| 1 | Walk history and a reliable finish/recovery flow | A tangible record of each outing | Persist in-progress sessions; foreground/background interruption tests; optional cloud summary sync |
| 1 | Track a maintenance request after submission | Students can see whether action followed a report | Reference number, responsible office, dated updates, evidence, user-confirmed submission, moderation |
| 2 | Small circles: residence floors, clubs, friend groups | A five-person group is more meaningful than a campus-wide top 100 | Explicit join/leave controls, opt-in identity, moderation; weekly goals normalized for group size |
| 2 | Weekly campus quests | Fresh goals after the map stops feeling new | Curated public routes, seasonal closures, equivalent step-free challenges, no night-only or speed incentives |
| 2 | Useful-place collections | Find a study break, water refill, bike rack, or outdoor seating | Source, owner, checked date, and expiry for changing information; do not imply venues are open without verification |
| 3 | Private-by-default walk sharing and encouragement | Social recognition without broadcasting habits | Explicit sharing, omit start/end locations and schedules; consent and removal controls |
| 3 | Aggregated student advocacy brief | Turn repeated concerns into a specific request for improvements | Deduplication, date/category filters, transparent denominators, export controls, review before publication |

Do not add points for reporting hazards or confirming repairs: that rewards volume and can encourage unsafe verification. Recognize resolved community improvements separately, after review. Keep weekly goals forgiving and optional. Do not reward speed near crossings or pressure students to preserve a streak after dark.

## Safety and advocacy: a proper follow-up model

Separate the community observation from the agency request. Suggested stages:

1. Observed (unverified, timestamped).
2. Submitted by student (recipient and ticket number recorded; clearly self-reported).
3. Acknowledged by office (evidence/reference required).
4. Work planned / in progress (source and date attached).
5. Reported repaired (identify whether office or student said so).
6. Verified / reopened (review process, with audit trail).

An expired pin is **stale**, not repaired. Two student “Fixed” votes are **community-cleared**, not an official inspection. The current database hides reports after 60 days without confirmation and can resolve them after two favorable votes; the UI now explains this but the workflow needs a later migration. Avoid neighborhood “danger scores”: uneven reporting is not comparable incident exposure.

The current hazard fetch returns at most 300 recent open reports. Never describe that as a complete campus incident count. Reports expose selected pin locations and note text to signed-in students; do not include people's names, routines, or identifying details. A moderation queue, abuse reporting, category-specific expiry, report rate limits, and privacy retention rules are prerequisites for broader adoption.

## Technical findings that affect the product

- **Foreground GPS:** browsers can suspend tracking when locked or backgrounded. A dependable Strava-like background experience needs a tested native solution or companion integration. The new copy is honest, but does not solve the platform limitation.
- **Session recovery:** completed summaries are local and capped at 50; an unfinished session is not recovered after a reload. Existing lifetime progress continues to save. Add recovery before claiming robust activity tracking.
- **Leaderboard trust:** client-written claim IDs, totals, and weekly points are not proof of a physical visit. Row-level security prevents cross-user writes but does not validate movement. Use server validation/rate limits before rewards or meaningful prizes; avoid uploading raw tracks by default.
- **CU-only membership:** the migration seeds `allowed_email_domain` as blank. Actual production setting is unknown. Confirm/enforce the intended eligibility policy, email delivery capacity, and consent before launch.
- **Accessibility:** available tags identify stairs, bridges and informal paths; they do not establish slope, curb cuts, door access, surface quality, or a continuous step-free route. Do not label a route “accessible” or “safe” from these tags alone. Add equivalent discovery goals for mobility-device users.
- **Path stability:** OSM redraws, splits and segment slicing can change claim identity. Version walkway data and design progress migration before frequent refreshes.
- **Scale/battery:** thousands of segments render and are scanned for progress/fog, and the app requests a screen wake lock. Profile on a midrange Android device; use spatial indexes and incremental totals before expanding the area.
- **Maintenance:** the inline app mixes GPS, UI, auth, map, and reporting. This branch isolates style and pure student helpers; next separate services/state/components gradually with regression coverage.
- **Privacy:** local raw tracks and cloud segment claims have different risks. “Raw GPS stays on-device” does not mean anonymous: claimed path IDs and timestamps can reveal places visited. Explicitly document that distinction, retention, export, deletion and public-profile choices.

## Suggested pilot and measures

Recruit 15–25 students across residence halls, commuters, international students, and students with mobility access needs. Ask them to find a new path, record a short walk, and prepare a sample maintenance request. Do not file fake reports. Observe where they get stuck and whether they return voluntarily over two weeks.

Measure first useful action, first successful recorded walk, week-two return rate, goal completion, interrupted recording rate, and maintenance requests with an actual acknowledgment. Prefer useful weekly activity over minutes spent staring at the app. Set baseline measures before numeric success targets. No analytics collection was added in this branch.

## Sources checked

- CU safety resources and official CU Boulder Safe capabilities: https://www.colorado.edu/publicsafety/resources
- CU NightRide and current access instructions: https://www.colorado.edu/umc/cunightride
- Facilities service requests: https://www.colorado.edu/fm/
- CUPD incident/pedestrian reporting: https://www.colorado.edu/police/services/report-incident
- Strava recording flow: https://support.strava.com/en-us/articles/15402137-how-do-i-record-an-activity-on-strava

## Validation and limits

Automated: inline JavaScript syntax, service worker/helper syntax, three pure-function regression tests (goal validation, walk summary deltas/privacy, unsubmitted draft wording), whitespace/diff checks. Browser: desktop dashboard; 390px mobile Today, Explore sheet, Progress/badges and Community; goal edit/reload persistence; blank draft validation; generated draft and clipboard confirmation; signed-out report gate. No real GPS walk, installed-PWA update on a physical phone, authenticated hazard insert/vote/delete, or production database tests. Those remain release checks; this branch is a reviewable first pass, not evidence of verified physical tracking or official incident handling.
