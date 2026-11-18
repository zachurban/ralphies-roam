-- Private notes are encrypted before upload. The link's encryption key and GPS
-- fixes never reach Supabase. A separate capability revokes the note.
create table public.trail_notes (
  id uuid primary key,
  delete_hash bytea not null,
  sealed text not null,
  created_at timestamptz not null default now()
);
create index trail_notes_created_at_idx on public.trail_notes (created_at);
alter table public.trail_notes enable row level security;
revoke all on table public.trail_notes from public, anon, authenticated;

create function public.trail_create(trail_id uuid, delete_key uuid, sealed text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  key_hash bytea;
  existing public.trail_notes%rowtype;
begin
  if trail_id is null or delete_key is null or sealed is null
     or octet_length(sealed) > 12000
     or sealed !~ '^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{23,}$' then
    return 'invalid';
  end if;
  key_hash := sha256(uuid_send(delete_key));
  -- Serialize anonymous writes without queueing behind another request. Bound
  -- guest storage while keeping reads and deletes independent of this limit.
  if not pg_try_advisory_xact_lock(17281122, 1) then
    return 'busy';
  end if;

  delete from public.trail_notes where created_at <= now() - interval '365 days';

  select * into existing from public.trail_notes as n where n.id = trail_id;
  if found then
    if existing.delete_hash = key_hash and existing.sealed = trail_create.sealed then
      return 'ok'; -- Same submission after a dropped response.
    end if;
    return 'invalid';
  end if;

  if (select count(*) from public.trail_notes where created_at > now() - interval '1 minute') >= 30
     or (select count(*) from public.trail_notes where created_at > now() - interval '1 day') >= 300 then
    return 'busy';
  end if;

  insert into public.trail_notes (id, delete_hash, sealed) values (trail_id, key_hash, trail_create.sealed);
  return 'ok';
end;
$$;

create function public.trail_get(trail_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('sealed', n.sealed, 'created_at', n.created_at)
    from public.trail_notes as n
   where n.id = trail_id and n.created_at > now() - interval '365 days';
$$;

create function public.trail_remove(trail_id uuid, delete_key uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  delete from public.trail_notes
    where id = trail_id and delete_hash = sha256(uuid_send(delete_key));
  return found;
end;
$$;

revoke all on function public.trail_create(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.trail_get(uuid) from public, anon, authenticated;
revoke all on function public.trail_remove(uuid, uuid) from public, anon, authenticated;
grant execute on function public.trail_create(uuid, uuid, text) to anon, authenticated;
grant execute on function public.trail_get(uuid) to anon, authenticated;
grant execute on function public.trail_remove(uuid, uuid) to anon, authenticated;
