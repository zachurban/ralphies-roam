-- Ralphie's Roam — hazard follow-up: reporters can delete their own reports;
-- other signed-in students can vote "Still there" or "Fixed".
-- A hazard resolves itself when, over the last 14 days, at least 2 students
-- said Fixed and Fixed votes outnumber Still-there votes.
-- A "Still there" vote keeps the pin visible for 60 days from that confirmation.

alter table public.hazard_reports add column last_confirmed_at timestamptz;

create table public.hazard_votes (
  hazard_id  bigint not null references public.hazard_reports (id) on delete cascade,
  user_id    uuid   not null references auth.users (id) on delete cascade,
  vote       text   not null check (vote in ('there', 'fixed')),
  updated_at timestamptz not null default now(),
  primary key (hazard_id, user_id)
);
create index hazard_votes_recent_idx on public.hazard_votes (hazard_id, updated_at);
alter table public.hazard_votes enable row level security;  -- no policies: functions only

-- Reporter deletes their own report
create function public.delete_hazard(p_id bigint)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  delete from public.hazard_reports where id = p_id and user_id = auth.uid();
  if not found then raise exception 'You can only delete your own reports'; end if;
end $$;

-- Vote on someone else's open report. Returns the report's status afterwards.
create function public.vote_hazard(p_id bigint, p_vote text)
returns text language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); h record; n_fixed int; n_there int;
begin
  if uid is null then raise exception 'Sign in to vote'; end if;
  if p_vote not in ('there', 'fixed') then raise exception 'Unknown vote'; end if;
  select * into h from public.hazard_reports where id = p_id;
  if not found or h.status <> 'open' then raise exception 'This report is no longer open'; end if;
  if h.user_id = uid then raise exception 'Delete your own report instead of voting on it'; end if;

  insert into public.hazard_votes (hazard_id, user_id, vote, updated_at) values (p_id, uid, p_vote, now())
  on conflict (hazard_id, user_id) do update set vote = excluded.vote, updated_at = now();

  if p_vote = 'there' then
    update public.hazard_reports set last_confirmed_at = now() where id = p_id;
  end if;

  select count(*) filter (where vote = 'fixed'), count(*) filter (where vote = 'there')
    into n_fixed, n_there
  from public.hazard_votes where hazard_id = p_id and updated_at > now() - interval '14 days';

  if n_fixed >= 2 and n_fixed > n_there then
    update public.hazard_reports set status = 'resolved', resolved_at = now() where id = p_id;
    return 'resolved';
  end if;
  return 'open';
end $$;

-- Open hazards with vote counts; no reporter or voter identities
drop function public.get_open_hazards();
create function public.get_open_hazards()
returns table (id bigint, lat double precision, lng double precision, category text, note text,
               created_at timestamptz, last_confirmed_at timestamptz,
               still_there int, fixed int, my_vote text, is_mine boolean)
language sql stable security definer set search_path = '' as $$
  select h.id, h.lat, h.lng, h.category, h.note, h.created_at, h.last_confirmed_at,
         (select count(*)::int from public.hazard_votes v where v.hazard_id = h.id and v.vote = 'there' and v.updated_at > now() - interval '14 days'),
         (select count(*)::int from public.hazard_votes v where v.hazard_id = h.id and v.vote = 'fixed' and v.updated_at > now() - interval '14 days'),
         (select v.vote from public.hazard_votes v where v.hazard_id = h.id and v.user_id = auth.uid()),
         h.user_id = auth.uid()
  from public.hazard_reports h
  where h.status = 'open'
    and greatest(h.created_at, coalesce(h.last_confirmed_at, h.created_at)) > now() - interval '60 days'
  order by h.created_at desc
  limit 300;
$$;

revoke execute on function public.delete_hazard(bigint)    from public, anon;
revoke execute on function public.vote_hazard(bigint, text) from public, anon;
revoke execute on function public.get_open_hazards()        from public, anon;
grant  execute on function public.delete_hazard(bigint)    to authenticated;
grant  execute on function public.vote_hazard(bigint, text) to authenticated;
grant  execute on function public.get_open_hazards()        to authenticated;
