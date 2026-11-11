-- Ralphie's Roam — initial backend schema
-- Privacy rule: raw GPS tracks never leave the phone. The server only learns
-- which path segments a student claimed, their distance total, badges, and
-- hazard reports they choose to file (pinned inside campus bounds only).

------------------------------------------------------------------------------
-- Settings
------------------------------------------------------------------------------
create table public.app_settings (
  key   text primary key,
  value text not null
);
-- '' = anyone can sign up (testing). Set to 'colorado.edu' to restrict:
--   update public.app_settings set value = 'colorado.edu' where key = 'allowed_email_domain';
insert into public.app_settings (key, value) values ('allowed_email_domain', '');
alter table public.app_settings enable row level security;  -- no policies: server-only

------------------------------------------------------------------------------
-- Tables
------------------------------------------------------------------------------
create table public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text check (char_length(display_name) between 1 and 30),
  dorm         text check (char_length(dorm) between 1 and 40),
  created_at   timestamptz not null default now()
);

create table public.claims (
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  segment_id text not null check (char_length(segment_id) <= 64),
  claimed_at timestamptz not null default now(),
  primary key (user_id, segment_id)
);

create table public.user_badges (
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  badge_id    text not null check (char_length(badge_id) <= 40),
  unlocked_at timestamptz not null default now(),
  primary key (user_id, badge_id)
);

create table public.user_stats (
  user_id    uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  meters     double precision not null default 0 check (meters >= 0 and meters < 10000000),
  updated_at timestamptz not null default now()
);

create table public.hazard_reports (
  id          bigint generated always as identity primary key,
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  lat         double precision not null check (lat between 39.990 and 40.025),
  lng         double precision not null check (lng between -105.290 and -105.235),
  category    text not null check (category in ('dark', 'lighting', 'ice', 'trip', 'other')),
  note        text check (char_length(note) <= 280),
  status      text not null default 'open' check (status in ('open', 'resolved')),
  created_at  timestamptz not null default now(),
  resolved_at timestamptz
);
create index hazard_reports_open_idx on public.hazard_reports (created_at desc) where status = 'open';

------------------------------------------------------------------------------
-- Row-level security: each student reads and writes only their own rows
------------------------------------------------------------------------------
alter table public.profiles       enable row level security;
alter table public.claims         enable row level security;
alter table public.user_badges    enable row level security;
alter table public.user_stats     enable row level security;
alter table public.hazard_reports enable row level security;

create policy "own profile: read"   on public.profiles for select to authenticated using ((select auth.uid()) = id);
create policy "own profile: insert" on public.profiles for insert to authenticated with check ((select auth.uid()) = id);
create policy "own profile: update" on public.profiles for update to authenticated using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

create policy "own claims: read"   on public.claims for select to authenticated using ((select auth.uid()) = user_id);
create policy "own claims: insert" on public.claims for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "own claims: delete" on public.claims for delete to authenticated using ((select auth.uid()) = user_id);

create policy "own badges: read"   on public.user_badges for select to authenticated using ((select auth.uid()) = user_id);
create policy "own badges: insert" on public.user_badges for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "own badges: delete" on public.user_badges for delete to authenticated using ((select auth.uid()) = user_id);

create policy "own stats: read"   on public.user_stats for select to authenticated using ((select auth.uid()) = user_id);
create policy "own stats: insert" on public.user_stats for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "own stats: update" on public.user_stats for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own stats: delete" on public.user_stats for delete to authenticated using ((select auth.uid()) = user_id);

create policy "own hazards: read"   on public.hazard_reports for select to authenticated using ((select auth.uid()) = user_id);
create policy "own hazards: insert" on public.hazard_reports for insert to authenticated
  with check ((select auth.uid()) = user_id and status = 'open' and resolved_at is null);

------------------------------------------------------------------------------
-- Sign-up: optional email-domain gate, then create an empty profile
------------------------------------------------------------------------------
create function public.enforce_email_domain()
returns trigger language plpgsql security definer set search_path = '' as $$
declare d text;
begin
  select value into d from public.app_settings where key = 'allowed_email_domain';
  if coalesce(d, '') <> '' and lower(coalesce(new.email, '')) not like '%@' || lower(d) then
    raise exception 'Sign-ups are limited to @% addresses', d;
  end if;
  return new;
end $$;

create function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id) values (new.id) on conflict (id) do nothing;
  return new;
end $$;

create trigger rr_enforce_email_domain before insert on auth.users
  for each row execute function public.enforce_email_domain();
create trigger rr_on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

------------------------------------------------------------------------------
-- RPCs
------------------------------------------------------------------------------
-- Distance only ever goes up through sync (a reset deletes the row instead)
create function public.set_meters(p_meters double precision)
returns void language sql security invoker set search_path = '' as $$
  insert into public.user_stats (user_id, meters, updated_at)
  values (auth.uid(), greatest(p_meters, 0), now())
  on conflict (user_id) do update
    set meters = greatest(public.user_stats.meters, excluded.meters), updated_at = now();
$$;

-- Leaderboards expose names and totals only — never emails or locations
create function public.get_leaderboard(lim int default 25)
returns table (rank bigint, name text, dorm text, segments bigint, miles numeric, is_me boolean)
language sql stable security definer set search_path = '' as $$
  select rank() over (order by count(c.segment_id) desc, coalesce(s.meters, 0) desc),
         coalesce(p.display_name, 'Buff ' || upper(left(p.id::text, 4))),
         p.dorm,
         count(c.segment_id),
         round((coalesce(s.meters, 0) / 1609.344)::numeric, 2),
         p.id = auth.uid()
  from public.profiles p
  left join public.claims c on c.user_id = p.id
  left join public.user_stats s on s.user_id = p.id
  group by p.id, p.display_name, p.dorm, s.meters
  having count(c.segment_id) > 0
  order by 1, 2
  limit least(greatest(lim, 1), 100);
$$;

create function public.get_dorm_leaderboard()
returns table (rank bigint, dorm text, members bigint, segments bigint, miles numeric)
language sql stable security definer set search_path = '' as $$
  with per_user as (
    select p.id, p.dorm, count(c.segment_id) as segs, coalesce(max(s.meters), 0) as meters
    from public.profiles p
    left join public.claims c on c.user_id = p.id
    left join public.user_stats s on s.user_id = p.id
    where p.dorm is not null
    group by p.id, p.dorm
  )
  select rank() over (order by sum(segs) desc), dorm, count(*), sum(segs)::bigint,
         round((sum(meters) / 1609.344)::numeric, 2)
  from per_user
  group by dorm
  having sum(segs) > 0
  order by 1, 2
  limit 50;
$$;

-- Open hazards for the map: no reporter identity
create function public.get_open_hazards()
returns table (id bigint, lat double precision, lng double precision, category text, note text, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select h.id, h.lat, h.lng, h.category, h.note, h.created_at
  from public.hazard_reports h
  where h.status = 'open' and h.created_at > now() - interval '60 days'
  order by h.created_at desc
  limit 300;
$$;

revoke execute on function public.set_meters(double precision) from public, anon;
revoke execute on function public.get_leaderboard(int)          from public, anon;
revoke execute on function public.get_dorm_leaderboard()        from public, anon;
revoke execute on function public.get_open_hazards()            from public, anon;
revoke execute on function public.enforce_email_domain()        from public, anon, authenticated;
revoke execute on function public.handle_new_user()             from public, anon, authenticated;
grant  execute on function public.set_meters(double precision) to authenticated;
grant  execute on function public.get_leaderboard(int)          to authenticated;
grant  execute on function public.get_dorm_leaderboard()        to authenticated;
grant  execute on function public.get_open_hazards()            to authenticated;
