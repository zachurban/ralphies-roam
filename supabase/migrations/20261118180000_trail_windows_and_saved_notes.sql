alter table public.trail_notes
  add column opens_at timestamptz,
  add column expires_at timestamptz,
  add constraint trail_window_order check (opens_at is null or (expires_at is not null and opens_at < expires_at));

-- Leave the original create RPC in place for cached clients. The same lock
-- makes a timed create atomic and keeps an identical retry idempotent.
create function public.trail_create_timed(trail_id uuid, delete_key uuid, sealed text,
    clue text, lat double precision, lng double precision, opens_at timestamptz, expires_at timestamptz)
returns text language plpgsql security definer set search_path = '' as $$
declare
  existing public.trail_notes%rowtype;
  result text;
begin
  if not pg_try_advisory_xact_lock(17281122, 1) then
    return 'busy';
  end if;

  select * into existing from public.trail_notes where id = trail_id;
  if found then
    if existing.opens_at is distinct from trail_create_timed.opens_at
       or existing.expires_at is distinct from trail_create_timed.expires_at then
      return 'invalid_window';
    end if;
    return public.trail_create(trail_id, delete_key, sealed, clue, lat, lng);
  end if;

  if (expires_at is not null and (expires_at <= now() or expires_at > now() + interval '365 days'))
     or (opens_at is not null and (not isfinite(opens_at) or expires_at is null or opens_at >= expires_at)) then
    return 'invalid_window';
  end if;

  result := public.trail_create(trail_id, delete_key, sealed, clue, lat, lng);
  if result = 'ok' then
    update public.trail_notes
       set opens_at = trail_create_timed.opens_at, expires_at = trail_create_timed.expires_at
     where id = trail_id;
  end if;
  return result;
end;
$$;

create function public.trail_window_status(opens_at timestamptz, expires_at timestamptz)
returns text language sql stable set search_path = '' as $$
  select case
    when now() < opens_at then 'scheduled'
    when now() >= expires_at then 'expired'
    else 'open'
  end;
$$;

create or replace function public.trail_get(trail_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select case when n.clue_sealed is null then jsonb_build_object('status', 'legacy')
         else jsonb_strip_nulls(jsonb_build_object(
           'status', nullif(w.status, 'open'),
           'clue', case when w.status = 'open' then n.clue_sealed end,
           'created_at', case when w.status = 'open' then n.created_at end,
           'opens_at', n.opens_at, 'expires_at', n.expires_at
         )) end
    from public.trail_notes as n
    cross join lateral (select public.trail_window_status(n.opens_at, n.expires_at) as status) as w
   where n.id = trail_id and n.created_at > now() - interval '365 days';
$$;

create or replace function public.trail_unlock(trail_id uuid, lat double precision, lng double precision,
                                     accuracy_m double precision)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  note public.trail_notes%rowtype;
  window_status text;
  a double precision;
begin
  select * into note from public.trail_notes
    where id = trail_id and created_at > now() - interval '365 days' and clue_sealed is not null;
  if not found then
    return jsonb_build_object('status', 'unavailable');
  end if;

  window_status := public.trail_window_status(note.opens_at, note.expires_at);
  if window_status <> 'open' then
    return jsonb_build_object('status', window_status, 'opens_at', note.opens_at, 'expires_at', note.expires_at);
  end if;

  if lat is null or lng is null or accuracy_m is null
     or not (lat between -90 and 90 and lng between -180 and 180 and accuracy_m between 0 and 35) then
    return jsonb_build_object('status', 'inaccurate');
  end if;

  a := sin(radians(note.hide_lat - lat) / 2)^2
       + cos(radians(lat)) * cos(radians(note.hide_lat)) * sin(radians(note.hide_lng - lng) / 2)^2;
  if 2 * 6371008.8 * asin(sqrt(least(1.0, a))) > 40 then
    return jsonb_build_object('status', 'outside');
  end if;
  return jsonb_build_object('status', 'ok', 'sealed', note.sealed);
end;
$$;

revoke all on function public.trail_window_status(timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.trail_create_timed(uuid, uuid, text, text, double precision, double precision, timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.trail_create_timed(uuid, uuid, text, text, double precision, double precision, timestamptz, timestamptz)
  to anon, authenticated;

-- A recipient deliberately saves a personal copy. Its lifecycle is independent
-- of the clue, and deleting the owner's account cascades to these copies.
create table public.trail_saved_notes (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  trail_id uuid not null,
  note text not null check (char_length(note) between 1 and 1500),
  sender text not null check (char_length(sender) between 1 and 48),
  hidden_at timestamptz not null,
  saved_at timestamptz not null default now(),
  primary key (user_id, trail_id)
);
alter table public.trail_saved_notes enable row level security;
revoke all on public.trail_saved_notes from public, anon, authenticated;
grant select, insert, delete on public.trail_saved_notes to authenticated;
create policy trail_saved_read on public.trail_saved_notes for select to authenticated using (auth.uid() = user_id);
create policy trail_saved_add on public.trail_saved_notes for insert to authenticated with check (auth.uid() = user_id);
create policy trail_saved_remove on public.trail_saved_notes for delete to authenticated using (auth.uid() = user_id);
