-- BuffPrints — bring existing leaderboard names into the nickname system.
-- Nobody is renamed. For each profile that already has a display_name, oldest
-- account first:
--   * fails moderation  → hidden behind the "Buff 1A2B" placeholder and queued
--                         for administrator review (source 'automated'). An admin
--                         "dismiss" shows it again; the owner is asked to pick a
--                         nickname either way.
--   * already a valid nickname (3–24 letters/digits/_ with a letter) and not
--     taken by an older account (case-insensitively or as a look-alike)
--                       → kept exactly as typed, as their nickname.
--   * anything else (spaces, punctuation, too short/long, a later duplicate)
--                       → still shown as before; the owner gets the nickname
--                         picker the next time they open the app.
-- Profiles with no name get the picker too. Review the effect before merging
-- with the preview query in docs/USERNAMES.md.
do $$
declare pr record; prob text; kept int := 0; hidden int := 0; later int := 0;
begin
  for pr in select id, display_name from public.profiles
            where display_name is not null and username is null
            order by created_at, id loop
    prob := coalesce(public.rr_username_problem(pr.display_name), public.rr_username_digit_problem(pr.display_name));
    if prob is not null then
      update public.profiles set name_state = 'hidden', name_state_reason = 'automated' where id = pr.id;
      insert into public.username_reports (target_user_id, source, reported_name, reason)
      values (pr.id, 'automated', pr.display_name, 'automated') on conflict do nothing;
      insert into public.moderation_audit (action, target_user_id, detail)
      values ('migration_hidden', pr.id, jsonb_build_object('name', pr.display_name, 'category', prob));
      hidden := hidden + 1;
    elsif public.rr_username_format_ok(pr.display_name) and not public.rr_username_taken(pr.display_name, pr.id) then
      begin
        update public.profiles set username = pr.display_name, username_set_at = now() where id = pr.id;
        kept := kept + 1;
      exception when unique_violation then
        later := later + 1;
      end;
    else
      later := later + 1;
    end if;
  end loop;
  raise notice 'Legacy names: % kept as nicknames, % hidden for review, % will be asked to choose', kept, hidden, later;
end $$;
