-- Minimal stand-in for the parts of Supabase the migrations rely on, so they can
-- be tested against a plain PostgreSQL 15+ server:
--   * API roles anon / authenticated / service_role
--   * Supabase's default grants (ALL on new public tables and functions to the API roles,
--     which is why the migrations revoke what they don't want exposed)
--   * auth.users, auth.uid() and auth.jwt() (read the JWT claims the API would set)
-- Roles belong to the whole server, and two test files may set up their databases at the
-- same moment, so "already there" (including "created a millisecond ago") is fine.
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    begin
      if not exists (select 1 from pg_roles where rolname = r) then
        execute format('create role %I nologin %s', r, case when r = 'service_role' then 'bypassrls' else '' end);
      end if;
    exception when others then
      if not exists (select 1 from pg_roles where rolname = r) then raise; end if;
    end;
  end loop;
  begin
    execute 'grant anon, authenticated, service_role to current_user';
  exception when others then
    if not (pg_has_role(current_user, 'anon', 'member') and pg_has_role(current_user, 'authenticated', 'member')) then raise; end if;
  end;
end $$;

create schema auth;
create table auth.users (
  id         uuid primary key default gen_random_uuid(),
  email      text,
  email_confirmed_at timestamptz default now(),
  created_at timestamptz not null default now()
);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(coalesce(current_setting('request.jwt.claim.sub', true),
                         (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')), '')::uuid;
$$;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim', true), ''), nullif(current_setting('request.jwt.claims', true), ''))::jsonb;
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant execute on function auth.jwt() to anon, authenticated, service_role;

grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
