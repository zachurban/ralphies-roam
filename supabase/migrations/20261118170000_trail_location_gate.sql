-- Keep the clue and the note in separate encrypted payloads. Store the chosen
-- hiding pin for the check, but never write a recipient's GPS fix to a table.
alter table public.trail_notes
  add column clue_sealed text,
  add column hide_lat double precision,
  add column hide_lng double precision;

-- The old create RPC had no hiding coordinates and would produce an unusable link.
drop function public.trail_create(uuid, uuid, text);

create function public.trail_create(trail_id uuid, delete_key uuid, sealed text,
                                     clue text, lat double precision, lng double precision)
returns text language plpgsql security definer set search_path = '' as $$
declare
  key_hash bytea;
  existing public.trail_notes%rowtype;
begin
  if trail_id is null or delete_key is null or sealed is null or clue is null
     or lat is null or lng is null
     or not (lat between 39.993 and 40.016 and lng between -105.287 and -105.238)
     or octet_length(sealed) > 12000 or octet_length(clue) > 4000
     or sealed !~ '^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{23,}$'
     or clue !~ '^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{23,}$' then
    return 'invalid';
  end if;
  key_hash := sha256(uuid_send(delete_key));
  if not pg_try_advisory_xact_lock(17281122, 1) then
    return 'busy';
  end if;

  delete from public.trail_notes where created_at <= now() - interval '365 days';

  select * into existing from public.trail_notes as n where n.id = trail_id;
  if found then
    if existing.delete_hash = key_hash and existing.sealed = trail_create.sealed
       and existing.clue_sealed = clue and existing.hide_lat = lat and existing.hide_lng = lng then
      return 'ok';
    end if;
    return 'invalid';
  end if;

  if (select count(*) from public.trail_notes where created_at > now() - interval '1 minute') >= 30
     or (select count(*) from public.trail_notes where created_at > now() - interval '1 day') >= 300 then
    return 'busy';
  end if;

  insert into public.trail_notes (id, delete_hash, sealed, clue_sealed, hide_lat, hide_lng)
    values (trail_id, key_hash, trail_create.sealed, clue, lat, lng);
  return 'ok';
end;
$$;

create or replace function public.trail_get(trail_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select case when n.clue_sealed is null then jsonb_build_object('status', 'legacy')
         else jsonb_build_object('clue', n.clue_sealed, 'created_at', n.created_at) end
    from public.trail_notes as n
   where n.id = trail_id and n.created_at > now() - interval '365 days';
$$;

create function public.trail_unlock(trail_id uuid, lat double precision, lng double precision,
                                     accuracy_m double precision)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  note public.trail_notes%rowtype;
  a double precision;
begin
  if lat is null or lng is null or accuracy_m is null
     or not (lat between -90 and 90 and lng between -180 and 180 and accuracy_m between 0 and 35) then
    return jsonb_build_object('status', 'inaccurate');
  end if;

  select * into note from public.trail_notes
    where id = trail_id and created_at > now() - interval '365 days' and clue_sealed is not null;
  if not found then
    return jsonb_build_object('status', 'unavailable');
  end if;

  a := sin(radians(note.hide_lat - lat) / 2)^2
       + cos(radians(lat)) * cos(radians(note.hide_lat)) * sin(radians(note.hide_lng - lng) / 2)^2;
  if 2 * 6371008.8 * asin(sqrt(least(1.0, a))) > 40 then
    return jsonb_build_object('status', 'outside');
  end if;
  return jsonb_build_object('status', 'ok', 'sealed', note.sealed);
end;
$$;

revoke all on function public.trail_create(uuid, uuid, text, text, double precision, double precision)
  from public, anon, authenticated;
revoke all on function public.trail_unlock(uuid, double precision, double precision, double precision)
  from public, anon, authenticated;
grant execute on function public.trail_create(uuid, uuid, text, text, double precision, double precision)
  to anon, authenticated;
grant execute on function public.trail_unlock(uuid, double precision, double precision, double precision)
  to anon, authenticated;
