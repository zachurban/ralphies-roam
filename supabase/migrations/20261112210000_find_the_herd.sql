-- BuffPrints — Find the Herd (Phase 1): a campus scavenger hunt for friends and teams.
--
-- What the server is allowed to know
--   * Friends Mode and Demo Practice: nothing. They call only read-only functions here
--     (routes, answer checks) and the anonymous counters. No row is ever written about
--     a player or a herd. Teammates sync phone to phone through an encrypted relay that
--     never touches this database.
--   * Competition Mode (signed in): for each player, which checkpoint they completed,
--     when, and in_geofence = true. The phone compares GPS with the checkpoint itself and
--     sends only that yes/no — there is no column anywhere that could hold a coordinate.
--     For each team: its name, avatar, route, how many puzzles it solved, hints used and
--     its score. Plus one single-use demo reward token per finisher.
--   * Counters (hunt_metrics): one integer per route per step. No user ids, no timestamps.
--
-- Design rules (same as the nickname migrations)
--   * Every table has RLS on, no policies and no grants: the REST API can't read or write
--     them. Everything goes through the SECURITY DEFINER functions below.
--   * A team id is a random UUID that only teammates hold (it travels inside the encrypted
--     herd). It is never returned by standings or any public function.
--   * Phase 2 (sponsor campaigns, inventory locks, redemption portal, audit reports) hooks
--     in at hunt_reward_tokens.kind / status and hunt_editions; nothing here needs to change.

------------------------------------------------------------------------------
-- 1. Who is asking
------------------------------------------------------------------------------
-- The signed-in address, only if it is confirmed on the account AND matches the token.
create function public.hunt_verified_email()
returns text language sql stable security definer set search_path = '' as $$
  select lower(u.email) from auth.users u
  where u.id = auth.uid() and u.email_confirmed_at is not null
    and lower(u.email) = lower(coalesce(auth.jwt() ->> 'email', ''));
$$;

-- Standings and rewards are for verified colorado.edu accounts. Anyone may still play.
create function public.hunt_cu_verified()
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(public.hunt_verified_email() like '%_@colorado.edu', false);
$$;

-- Hunt administrators: listed by email, added only by someone with database access
-- (SQL editor). There is no sign-up path and no function that inserts here.
create table public.admin_allowlist (
  email    text primary key check (email = lower(email) and email like '%_@_%'),
  added_at timestamptz not null default now(),
  note     text
);

create function public.hunt_am_i_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.admin_allowlist a where a.email = public.hunt_verified_email());
$$;

create function public.hunt_require_admin()
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not public.hunt_am_i_admin() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
end $$;

------------------------------------------------------------------------------
-- 2. Routes: checkpoints, editions and their published versions
------------------------------------------------------------------------------
create table public.hunt_checkpoints (
  id                 text primary key check (id ~ '^[a-z0-9-]{2,40}$'),
  name               text not null check (char_length(name) between 1 and 80),
  spot               text not null default '' check (char_length(spot) <= 120),
  lat                double precision not null check (lat between 39.990 and 40.025),
  lng                double precision not null check (lng between -105.290 and -105.235),
  radius_m           int  not null default 35 check (radius_m between 15 and 150),
  access_note        text not null default '' check (char_length(access_note) <= 500),
  entrance_note      text not null default '' check (char_length(entrance_note) <= 500),
  needs_onsite_check boolean not null default true,   -- stays true until someone has stood there with a phone
  source_note        text not null default '' check (char_length(source_note) <= 300),
  sort               int  not null default 0
);

create table public.hunt_editions (
  id              text primary key check (id ~ '^[a-z0-9-]{2,40}$'),
  status          text not null default 'paused' check (status in ('active', 'paused')),
  current_version int  not null default 0,
  sort            int  not null default 0
);

-- Every publish is a new, immutable version. A run is locked to the version it started
-- on, so an edit never changes a puzzle under someone who is halfway round.
create table public.hunt_edition_versions (
  edition_id   text not null references public.hunt_editions (id) on delete cascade,
  version      int  not null check (version >= 1),
  content      jsonb not null,   -- what players download: route, puzzles, hints. No answers.
  answer_key   jsonb not null,   -- {"1": {"salt": "…", "hashes": ["…"]}, …}. Salted SHA-256 only; never sent to players.
  doc          jsonb not null,   -- the administrator's editable source for this version
  published_at timestamptz not null default now(),
  primary key (edition_id, version)
);

-- Aggregate funnel. A number goes up by one; nothing says who or when.
create table public.hunt_metrics (
  edition_id text   not null references public.hunt_editions (id) on delete cascade,
  metric_key text   not null check (metric_key in ('views', 'starts', 'checkpoint_1_completions', 'checkpoint_2_completions',
                      'checkpoint_3_completions', 'checkpoint_4_completions', 'checkpoint_5_completions', 'hints_used', 'completions')),
  count      bigint not null default 0 check (count >= 0),
  primary key (edition_id, metric_key)
);

------------------------------------------------------------------------------
-- 3. Competition Mode: the only player data the hunt stores
------------------------------------------------------------------------------
create table public.hunt_teams (
  id              uuid primary key default gen_random_uuid(),
  edition_id      text not null,
  edition_version int  not null,
  week            date not null,                       -- Monday of the run's week, Boulder time (rr_week)
  team_name       text not null check (char_length(team_name) between 3 and 24),
  avatar          text not null check (avatar in ('bison', 'fox', 'owl', 'elk', 'bear', 'hawk', 'trout', 'marmot', 'pika', 'columbine', 'flatiron', 'snowflake')),
  roster_locked   boolean not null default false,      -- set when the team completes its first checkpoint
  puzzles_solved  int  not null default 0 check (puzzles_solved between 0 and 5),
  final_score     int  not null default 0 check (final_score between 0 and 600),
  foreign key (edition_id, edition_version) references public.hunt_edition_versions (edition_id, version)
);
create index hunt_teams_week_idx on public.hunt_teams (week, edition_id);

create table public.hunt_members (
  team_id     uuid not null references public.hunt_teams (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  edition_id  text not null,
  counts      boolean not null,   -- this player's first competitive run of this route: only that one counts toward standings
  cu_verified boolean not null,   -- signed in with a confirmed @colorado.edu address (the address is not copied here)
  primary key (team_id, user_id)
);
create index hunt_members_user_idx on public.hunt_members (user_id, edition_id);

-- Shared puzzle state for a team: enough to score it, nothing more.
create table public.hunt_team_puzzles (
  team_id       uuid not null references public.hunt_teams (id) on delete cascade,
  checkpoint_no int  not null check (checkpoint_no between 1 and 5),
  hints_used    int  not null default 0 check (hints_used between 0 and 2),
  solved        boolean not null default false,
  points        int  not null default 0 check (points in (0, 60, 80, 100)),
  primary key (team_id, checkpoint_no)
);

-- One row per player per completed checkpoint. in_geofence can only be true: a check-in
-- that isn't inside the checkpoint is refused, not stored.
create table public.hunt_checkins (
  team_id       uuid not null,
  user_id       uuid not null references auth.users (id) on delete cascade,
  edition_id    text not null,
  checkpoint_id text not null,
  checkpoint_no int  not null check (checkpoint_no between 1 and 5),
  completed_at  timestamptz not null default now(),
  in_geofence   boolean not null check (in_geofence),
  primary key (team_id, user_id, checkpoint_no),
  foreign key (team_id, user_id) references public.hunt_members (team_id, user_id) on delete cascade
);
create index hunt_checkins_user_idx on public.hunt_checkins (user_id);

-- Demo reward wallet. One token per player per route, issued on 5/5 verified check-ins.
-- kind is 'demo' only in Phase 1: "Demo reward — not redeemable. No purchase benefit is available."
create table public.hunt_reward_tokens (
  token       text primary key default ('DEMO-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12))),
  user_id     uuid not null references auth.users (id) on delete cascade,
  team_id     uuid references public.hunt_teams (id) on delete set null,
  edition_id  text not null references public.hunt_editions (id),
  kind        text not null default 'demo' check (kind in ('demo')),
  status      text not null default 'issued' check (status in ('issued', 'used')),
  issued_week date not null,
  used_at     timestamptz,
  unique (user_id, edition_id)
);

alter table public.admin_allowlist       enable row level security;
alter table public.hunt_checkpoints      enable row level security;
alter table public.hunt_editions         enable row level security;
alter table public.hunt_edition_versions enable row level security;
alter table public.hunt_metrics          enable row level security;
alter table public.hunt_teams            enable row level security;
alter table public.hunt_members          enable row level security;
alter table public.hunt_team_puzzles     enable row level security;
alter table public.hunt_checkins         enable row level security;
alter table public.hunt_reward_tokens    enable row level security;

revoke all on public.admin_allowlist, public.hunt_checkpoints, public.hunt_editions, public.hunt_edition_versions,
  public.hunt_metrics, public.hunt_teams, public.hunt_members, public.hunt_team_puzzles, public.hunt_checkins,
  public.hunt_reward_tokens from anon, authenticated;

------------------------------------------------------------------------------
-- 4. Answers: salted hashes only
------------------------------------------------------------------------------
-- Same rule as herd-core.js normalizeAnswer: keep ASCII letters and digits, then lowercase.
create function public.hunt_norm_answer(p text)
returns text language sql immutable parallel safe set search_path = '' as $$
  select lower(regexp_replace(coalesce(p, ''), '[^A-Za-z0-9]', '', 'g'));
$$;

create function public.hunt_hash_answer(p_salt text, p_answer text)
returns text language sql immutable parallel safe set search_path = '' as $$
  select encode(sha256(convert_to(p_salt || ':' || public.hunt_norm_answer(p_answer), 'UTF8')), 'hex');
$$;

create function public.hunt_answer_ok(p_edition text, p_version int, p_no int, p_answer text)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((
    select public.hunt_norm_answer(p_answer) <> ''
       and (v.answer_key -> p_no::text -> 'hashes') ? public.hunt_hash_answer(v.answer_key -> p_no::text ->> 'salt', p_answer)
    from public.hunt_edition_versions v
    where v.edition_id = p_edition and v.version = p_version), false);
$$;

------------------------------------------------------------------------------
-- 5. Publishing
------------------------------------------------------------------------------
-- The published shape. scripts/build-hunt.mjs builds the identical object for the copy the
-- app carries (tests/hunt.sql.test.cjs compares the two).
create function public.hunt_build_content(p_edition text, p_version int, p_doc jsonb)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', p_edition, 'version', p_version,
    'title', p_doc ->> 'title', 'theme', p_doc ->> 'theme', 'style', p_doc ->> 'style', 'intro', p_doc ->> 'intro',
    'demo', coalesce((p_doc ->> 'demo')::boolean, false),
    'est_minutes', p_doc -> 'est_minutes', 'walk_minutes', p_doc -> 'walk_minutes',
    'checkpoints', (
      select jsonb_agg(jsonb_build_object(
        'no', (p ->> 'no')::int, 'id', c.id, 'name', c.name, 'spot', c.spot, 'lat', c.lat, 'lng', c.lng, 'radius_m', c.radius_m,
        'access_note', c.access_note, 'entrance_note', c.entrance_note, 'needs_onsite_check', c.needs_onsite_check,
        'puzzle', jsonb_build_object('kind', p ->> 'kind', 'format', p ->> 'format', 'prompt', p ->> 'prompt',
                    'hints', p -> 'hints', 'pieces', coalesce(p -> 'pieces', '[]'::jsonb),
                    'needs_onsite_check', coalesce((p ->> 'needs_onsite_check')::boolean, true),
                    'onsite_note', coalesce(p ->> 'onsite_note', ''))
      ) order by (p ->> 'no')::int)
      from jsonb_array_elements(p_doc -> 'puzzles') p
      join public.hunt_checkpoints c on c.id = p ->> 'checkpoint'));
$$;

-- Validates a route document, hashes any plain answers it carries, and stores it as the
-- next version. A puzzle may give:
--   "answers": ["plain", "also accepted"]         hashed here with a fresh salt, then discarded
--   "answer_salt" + "answer_hashes"                already hashed (how the seed arrives)
--   neither                                        keeps that puzzle's answers from the current version
create function public.hunt_publish_internal(p_edition text, p_doc jsonb)
returns int language plpgsql security definer set search_path = '' as $$
declare
  cur int; nextv int; prev_key jsonb; key jsonb := '{}'::jsonb; puzzles jsonb := '[]'::jsonb;
  p jsonb; i int := 0; salt text; hashes text[]; clean jsonb;
begin
  select current_version into cur from public.hunt_editions where id = p_edition for update;
  if cur is null then raise exception 'Unknown route %', p_edition; end if;
  if jsonb_typeof(p_doc) is distinct from 'object' then raise exception 'The route must be a JSON object'; end if;
  if char_length(coalesce(p_doc ->> 'title', '')) not between 1 and 80 then raise exception 'Give the route a title (up to 80 characters)'; end if;
  if char_length(coalesce(p_doc ->> 'theme', '')) > 60 or char_length(coalesce(p_doc ->> 'style', '')) > 80
     or char_length(coalesce(p_doc ->> 'intro', '')) > 400 then raise exception 'Theme, style or intro is too long'; end if;
  if jsonb_typeof(p_doc -> 'puzzles') is distinct from 'array' or jsonb_array_length(p_doc -> 'puzzles') <> 5 then
    raise exception 'A route needs exactly 5 puzzles';
  end if;
  select answer_key into prev_key from public.hunt_edition_versions where edition_id = p_edition and version = cur;

  for p in select * from jsonb_array_elements(p_doc -> 'puzzles') loop
    i := i + 1;
    if (p ->> 'no') is distinct from i::text then raise exception 'Puzzles must be numbered 1 to 5, in order'; end if;
    if not exists (select 1 from public.hunt_checkpoints where id = p ->> 'checkpoint') then
      raise exception 'Puzzle %: unknown checkpoint "%"', i, p ->> 'checkpoint';
    end if;
    if coalesce(p ->> 'kind', '') not in ('observe', 'cipher', 'split') then raise exception 'Puzzle %: kind must be observe, cipher or split', i; end if;
    if char_length(coalesce(p ->> 'prompt', '')) not between 1 and 600 then raise exception 'Puzzle %: write a prompt (up to 600 characters)', i; end if;
    if char_length(coalesce(p ->> 'format', '')) > 40 or char_length(coalesce(p ->> 'onsite_note', '')) > 400 then raise exception 'Puzzle %: format or on-site note is too long', i; end if;
    if jsonb_typeof(p -> 'hints') is distinct from 'array' or jsonb_array_length(p -> 'hints') <> 2
       or exists (select 1 from jsonb_array_elements(p -> 'hints') h where jsonb_typeof(h) <> 'string' or char_length(h #>> '{}') not between 1 and 300) then
      raise exception 'Puzzle %: give exactly 2 hints', i;
    end if;
    if p ->> 'kind' = 'split' then
      if jsonb_typeof(p -> 'pieces') is distinct from 'array' or jsonb_array_length(p -> 'pieces') not between 2 and 6
         or exists (select 1 from jsonb_array_elements(p -> 'pieces') h where jsonb_typeof(h) <> 'string' or char_length(h #>> '{}') not between 1 and 300) then
        raise exception 'Puzzle %: a split puzzle needs 2 to 6 pieces', i;
      end if;
    end if;

    if jsonb_typeof(p -> 'answers') = 'array' and jsonb_array_length(p -> 'answers') > 0 then
      salt := substr(encode(sha256(convert_to(gen_random_uuid()::text || clock_timestamp()::text, 'UTF8')), 'hex'), 1, 32);
      select array_agg(distinct public.hunt_hash_answer(salt, a)) into hashes
        from jsonb_array_elements_text(p -> 'answers') a where public.hunt_norm_answer(a) <> '';
      if hashes is null then raise exception 'Puzzle %: answers need at least one letter or digit', i; end if;
    elsif coalesce(p ->> 'answer_salt', '') <> '' and jsonb_typeof(p -> 'answer_hashes') = 'array' and jsonb_array_length(p -> 'answer_hashes') > 0 then
      salt := p ->> 'answer_salt';
      select array_agg(distinct h) into hashes from jsonb_array_elements_text(p -> 'answer_hashes') h;
      if char_length(salt) < 16 or exists (select 1 from unnest(hashes) h where h !~ '^[0-9a-f]{64}$') then
        raise exception 'Puzzle %: answer_salt or answer_hashes is malformed', i;
      end if;
    elsif prev_key ? i::text then
      salt := prev_key -> i::text ->> 'salt';
      select array_agg(h) into hashes from jsonb_array_elements_text(prev_key -> i::text -> 'hashes') h;
    else
      raise exception 'Puzzle %: add "answers": ["…"]', i;
    end if;
    key := key || jsonb_build_object(i::text, jsonb_build_object('salt', salt, 'hashes', to_jsonb(hashes)));
    clean := (p - 'answers' - 'answer_salt' - 'answer_hashes') || jsonb_build_object('no', i);
    if clean ->> 'kind' <> 'split' then clean := clean || jsonb_build_object('pieces', '[]'::jsonb); end if;
    puzzles := puzzles || jsonb_build_array(clean);
  end loop;

  nextv := cur + 1;
  p_doc := jsonb_build_object('title', p_doc ->> 'title', 'theme', coalesce(p_doc ->> 'theme', ''), 'style', coalesce(p_doc ->> 'style', ''),
             'intro', coalesce(p_doc ->> 'intro', ''), 'demo', coalesce((p_doc ->> 'demo')::boolean, false),
             'est_minutes', coalesce(p_doc -> 'est_minutes', '[20, 40]'::jsonb), 'walk_minutes', coalesce(p_doc -> 'walk_minutes', '[10, 15]'::jsonb),
             'puzzles', puzzles);
  insert into public.hunt_edition_versions (edition_id, version, content, answer_key, doc)
  values (p_edition, nextv, public.hunt_build_content(p_edition, nextv, p_doc), key, p_doc);
  update public.hunt_editions set current_version = nextv where id = p_edition;
  return nextv;
end $$;

create function public.hunt_seed_metrics(p_edition text)
returns void language sql security definer set search_path = '' as $$
  insert into public.hunt_metrics (edition_id, metric_key)
  select p_edition, k from unnest(array['views', 'starts', 'checkpoint_1_completions', 'checkpoint_2_completions', 'checkpoint_3_completions',
                                        'checkpoint_4_completions', 'checkpoint_5_completions', 'hints_used', 'completions']) k
  on conflict do nothing;
$$;

------------------------------------------------------------------------------
-- 6. Functions anyone can call (signed in or not). None of them writes a row about a player.
------------------------------------------------------------------------------
-- Active routes at their current version.
create function public.hunt_get_editions()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(v.content order by e.sort, e.id), '[]'::jsonb)
  from public.hunt_editions e
  join public.hunt_edition_versions v on v.edition_id = e.id and v.version = e.current_version
  where e.status = 'active';
$$;

-- A specific version: lets a run keep playing the version it started on.
create function public.hunt_get_edition_version(p_edition text, p_version int)
returns jsonb language sql stable security definer set search_path = '' as $$
  select v.content from public.hunt_edition_versions v where v.edition_id = p_edition and v.version = p_version;
$$;

-- Friends Mode / Demo Practice answer check. Read-only: nothing is recorded, not even that it was asked.
create function public.hunt_check_answer(p_edition text, p_version int, p_checkpoint int, p_answer text)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.hunt_answer_ok(p_edition, p_version, p_checkpoint, left(coalesce(p_answer, ''), 200));
$$;

-- Anonymous funnel counter: adds 1 to an existing number. No user id, no timestamp, no new row.
-- Unknown routes or keys do nothing.
create function public.increment_hunt_metric(p_edition_id text, p_metric_key text)
returns void language sql volatile security definer set search_path = '' as $$
  update public.hunt_metrics set count = count + 1 where edition_id = p_edition_id and metric_key = p_metric_key;
$$;

------------------------------------------------------------------------------
-- 7. Scoring (same arithmetic as herd-core.js)
------------------------------------------------------------------------------
-- 100 per completed checkpoint, 20 off per hint the team used (never below 60), +100 for all five.
create function public.hunt_member_points(p_team uuid, p_user uuid)
returns int language sql stable security definer set search_path = '' as $$
  select (coalesce(sum(tp.points), 0) + case when count(*) = 5 then 100 else 0 end)::int
  from public.hunt_checkins c
  join public.hunt_team_puzzles tp on tp.team_id = c.team_id and tp.checkpoint_no = c.checkpoint_no and tp.solved
  where c.team_id = p_team and c.user_id = p_user;
$$;

-- Team score = average over the players who checked in somewhere, so headcount never wins.
-- Players on a repeat run are left out of the average (their first run already counted);
-- a team made only of repeat runs still sees a score, but is not listed in standings.
create function public.hunt_recompute(p_team uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare s numeric;
begin
  select avg(x.pts) into s from (
    select public.hunt_member_points(m.team_id, m.user_id) as pts, m.counts
    from public.hunt_members m
    where m.team_id = p_team and exists (select 1 from public.hunt_checkins c where c.team_id = m.team_id and c.user_id = m.user_id)
  ) x
  where x.counts or not exists (
    select 1 from public.hunt_members m2 where m2.team_id = p_team and m2.counts
      and exists (select 1 from public.hunt_checkins c2 where c2.team_id = m2.team_id and c2.user_id = m2.user_id));
  update public.hunt_teams t set
    final_score = coalesce(round(s), 0)::int,
    puzzles_solved = (select count(*) from public.hunt_team_puzzles tp where tp.team_id = p_team and tp.solved)
  where t.id = p_team;
end $$;

-- Does a new run of this route count toward standings for this player? Only the first one:
-- not if they already finished a counting run, and not a second team in the same week.
create function public.hunt_counts(p_user uuid, p_edition text)
returns boolean language sql stable security definer set search_path = '' as $$
  select not exists (
    select 1 from public.hunt_members m
    join public.hunt_teams t on t.id = m.team_id
    where m.user_id = p_user and m.edition_id = p_edition and m.counts
      and (t.week = public.rr_week()
           or (select count(*) from public.hunt_checkins c where c.team_id = m.team_id and c.user_id = p_user) = 5));
$$;

-- Team names are public on standings, so they pass the same moderation as nicknames.
-- NULL = fine; otherwise 'name_format' or 'name_guidelines' (never which rule matched).
create function public.hunt_team_name_problem(p text)
returns text language plpgsql stable security definer set search_path = '' as $$
begin
  if p is null or octet_length(p) <> char_length(p) or p !~ '^[A-Za-z0-9]+( [A-Za-z0-9]+)*$'
     or char_length(p) not between 3 and 24 or p !~ '[A-Za-z]' then
    return 'name_format';
  end if;
  if public.rr_username_problem(p) is not null or public.rr_username_digit_problem(p) is not null
     or public.rr_username_problem(replace(p, ' ', '')) is not null or public.rr_name_problem(p) is not null then
    return 'name_guidelines';
  end if;
  return null;
end $$;

------------------------------------------------------------------------------
-- 8. Competition Mode (signed in)
------------------------------------------------------------------------------
-- What the app shows about me before I start.
create function public.hunt_whoami()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'signed_in', auth.uid() is not null,
    'cu_verified', public.hunt_cu_verified(),
    'admin', public.hunt_am_i_admin(),
    'nickname', (select public.rr_public_name(p.id, p.username, p.display_name, p.name_state) from public.profiles p where p.id = auth.uid()),
    'affiliation', (select p.dorm from public.profiles p where p.id = auth.uid()));
$$;

-- My view of a team I belong to.
create function public.hunt_team_summary(p_team uuid, p_user uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'team_id', t.id, 'edition_id', t.edition_id, 'edition_version', t.edition_version,
    'team_name', t.team_name, 'avatar', t.avatar, 'roster_locked', t.roster_locked,
    'open', t.week = public.rr_week(),
    'counts', m.counts, 'cu_verified', m.cu_verified,
    'team_score', t.final_score, 'puzzles_solved', t.puzzles_solved,
    'my_points', public.hunt_member_points(t.id, p_user),
    'my_checkpoints', coalesce((select jsonb_agg(c.checkpoint_no order by c.checkpoint_no) from public.hunt_checkins c where c.team_id = t.id and c.user_id = p_user), '[]'::jsonb),
    'puzzles', coalesce((select jsonb_agg(jsonb_build_object('no', tp.checkpoint_no, 'solved', tp.solved, 'hints_used', tp.hints_used, 'points', tp.points) order by tp.checkpoint_no)
                         from public.hunt_team_puzzles tp where tp.team_id = t.id), '[]'::jsonb),
    'players', (select count(*) from public.hunt_members x where x.team_id = t.id))
  from public.hunt_teams t
  join public.hunt_members m on m.team_id = t.id and m.user_id = p_user
  where t.id = p_team;
$$;

-- Start a competitive run. Statuses: ok | unavailable | name_format | name_guidelines | bad_avatar | too_many
create function public.hunt_create_team(p_edition text, p_team_name text, p_avatar text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); ver int; prob text; tid uuid; c boolean;
begin
  if uid is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  select current_version into ver from public.hunt_editions where id = p_edition and status = 'active' and current_version > 0;
  if ver is null then return jsonb_build_object('status', 'unavailable'); end if;
  p_team_name := btrim(regexp_replace(coalesce(p_team_name, ''), '\s+', ' ', 'g'));
  prob := public.hunt_team_name_problem(p_team_name);
  if prob is not null then return jsonb_build_object('status', prob); end if;
  if p_avatar is null or p_avatar not in ('bison', 'fox', 'owl', 'elk', 'bear', 'hawk', 'trout', 'marmot', 'pika', 'columbine', 'flatiron', 'snowflake') then
    return jsonb_build_object('status', 'bad_avatar');
  end if;
  if (select count(*) from public.hunt_members m join public.hunt_teams t on t.id = m.team_id
      where m.user_id = uid and t.week = public.rr_week()) >= 6 then
    return jsonb_build_object('status', 'too_many');
  end if;
  c := public.hunt_counts(uid, p_edition);
  insert into public.hunt_teams (edition_id, edition_version, week, team_name, avatar)
  values (p_edition, ver, public.rr_week(), p_team_name, p_avatar) returning id into tid;
  insert into public.hunt_members (team_id, user_id, edition_id, counts, cu_verified)
  values (tid, uid, p_edition, c, public.hunt_cu_verified());
  return jsonb_build_object('status', 'ok') || public.hunt_team_summary(tid, uid);
end $$;

-- Join a teammate's run (the team id arrives inside the encrypted herd).
-- Statuses: ok | not_found | expired | roster_locked | full
create function public.hunt_join_team(p_team uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); t public.hunt_teams;
begin
  if uid is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  select * into t from public.hunt_teams where id = p_team for update;
  if t.id is null then return jsonb_build_object('status', 'not_found'); end if;
  if exists (select 1 from public.hunt_members where team_id = p_team and user_id = uid) then
    return jsonb_build_object('status', 'ok') || public.hunt_team_summary(p_team, uid);
  end if;
  if t.week <> public.rr_week() then return jsonb_build_object('status', 'expired'); end if;
  if t.roster_locked then return jsonb_build_object('status', 'roster_locked'); end if;
  if (select count(*) from public.hunt_members where team_id = p_team) >= 8 then return jsonb_build_object('status', 'full'); end if;
  insert into public.hunt_members (team_id, user_id, edition_id, counts, cu_verified)
  values (p_team, uid, t.edition_id, public.hunt_counts(uid, t.edition_id), public.hunt_cu_verified());
  return jsonb_build_object('status', 'ok') || public.hunt_team_summary(p_team, uid);
end $$;

-- Leave. Before any check-in the membership is simply removed. After that the player keeps
-- their personal credit and may carry on alone (same team id, same rules). Statuses: left | kept | not_member
create function public.hunt_leave_team(p_team uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  perform 1 from public.hunt_teams where id = p_team for update;
  if not exists (select 1 from public.hunt_members where team_id = p_team and user_id = uid) then
    return jsonb_build_object('status', 'not_member');
  end if;
  if exists (select 1 from public.hunt_checkins where team_id = p_team and user_id = uid) then
    return jsonb_build_object('status', 'kept');
  end if;
  delete from public.hunt_members where team_id = p_team and user_id = uid;
  if not exists (select 1 from public.hunt_members where team_id = p_team) then
    delete from public.hunt_teams where id = p_team;
  end if;
  return jsonb_build_object('status', 'left');
end $$;

-- Reveal a hint for the team (costs 20 points on that checkpoint, at most two, floor of 60).
-- Statuses: ok | solved | max | not_member | expired
create function public.hunt_use_hint(p_team uuid, p_checkpoint int)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); t public.hunt_teams; tp public.hunt_team_puzzles;
begin
  if uid is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  if p_checkpoint is null or p_checkpoint not between 1 and 5 then raise exception 'Unknown checkpoint'; end if;
  select * into t from public.hunt_teams where id = p_team for update;
  if t.id is null or not exists (select 1 from public.hunt_members where team_id = p_team and user_id = uid) then
    return jsonb_build_object('status', 'not_member');
  end if;
  if t.week <> public.rr_week() then return jsonb_build_object('status', 'expired'); end if;
  insert into public.hunt_team_puzzles (team_id, checkpoint_no) values (p_team, p_checkpoint) on conflict do nothing;
  select * into tp from public.hunt_team_puzzles where team_id = p_team and checkpoint_no = p_checkpoint;
  if tp.solved then return jsonb_build_object('status', 'solved', 'hints_used', tp.hints_used); end if;
  if tp.hints_used >= 2 then return jsonb_build_object('status', 'max', 'hints_used', tp.hints_used); end if;
  update public.hunt_team_puzzles set hints_used = hints_used + 1 where team_id = p_team and checkpoint_no = p_checkpoint;
  return jsonb_build_object('status', 'ok', 'hints_used', tp.hints_used + 1);
end $$;

-- The check-in. The phone has already decided whether it is inside the checkpoint; it sends
-- that yes/no and the puzzle answer. No coordinate is accepted, so none can be stored.
--   * Refused (nothing stored) unless p_in_geofence is true and the answer is right — or the
--     team has already solved this puzzle, in which case the player only needs to be there.
--   * Repeating a check-in changes nothing and returns the same result (status "already").
--   * The first completed checkpoint freezes the roster.
--   * 5/5 for a verified colorado.edu player on a counting run issues one demo reward token.
-- Statuses: ok | already | wrong_answer | not_in_geofence | not_member | expired
create function public.hunt_check_in(p_team uuid, p_checkpoint int, p_in_geofence boolean, p_answer text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid(); t public.hunt_teams; m public.hunt_members; tp public.hunt_team_puzzles;
  cp_id text; n int; tok text; st text := 'ok';
begin
  if uid is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  if p_checkpoint is null or p_checkpoint not between 1 and 5 then raise exception 'Unknown checkpoint'; end if;
  select * into t from public.hunt_teams where id = p_team for update;
  if t.id is not null then select * into m from public.hunt_members where team_id = p_team and user_id = uid; end if;
  if t.id is null or m.user_id is null then return jsonb_build_object('status', 'not_member'); end if;

  if exists (select 1 from public.hunt_checkins where team_id = p_team and user_id = uid and checkpoint_no = p_checkpoint) then
    st := 'already';
  else
    if t.week <> public.rr_week() then return jsonb_build_object('status', 'expired'); end if;
    if p_in_geofence is not true then return jsonb_build_object('status', 'not_in_geofence'); end if;
    select * into tp from public.hunt_team_puzzles where team_id = p_team and checkpoint_no = p_checkpoint;
    if tp.solved is not true then
      if not public.hunt_answer_ok(t.edition_id, t.edition_version, p_checkpoint, left(coalesce(p_answer, ''), 200)) then
        return jsonb_build_object('status', 'wrong_answer');
      end if;
      insert into public.hunt_team_puzzles (team_id, checkpoint_no, solved, points) values (p_team, p_checkpoint, true, 100)
      on conflict (team_id, checkpoint_no) do update
        set solved = true, points = greatest(60, 100 - 20 * public.hunt_team_puzzles.hints_used);
    end if;
    select c ->> 'id' into cp_id
    from public.hunt_edition_versions v, jsonb_array_elements(v.content -> 'checkpoints') c
    where v.edition_id = t.edition_id and v.version = t.edition_version and (c ->> 'no')::int = p_checkpoint;
    insert into public.hunt_checkins (team_id, user_id, edition_id, checkpoint_id, checkpoint_no, in_geofence)
    values (p_team, uid, t.edition_id, cp_id, p_checkpoint, true)
    on conflict do nothing;
    if not t.roster_locked then update public.hunt_teams set roster_locked = true where id = p_team; end if;
    perform public.hunt_recompute(p_team);
  end if;

  select count(*) into n from public.hunt_checkins where team_id = p_team and user_id = uid;
  if n = 5 and m.counts and m.cu_verified then
    insert into public.hunt_reward_tokens (user_id, team_id, edition_id, issued_week)
    values (uid, p_team, t.edition_id, t.week)
    on conflict (user_id, edition_id) do nothing;
    select token into tok from public.hunt_reward_tokens where user_id = uid and edition_id = t.edition_id and team_id = p_team;
  end if;
  return jsonb_build_object('status', st, 'completed', n = 5, 'reward_token', tok,
           'reward_note', case when n = 5 and tok is null then
             case when not m.counts then 'repeat_run' when not m.cu_verified then 'not_cu' else null end end)
         || public.hunt_team_summary(p_team, uid);
end $$;

-- My run of this route this week, if any (lets a phone that lost its herd carry on solo).
create function public.hunt_my_run(p_edition text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select public.hunt_team_summary(t.id, auth.uid())
         || jsonb_build_object('content', (select v.content from public.hunt_edition_versions v where v.edition_id = t.edition_id and v.version = t.edition_version))
  from public.hunt_members m
  join public.hunt_teams t on t.id = m.team_id
  where m.user_id = auth.uid() and m.edition_id = p_edition and t.week = public.rr_week()
  order by m.counts desc, (select count(*) from public.hunt_checkins c where c.team_id = t.id and c.user_id = m.user_id) desc, t.id
  limit 1;
$$;

-- Weekly standings for one route. Names, avatars, affiliations and scores only — never who
-- is on a team, team ids, times or places. Ties share a rank.
--   teams         herds with at least one verified colorado.edu player on a counting run
--   affiliations  dorm/team (from the existing profile field) of verified players: average personal score
create function public.hunt_standings(p_edition text, p_week date default null)
returns jsonb language sql stable security definer set search_path = '' as $$
  with w as (select coalesce(p_week, public.rr_week()) as week),
  scoring as (
    select m.team_id, m.user_id, m.cu_verified, p.dorm,
           public.hunt_member_points(m.team_id, m.user_id) as pts,
           (select count(*) from public.hunt_checkins c where c.team_id = m.team_id and c.user_id = m.user_id) as n
    from public.hunt_members m
    join public.hunt_teams t on t.id = m.team_id
    left join public.profiles p on p.id = m.user_id
    where t.edition_id = p_edition and t.week = (select week from w) and m.counts
  ),
  teams as (
    select t.id, t.team_name, t.avatar, t.final_score,
           count(*) as players, bool_and(s.cu_verified) as all_cu, bool_and(s.n = 5) as finished,
           case when count(distinct coalesce(s.dorm, '')) = 1 then max(s.dorm) else 'Mixed herd' end as affiliation
    from scoring s join public.hunt_teams t on t.id = s.team_id
    where s.n > 0
    group by t.id, t.team_name, t.avatar, t.final_score
    having bool_or(s.cu_verified)
  ),
  affs as (
    select s.dorm, count(*) as players, round(avg(s.pts))::int as score, count(*) filter (where s.n = 5) as finished
    from scoring s where s.n > 0 and s.cu_verified and s.dorm is not null
    group by s.dorm
  )
  select jsonb_build_object(
    'week', (select week from w),
    'teams', coalesce((select jsonb_agg(x order by x.rank, x.team_name) from (
        select rank() over (order by tm.final_score desc) as rank, tm.team_name, tm.avatar, tm.affiliation, tm.final_score as score,
               tm.players, tm.finished, tm.all_cu as verified,
               exists (select 1 from public.hunt_members me where me.team_id = tm.id and me.user_id = auth.uid()) as is_mine
        from teams tm order by 1, 2 limit 100) x), '[]'::jsonb),
    'affiliations', coalesce((select jsonb_agg(y order by y.rank, y.affiliation) from (
        select rank() over (order by a.score desc) as rank, a.dorm as affiliation, a.score, a.players, a.finished,
               a.dorm = (select dorm from public.profiles where id = auth.uid()) as is_mine
        from affs a order by 1, 2 limit 50) y), '[]'::jsonb));
$$;

-- Demo reward wallet.
create function public.hunt_my_wallet()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'token', r.token, 'kind', r.kind, 'status', r.status, 'edition_id', r.edition_id, 'week', r.issued_week,
           'title', (select v.content ->> 'title' from public.hunt_editions e join public.hunt_edition_versions v
                       on v.edition_id = e.id and v.version = e.current_version where e.id = r.edition_id))
         order by r.issued_week desc, r.token), '[]'::jsonb)
  from public.hunt_reward_tokens r where r.user_id = auth.uid();
$$;

-- A token can be used exactly once. In Phase 1 this only demonstrates the single-use rule:
-- demo tokens are not redeemable for anything. Statuses: ok | already_used | not_found
create function public.hunt_use_token(p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); s text;
begin
  if uid is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  update public.hunt_reward_tokens set status = 'used', used_at = now()
  where token = p_token and user_id = uid and status = 'issued';
  if found then return jsonb_build_object('status', 'ok'); end if;
  select status into s from public.hunt_reward_tokens where token = p_token and user_id = uid;
  return jsonb_build_object('status', case when s = 'used' then 'already_used' else 'not_found' end);
end $$;

------------------------------------------------------------------------------
-- 9. Administrator functions (each one checks admin_allowlist on the server)
------------------------------------------------------------------------------
create function public.hunt_admin_overview()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.hunt_require_admin();
  return jsonb_build_object(
    'checkpoints', coalesce((select jsonb_agg(to_jsonb(c) order by c.sort, c.id) from public.hunt_checkpoints c), '[]'::jsonb),
    'editions', coalesce((select jsonb_agg(jsonb_build_object(
        'id', e.id, 'status', e.status, 'current_version', e.current_version, 'sort', e.sort, 'published_at', v.published_at,
        'runs_this_week', (select count(*) from public.hunt_teams t where t.edition_id = e.id and t.week = public.rr_week()),
        -- the editable document, with each puzzle's stored salt and hashes (never plain answers: they are not kept)
        'doc', case when v.doc is null then null else v.doc || jsonb_build_object('puzzles', (
                 select jsonb_agg(p || jsonb_build_object('answer_salt', v.answer_key -> (p ->> 'no') ->> 'salt',
                                                          'answer_hashes', v.answer_key -> (p ->> 'no') -> 'hashes') order by (p ->> 'no')::int)
                 from jsonb_array_elements(v.doc -> 'puzzles') p)) end
      ) order by e.sort, e.id)
      from public.hunt_editions e
      left join public.hunt_edition_versions v on v.edition_id = e.id and v.version = e.current_version), '[]'::jsonb),
    'metrics', coalesce((select jsonb_agg(jsonb_build_object('edition_id', m.edition_id, 'metric_key', m.metric_key, 'count', m.count)
                                          order by m.edition_id, m.metric_key) from public.hunt_metrics m), '[]'::jsonb));
end $$;

-- Create or edit a checkpoint. Routes that use it are republished automatically (same
-- puzzles and answers, new version); runs in progress keep the version they started on.
create function public.hunt_admin_save_checkpoint(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare cid text := p ->> 'id'; e record; bumped jsonb := '[]'::jsonb;
begin
  perform public.hunt_require_admin();
  if jsonb_typeof(p) is distinct from 'object' or cid is null then raise exception 'A checkpoint needs an id'; end if;
  insert into public.hunt_checkpoints (id, name, spot, lat, lng, radius_m, access_note, entrance_note, needs_onsite_check, source_note, sort)
  values (cid, p ->> 'name', coalesce(p ->> 'spot', ''), (p ->> 'lat')::double precision, (p ->> 'lng')::double precision,
          coalesce((p ->> 'radius_m')::int, 35), coalesce(p ->> 'access_note', ''), coalesce(p ->> 'entrance_note', ''),
          coalesce((p ->> 'needs_onsite_check')::boolean, true), coalesce(p ->> 'source_note', ''), coalesce((p ->> 'sort')::int, 0))
  on conflict (id) do update set
    name = excluded.name, spot = excluded.spot, lat = excluded.lat, lng = excluded.lng, radius_m = excluded.radius_m,
    access_note = excluded.access_note, entrance_note = excluded.entrance_note,
    needs_onsite_check = excluded.needs_onsite_check, source_note = excluded.source_note, sort = excluded.sort;
  for e in
    select ed.id, v.doc from public.hunt_editions ed
    join public.hunt_edition_versions v on v.edition_id = ed.id and v.version = ed.current_version
    where exists (select 1 from jsonb_array_elements(v.doc -> 'puzzles') x where x ->> 'checkpoint' = cid)
    order by ed.id
  loop
    bumped := bumped || jsonb_build_object('id', e.id, 'version', public.hunt_publish_internal(e.id, e.doc));
  end loop;
  return jsonb_build_object('status', 'ok', 'republished', bumped);
end $$;

-- Publish a route document as the next version (creates the route, paused, if it is new).
create function public.hunt_admin_publish(p_edition text, p_doc jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v int;
begin
  perform public.hunt_require_admin();
  insert into public.hunt_editions (id, status, sort)
  values (p_edition, 'paused', (select coalesce(max(sort), 0) + 1 from public.hunt_editions))
  on conflict (id) do nothing;
  v := public.hunt_publish_internal(p_edition, p_doc);
  perform public.hunt_seed_metrics(p_edition);
  return jsonb_build_object('status', 'ok', 'version', v);
end $$;

-- Paused routes aren't offered for new runs. Runs already under way may finish.
create function public.hunt_admin_set_status(p_edition text, p_status text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform public.hunt_require_admin();
  if p_status not in ('active', 'paused') then raise exception 'Status must be active or paused'; end if;
  update public.hunt_editions set status = p_status where id = p_edition and (p_status = 'paused' or current_version > 0);
  if not found then raise exception 'Unknown route, or nothing published yet'; end if;
  return jsonb_build_object('status', 'ok');
end $$;

------------------------------------------------------------------------------
-- 10. Account deletion also removes every hunt record and reward token
------------------------------------------------------------------------------
-- Removes one player from the hunt entirely, then fixes up the teams they were on:
-- an emptied team is deleted, any other is re-scored without them.
create function public.hunt_forget_user(p_user uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare tid uuid;
begin
  delete from public.hunt_reward_tokens where user_id = p_user;
  for tid in select team_id from public.hunt_members where user_id = p_user order by team_id loop
    perform 1 from public.hunt_teams where id = tid for update;
    delete from public.hunt_checkins where team_id = tid and user_id = p_user;
    delete from public.hunt_members  where team_id = tid and user_id = p_user;
    if exists (select 1 from public.hunt_members where team_id = tid) then
      perform public.hunt_recompute(tid);
    else
      delete from public.hunt_teams where id = tid;
    end if;
  end loop;
  delete from public.hunt_checkins where user_id = p_user;
end $$;

create or replace function public.delete_my_account()
returns void language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'Sign in first'; end if;
  delete from public.path_names where named_by = uid;
  update public.moderation_audit set detail = '{}'::jsonb, target_user_id = null where target_user_id = uid;
  perform public.hunt_forget_user(uid);
  delete from auth.users where id = uid;
end $$;

------------------------------------------------------------------------------
-- 11. Grants
------------------------------------------------------------------------------
do $$
declare f text;
begin
  -- internal helpers: nobody calls these through the API
  foreach f in array array[
    'public.hunt_verified_email()', 'public.hunt_cu_verified()', 'public.hunt_require_admin()',
    'public.hunt_norm_answer(text)', 'public.hunt_hash_answer(text, text)', 'public.hunt_answer_ok(text, int, int, text)',
    'public.hunt_build_content(text, int, jsonb)', 'public.hunt_publish_internal(text, jsonb)', 'public.hunt_seed_metrics(text)',
    'public.hunt_member_points(uuid, uuid)', 'public.hunt_recompute(uuid)', 'public.hunt_counts(uuid, text)',
    'public.hunt_team_name_problem(text)', 'public.hunt_team_summary(uuid, uuid)', 'public.hunt_forget_user(uuid)'
  ] loop
    execute 'revoke execute on function ' || f || ' from public, anon, authenticated';
  end loop;
  -- anyone, signed in or not (read-only, plus the anonymous counter)
  foreach f in array array[
    'public.hunt_get_editions()', 'public.hunt_get_edition_version(text, int)', 'public.hunt_check_answer(text, int, int, text)',
    'public.increment_hunt_metric(text, text)', 'public.hunt_standings(text, date)'
  ] loop
    execute 'revoke execute on function ' || f || ' from public';
    execute 'grant execute on function ' || f || ' to anon, authenticated';
  end loop;
  -- signed-in players; administrator functions also check admin_allowlist themselves
  foreach f in array array[
    'public.hunt_whoami()', 'public.hunt_am_i_admin()', 'public.hunt_create_team(text, text, text)', 'public.hunt_join_team(uuid)',
    'public.hunt_leave_team(uuid)', 'public.hunt_use_hint(uuid, int)', 'public.hunt_check_in(uuid, int, boolean, text)',
    'public.hunt_my_run(text)', 'public.hunt_my_wallet()', 'public.hunt_use_token(text)',
    'public.hunt_admin_overview()', 'public.hunt_admin_save_checkpoint(jsonb)', 'public.hunt_admin_publish(text, jsonb)',
    'public.hunt_admin_set_status(text, text)'
  ] loop
    execute 'revoke execute on function ' || f || ' from public, anon';
    execute 'grant execute on function ' || f || ' to authenticated';
  end loop;
end $$;
revoke execute on function public.delete_my_account() from public, anon;
grant  execute on function public.delete_my_account() to authenticated;
