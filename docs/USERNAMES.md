# Nicknames (usernames)

Students choose a public nickname the first time they sign in. Other students see it on leaderboards, team lists, and paths they name. The nickname is a display value only: every relationship (claims, badges, streaks, team points, hazard pins, path names) still uses the account's internal ID. Changing a nickname never touches progress, team membership or history.

## How it works for students

1. After signing in, a student who has no nickname sees **"What should the herd call you?"** with a suggested campus-inspired nickname (for example *FlatironFox482*), plus **Use this name**, **Shuffle**, and **Create my own**.
2. The dialog explains that the name is public and doesn't guarantee complete anonymity. No real name is needed.
3. **Not now** keeps their old leaderboard name (if any) or the neutral `Buff 1A2B` placeholder. They're asked again next time, and Progress → Account shows **Choose your nickname**.
4. **Change** in Progress → Account opens the same dialog. A nickname can change **once every 7 days**. Exempt from that limit: the first pick, a change that only alters capitalization, and a change a moderator required.
5. Messages (exact wording from the spec):
   - Rejected: "That username doesn't meet our community guidelines. Choose another or use a suggested name." This offers **Suggest a name** and **Request review**.
   - Taken: "That name is taken. Try another or shuffle a new one."
   - Format: "Use 3–24 letters, numbers, or underscores, including at least one letter."

   Public messages never reveal which term or rule matched.
6. Any signed-in student can report another student's nickname. The flag button sits on each row of Community → Students this week, and the link is in a path's "Named by" dialog. A moderator reviews every report; reports never hide a name by themselves.

Screenshots: `docs/screenshots/nickname-*.png` (phone width, demo data only).

## Rules

| Rule | Where it's enforced |
|---|---|
| 3–24 ASCII letters, digits, `_`, at least one letter. Nothing is trimmed or rewritten. | `rr_username_format_ok` (DB check constraint + every RPC); `username-core.js` for instant feedback |
| Case-insensitive uniqueness; capitalization is kept for display | unique index on `lower(username)` |
| Look-alikes count as taken (`Zach_Urban` = `ZachUrban`, `Nor1in` = `Norlin`, `0`/`o`) | unique index on `username_skeleton` |
| A name someone just gave up is held for them for 30 days | `released_usernames` |
| Moderation on every generated name, custom submission and change | `set_username`, `check_username`, `suggest_username` (server only) |
| Names can't be written any other way | column privileges (students may update only `dorm`) **and** the `rr_profiles_guard` trigger |

Availability checks (`check_username`) are advisory. The real claim is a single `UPDATE` protected by the unique indexes, so when two students claim a name at the same moment, exactly one succeeds and the other gets "taken".

### Rate limits (per account)

| Action | Limit |
|---|---|
| Availability checks while typing | 60 per 10 minutes |
| Suggestions (Shuffle) | 60 per 10 minutes |
| Save attempts | 10 per hour |
| Nickname changes | 1 per 7 days (exemptions above) |
| Reports | 10 per day; one open report per reporter per nickname |
| Review requests | 5 per day; one open request at a time |

The limits are constants in `supabase/migrations/20261112190000_usernames.sql`. To change one, add a migration that re-creates the function.

## Generated nicknames

`suggest_username()` combines a campus or Boulder reference (`rr_name_refs()`: Flatiron, Norlin, Ralphie, Macky, Farrand, Chautauqua…) with a playful word (`rr_name_words()`: Fox, Nomad, Rambler, Marmot…). About 85% of the time it adds three random digits, skipping digit runs with unwanted meanings (69, 420, 666, 911, 187, 88, 13).

- It reads nothing about the student: no email, name, dorm, schedule or location. A test checks the function body for this.
- The lists were reviewed to leave out official, police, staff and emergency words (Ranger, Officer, Chief, Dean, Admin…).
- Every candidate goes through the same moderation as custom names and must be available.
- A test screens **every** combination (with digits) for moderation and the 24-character limit.
- Curated lists only, with no AI service involved.

## Moderation design

`rr_username_match()` keeps the stored display value untouched and builds several normalized views of it:

- words split at camelCase, acronyms, underscores and digits, and also left unsplit (so odd capitals like `MyAsS` don't hide a word)
- digits treated as word breaks (`Fox482`, `123fuck456`) **and** as letters (`0→o 1→i/l 3→e 4→a 5→s 6→g 7→t 8→b 9→g`)
- stretched letters allowed (`fuuuck`), without collapsing real double letters (`Bobb` ≠ `boob`)

Each term has a match mode, chosen to limit false positives:

| Mode | Use | Example |
|---|---|---|
| `substring` | Worst terms, caught anywhere, including across underscores (`f_u_c_k`) | slurs, severe profanity, `admin`, `police` |
| `token` | Short words that appear inside innocent words; whole words only | `ass` (so *Assistant*, *ClassAct* pass) |
| `edge` | Start or end of a word | `dick`, `cock`, `penis` |
| `phrase` | Consecutive words | "go die", LDNOOBW phrases |
| `regex` | Targeting patterns on joined letters | `…IsALiar`, `KillTheProfessor`, `DormRoom214` |

**Reviewed exceptions** (`moderation_exceptions`) handle the Scunthorpe problem with context:

- `token` exceptions apply only inside a single word. *Therapist* passes, but *TheRapist* and *the_rapist* are still blocked.
- `compact` exceptions also apply across word breaks (*WashItUp*, *Cockerell*, *Badminton*, *Pedometer*, *Stampede*).
- `phrase` exceptions cover word sequences (*SummaCumLaude*).

**Sources:**

1. **Maintained list:** the English [LDNOOBW](https://github.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words) list (CC BY 4.0), via the `naughty-words` npm package. It's loaded as whole-word and phrase rules by `scripts/build-moderation-terms.mjs`, minus a reviewed exclusion list: ordinary words like *hardcore* or *cornhole*, a politician's surname, a common Japanese given name, and phrases like "big black" that would block *BigBlackBear*. To update it, run `node scripts/build-moderation-terms.mjs`. That writes a **new** migration that adds terms and never deletes any.
2. **App policy** (seeded in the migration): substring/leet coverage for the worst terms, threats and self-harm taunts, targeted insults and accusations, impersonation of staff/police/emergency services/CU/the app, contact details, and numeric hate codes (`rr_username_digit_problem`).
3. **Administrator additions**, made on the moderation page. These live only in the database, not in the public repository.

**Not moderated:** identity, religion, nationality or viewpoint on their own. *GayBuff*, *MuslimMaverick*, *JewishNomad*, *BlackBuffalo*, *PalestineBuff*, *IsraelBuff*, *MAGA_Buff* and *BLM_Buff* are all allowed and covered by tests. Insult words on their own are also allowed (*LovableLoser*); the targeting pattern is what gets moderated. The filter blocks names that accuse someone; it doesn't try to decide whether an accusation is legally defamatory.

## Moderators

**Make someone a moderator** (Supabase SQL editor):

```sql
insert into public.app_admins (user_id)
select id from auth.users where email = 'moderator@colorado.edu';
```

They then open **`admin.html`** (Progress → Account shows "Open the moderation queue" for moderators). The page uses the app's sign-in. Every function behind it checks `app_admins` on the server, and the page itself contains no secrets.

**Queue actions** for each reported nickname. Reports are grouped per person, with reasons, reporter count and notes:

| Action | Effect |
|---|---|
| **Dismiss** | Closes the reports. A name hidden by the automated screen is shown again. |
| **Require a new name** | The owner is asked to choose a new name; the current one stays visible until then. |
| **Confirm abusive: hide now** | Replaced by the neutral `Buff 1A2B` placeholder immediately. The owner must choose an approved replacement, and the name and its look-alikes can never be claimed again. The account, team, progress and path names are kept. |
| **Restore** | Undoes a hide or a required change. |

Other moderator tools:

- **Review requests** show the requested name, what the filter matched, and availability. **Approve** allows the name and assigns it if it's still free; **Deny** leaves it blocked.
- **Test a name** shows exactly which rule matched and how the name was read. Moderators only.
- **Policy:** add a term or exception, disable a term, and **Re-scan all names**, which queues (never hides) existing names that fail a newly added rule.
- **Audit trail:** every moderator action and every nickname change, private to moderators. The term text of added rules is kept out of the log.

Many reports never hide a name automatically, so reporting can't be used to harass someone. One report per reporter per name, plus daily limits.

## Existing accounts (migration and review plan)

`20261112190200_username_legacy.sql` renames nobody. Oldest account first:

- **A legacy leaderboard name that fails moderation** is hidden behind the placeholder and queued for review (shown as "flagged by filter"). **Dismiss** shows it again. The owner is asked to choose a nickname either way.
- **A name that is already a valid nickname** (3–24 letters/digits/`_` with a letter) and isn't taken by an older account, case-insensitively or as a look-alike, **is kept exactly as typed** as their nickname.
- **Anything else** (spaces, punctuation, too short or long, a later duplicate) **keeps showing as before** until the owner picks a nickname. They get the picker on next sign-in.
- Accounts with no name show `Buff 1A2B` and get the picker.

The migration prints a count (`kept / hidden for review / will be asked to choose`).

**Before merging**, preview the effect with this read-only query. It uses only existing columns and runs in the SQL editor today:

```sql
with p as (
  select id, display_name, created_at,
         display_name ~ '^[A-Za-z0-9_]{3,24}$' and display_name ~ '[A-Za-z]' as valid,
         row_number() over (partition by translate(replace(lower(display_name), '_', ''), '01i', 'oll') order by created_at, id) as nth
  from public.profiles where display_name is not null)
select case when valid and nth = 1 then 'kept as nickname (if it passes moderation)'
            else 'still shown; asked to choose' end as outcome,
       count(*), array_agg(display_name order by created_at) filter (where not valid or nth > 1) as examples
from p group by 1;
```

To see which legacy names the filter would hide, apply the migrations to a Supabase **preview branch** (or a local `supabase db reset`). Then run:

```sql
select display_name from public.profiles where name_state = 'hidden' and name_state_reason = 'automated';
```

## Setup checklist

1. Merge after review. The Supabase GitHub integration applies the three migrations in order:
   - `20261112190000_usernames.sql`
   - `20261112190100_moderation_baseline_ldnoobw.sql`
   - `20261112190200_username_legacy.sql`
2. Add at least one moderator (SQL above).
3. Open the queue and work through any "flagged by filter" legacy names.
4. Nothing changes in `config.js`. The service worker version is bumped to `rr-v23`, so installed apps update on the next launch.

## Tests

```sh
node --test tests/*.test.cjs          # unit tests + database tests (database tests skip without Postgres)
```

- **`tests/usernames.sql.test.cjs`** runs every migration on a real PostgreSQL server, with `tests/supabase-shim.sql` standing in for Supabase's roles, default grants and `auth.uid()`. It calls each function the way the API does, as `authenticated` with a JWT subject. It covers:
  - accepting and shuffling suggestions
  - persistence and case-insensitive and look-alike collisions
  - 8 simultaneous claims
  - every fixture category, evasion patterns and false positives
  - Unicode and invisible characters
  - direct API bypass attempts
  - reports, the moderator queue, review requests and required changes
  - legacy accounts and missing names
  - changes that keep memberships and history
  - account deletion
- **`tests/ui/nickname-flow.ui.mjs`** drives the real screens in Chrome at phone size against the same database. It checks copy, focus, `aria-live`, labels, `aria-invalid`, 44 px touch targets, no overflow at 320 px, and no emails in public lists, then writes the screenshots.

`tests/fixtures/username-moderation.json` stores its harmful examples ROT13-encoded, so the publicly served repository doesn't carry a readable list of slurs. Don't use them in demos or screenshots; the UI run uses neutral demo names.

## Known limitations

- **Automated filters miss things.** They miss new slang, other languages (*PutaMadre*, *Scheisse*), insults that need context (*JakeCheated*, *EmilyIsMean*), and creative spellings outside the normalizations above. Reporting and review exist for these.
- **Some innocent names are still blocked.** The start/end-of-word rules block names like *Dick_Tracy_Fan*, and *RoboCop* trips the impersonation rule. Students can request review; moderators can approve the name and add an exception.
- **Targeted accusations** are caught only in common shapes ("X is a liar/creep/thief…", "kill the professor", accusations of sexual crimes). The filter can't know who is identifiable.
- **Look-alike detection** covers case, underscores, `0/o` and `1/i/l`. It doesn't cover every visually similar pair (`rn`/`m`, `vv`/`w`).
- **Rate limits are per account.** Someone with many accounts gets more tries. Restricting sign-up to `colorado.edu` (see README) limits this.
- **The seeded lists are public.** GitHub Pages serves the whole repository, including `supabase/migrations` and `tests`. The database protects the lists from the API, and moderator additions are private. If that matters, publish only the app files to Pages, for example with a Pages workflow that copies `index.html`, `*.js`, `*.css`, `icons/` and data files.
- **Phones still running the old app version** until the service worker updates can't save a team from the old "Save profile" button. Those clients still send `display_name`, which is now refused, and they see an error toast. Reopening the app fixes it.
- **Review results** appear in Progress → Account; there are no push or email notifications.
- **Database testing used plain PostgreSQL 16** with a Supabase stand-in, not a live Supabase project. Run the migrations on a preview branch before production.
