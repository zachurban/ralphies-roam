-- Ralphie's Roam — student-named paths
-- A signed-in student who has walked (claimed) any part of an unnamed path can
-- name it. The first name sticks: only its author can change or remove it.
-- Names are public to everyone, including signed-out visitors. The profanity
-- and spam filter runs here in the database, so it can't be bypassed.

------------------------------------------------------------------------------
-- Name filter: returns NULL when the name is OK, otherwise a short reason
------------------------------------------------------------------------------
create function public.rr_name_problem(p text)
returns text language plpgsql immutable set search_path = '' as $$
declare
  n text; sq text; col text; tok text; r text;
  -- blocked anywhere, even inside other words or with spaces/leetspeak removed
  roots text[] := array['fuck','shit','cunt','nigg','fagg','bitch','whore','slut','porn','retard','kike',
                        'hitler','twat','wank','jizz','dildo','penis','vagina','pussy','rapist','motherf',
                        'cocksuck','dickhead','asshole','titties','nazi','blowjob','handjob','clit'];
  -- also caught with stretched letters ("fuuuck")
  stretch text[] := array['fuck','shit','cunt','bitch','whore','slut','porn','twat','wank','dildo','penis',
                          'vagina','rapist','retard','kike','hitler','clit'];
  -- blocked only as whole words (so "Cockerell", "Sussex", "Dickinson" are fine)
  words text[] := array['ass','arse','asses','cock','cocks','dick','dicks','tit','tits','boob','boobs','piss',
                        'sex','sexy','fag','fags','rape','raped','heil','kkk','spic','chink','dyke','hoe','hoes',
                        'coon','gook','wop','tranny','balls','nut','nuts','crap'];
begin
  if p is null or char_length(btrim(p)) < 3 or char_length(btrim(p)) > 30 then
    return 'Names must be 3–30 characters';
  end if;
  if p !~ '^[A-Za-z0-9 ''’&.,!?()#-]+$' then
    return 'Use letters, numbers, spaces and basic punctuation';
  end if;
  if lower(p) ~ '(https?|www\.|\.(com|net|org|io|gg|edu|ly)\M)' then
    return 'No links, please';
  end if;
  if p ~ '[0-9]{6,}' then
    return 'No phone numbers or long codes';
  end if;
  n   := translate(lower(p), '013457!8', 'oieastib');
  sq  := regexp_replace(n, '[^a-z]', '', 'g');
  col := regexp_replace(sq, '(.)\1+', '\1', 'g');
  foreach r in array roots loop
    if position(r in sq) > 0 then return 'Please keep names clean'; end if;
  end loop;
  foreach r in array stretch loop
    if position(r in col) > 0 then return 'Please keep names clean'; end if;
  end loop;
  foreach tok in array regexp_split_to_array(btrim(regexp_replace(n, '[^a-z]+', ' ', 'g')), ' ') loop
    if tok = any(words) or regexp_replace(tok, '(.)\1+', '\1', 'g') = any(words) then
      return 'Please keep names clean';
    end if;
  end loop;
  return null;
end $$;

------------------------------------------------------------------------------
-- Names
------------------------------------------------------------------------------
create table public.path_names (
  path_id    text primary key check (path_id ~ '^w[0-9]{1,15}$'),
  name       text not null check (public.rr_name_problem(name) is null),
  named_by   uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index path_names_by_idx on public.path_names (named_by, updated_at);
alter table public.path_names enable row level security;  -- no policies: read and write through the functions below

-- Name (or rename / clear with '') a path the caller has walked
create function public.set_path_name(p_path text, p_name text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  clean text := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
  owner uuid; existed boolean; problem text; recent int;
begin
  if uid is null then raise exception 'Sign in to name paths'; end if;
  if p_path is null or p_path !~ '^w[0-9]{1,15}$' then raise exception 'This path can''t be named'; end if;
  select named_by into owner from public.path_names where path_id = p_path;
  existed := found;
  if existed and owner is distinct from uid then
    raise exception 'Someone already named this path';
  end if;
  if clean = '' then
    delete from public.path_names where path_id = p_path and named_by = uid;
    return;
  end if;
  problem := public.rr_name_problem(clean);
  if problem is not null then raise exception '%', problem; end if;
  if not exists (select 1 from public.claims where user_id = uid and segment_id like p_path || '.%') then
    raise exception 'Walk this path first to earn naming rights';
  end if;
  select count(*) into recent from public.path_names where named_by = uid and updated_at > now() - interval '1 day';
  if recent >= 10 and not existed then raise exception 'Daily limit: 10 path names per day'; end if;
  insert into public.path_names (path_id, name, named_by) values (p_path, clean, uid)
  on conflict (path_id) do update set name = excluded.name, updated_at = now();
end $$;

-- Everyone (signed in or not) can read names; namers are shown by leaderboard name only
create function public.get_path_names()
returns table (path_id text, name text, named_by_name text, is_mine boolean)
language sql stable security definer set search_path = '' as $$
  select n.path_id, n.name,
         coalesce(p.display_name, 'a Buff'),
         coalesce(n.named_by = auth.uid(), false)
  from public.path_names n
  left join public.profiles p on p.id = n.named_by
  order by n.path_id
  limit 20000;
$$;

-- Lets the app check a name before saving (same rules as the database)
create function public.check_path_name(p_name text)
returns text language sql stable set search_path = '' as $$
  select public.rr_name_problem(btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')));
$$;

revoke execute on function public.set_path_name(text, text) from public, anon;
revoke execute on function public.get_path_names()          from public;
revoke execute on function public.check_path_name(text)     from public;
grant  execute on function public.set_path_name(text, text) to authenticated;
grant  execute on function public.get_path_names()          to anon, authenticated;
grant  execute on function public.check_path_name(text)     to anon, authenticated;
