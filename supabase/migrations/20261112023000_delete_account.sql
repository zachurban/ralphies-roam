-- BuffPrints — let a student permanently delete their account and all of its data.
-- Deleting the auth user cascades to profiles, claims, badges, stats, weekly zone
-- points, hazard reports and hazard votes. Path names they created are removed
-- first (that table keeps names when an author disappears, so delete them explicitly).

create function public.delete_my_account()
returns void language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'Sign in first'; end if;
  delete from public.path_names where named_by = uid;
  delete from auth.users where id = uid;
end $$;

revoke execute on function public.delete_my_account() from public, anon;
grant  execute on function public.delete_my_account() to authenticated;
