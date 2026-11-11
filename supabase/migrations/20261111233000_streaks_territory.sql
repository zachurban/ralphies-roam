-- Ralphie's Roam — streaks, weekly dorm territory, weekly leaderboard
-- Weekly activity is stored per user, per zone, per week as a count of distinct
-- path segments walked — never which segments or when.

------------------------------------------------------------------------------
-- Week helper: weeks start Monday, Boulder time
------------------------------------------------------------------------------
create function public.rr_week(ts timestamptz default now())
returns date language sql stable set search_path = '' as $$
  select date_trunc('week', ts at time zone 'America/Denver')::date;
$$;
create function public.rr_today()
returns date language sql stable set search_path = '' as $$
  select (now() at time zone 'America/Denver')::date;
$$;

------------------------------------------------------------------------------
-- Streaks live on user_stats
------------------------------------------------------------------------------
alter table public.user_stats
  add column streak      int  not null default 0 check (streak between 0 and 3650),
  add column best_streak int  not null default 0 check (best_streak between 0 and 3650),
  add column streak_last date;

create function public.set_streak(p_streak int, p_best int, p_last date)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  if p_last is null or p_last > public.rr_today() + 1 or p_last < public.rr_today() - 3 then
    raise exception 'Invalid streak date';
  end if;
  insert into public.user_stats (user_id, streak, best_streak, streak_last, updated_at)
  values (auth.uid(), least(greatest(p_streak, 0), 3650), least(greatest(p_best, p_streak, 0), 3650), p_last, now())
  on conflict (user_id) do update set
    streak      = case when excluded.streak_last >= coalesce(public.user_stats.streak_last, excluded.streak_last)
                       then excluded.streak else public.user_stats.streak end,
    streak_last = greatest(coalesce(public.user_stats.streak_last, excluded.streak_last), excluded.streak_last),
    best_streak = greatest(public.user_stats.best_streak, excluded.best_streak),
    updated_at  = now();
end $$;

------------------------------------------------------------------------------
-- Weekly zone points (distinct segments walked per zone this week)
------------------------------------------------------------------------------
create table public.weekly_zone_points (
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  week       date not null,
  zone       text not null check (zone ~ '^[a-z]{2,24}$'),
  segments   int  not null default 0 check (segments between 0 and 100000),
  updated_at timestamptz not null default now(),
  primary key (user_id, week, zone)
);
create index weekly_zone_points_week_idx on public.weekly_zone_points (week, zone);
alter table public.weekly_zone_points enable row level security;
create policy "own weekly: read"   on public.weekly_zone_points for select to authenticated using ((select auth.uid()) = user_id);
create policy "own weekly: insert" on public.weekly_zone_points for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "own weekly: update" on public.weekly_zone_points for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own weekly: delete" on public.weekly_zone_points for delete to authenticated using ((select auth.uid()) = user_id);

-- p_points: {"norlin": 12, "farrand": 3, ...}. Counts only ever go up within a week.
create function public.set_week_points(p_week date, p_points jsonb)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  if p_week not in (public.rr_week(), public.rr_week() - 7) then
    raise exception 'Only this week or last week can be updated';
  end if;
  if jsonb_typeof(p_points) <> 'object' then raise exception 'p_points must be an object'; end if;
  insert into public.weekly_zone_points (user_id, week, zone, segments, updated_at)
  select auth.uid(), p_week, k, least(greatest(v::int, 0), 100000), now()
  from jsonb_each_text(p_points) as e(k, v)
  where k ~ '^[a-z]{2,24}$' and v ~ '^[0-9]{1,6}$'
  on conflict (user_id, week, zone) do update
    set segments = greatest(public.weekly_zone_points.segments, excluded.segments), updated_at = now();
end $$;

------------------------------------------------------------------------------
-- Leaderboards (names, dorms and totals only)
------------------------------------------------------------------------------
drop function public.get_leaderboard(int);
create function public.get_leaderboard(lim int default 25)
returns table (rank bigint, name text, dorm text, segments bigint, miles numeric, streak int, is_me boolean)
language sql stable security definer set search_path = '' as $$
  select rank() over (order by count(c.segment_id) desc, coalesce(s.meters, 0) desc),
         coalesce(p.display_name, 'Buff ' || upper(left(p.id::text, 4))),
         p.dorm,
         count(c.segment_id),
         round((coalesce(s.meters, 0) / 1609.344)::numeric, 2),
         case when s.streak_last >= public.rr_today() - 1 then s.streak else 0 end,
         p.id = auth.uid()
  from public.profiles p
  left join public.claims c on c.user_id = p.id
  left join public.user_stats s on s.user_id = p.id
  group by p.id, p.display_name, p.dorm, s.meters, s.streak, s.streak_last
  having count(c.segment_id) > 0
  order by 1, 2
  limit least(greatest(lim, 1), 100);
$$;

create function public.get_weekly_leaderboard(lim int default 25)
returns table (rank bigint, name text, dorm text, segments bigint, streak int, is_me boolean)
language sql stable security definer set search_path = '' as $$
  select rank() over (order by sum(w.segments) desc),
         coalesce(p.display_name, 'Buff ' || upper(left(p.id::text, 4))),
         p.dorm,
         sum(w.segments)::bigint,
         coalesce(case when s.streak_last >= public.rr_today() - 1 then s.streak else 0 end, 0),
         p.id = auth.uid()
  from public.weekly_zone_points w
  join public.profiles p on p.id = w.user_id
  left join public.user_stats s on s.user_id = p.id
  where w.week = public.rr_week()
  group by p.id, p.display_name, p.dorm, s.streak, s.streak_last
  having sum(w.segments) > 0
  order by 1, 2
  limit least(greatest(lim, 1), 100);
$$;

-- Territory: per zone, each dorm's points this week, ranked
create function public.get_territory()
returns table (zone text, dorm text, points bigint, rank bigint, is_my_dorm boolean)
language sql stable security definer set search_path = '' as $$
  with mine as (select dorm from public.profiles where id = auth.uid()),
  pts as (
    select w.zone, p.dorm, sum(w.segments)::bigint as points
    from public.weekly_zone_points w
    join public.profiles p on p.id = w.user_id
    where w.week = public.rr_week() and p.dorm is not null
    group by w.zone, p.dorm
    having sum(w.segments) > 0
  )
  select pts.zone, pts.dorm, pts.points,
         rank() over (partition by pts.zone order by pts.points desc),
         pts.dorm = (select dorm from mine)
  from pts
  order by 1, 4, 2
  limit 1000;
$$;

revoke execute on function public.set_streak(int, int, date)        from public, anon;
revoke execute on function public.set_week_points(date, jsonb)      from public, anon;
revoke execute on function public.get_leaderboard(int)              from public, anon;
revoke execute on function public.get_weekly_leaderboard(int)       from public, anon;
revoke execute on function public.get_territory()                   from public, anon;
grant  execute on function public.set_streak(int, int, date)        to authenticated;
grant  execute on function public.set_week_points(date, jsonb)      to authenticated;
grant  execute on function public.get_leaderboard(int)              to authenticated;
grant  execute on function public.get_weekly_leaderboard(int)       to authenticated;
grant  execute on function public.get_territory()                   to authenticated;
