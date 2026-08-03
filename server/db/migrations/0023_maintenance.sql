-- MAINTENANCE LOCKDOWN: a scheduled window during which only admins may start
-- anything, so a season reset or a large deploy can land without half-finished
-- matches writing into tables that are being migrated underneath them.
--
-- IN THE DATABASE, not in a machine's memory, for two reasons that are the whole
-- point of the feature:
--   * it has to survive the restart it exists to protect. A lockdown held in
--     process memory evaporates at exactly the moment the deploy begins.
--   * every region has to agree. Anycast puts each player on a different machine,
--     so an in-memory flag would lock some players out and let others straight in.
--
-- Single row (id = 1). `starts_at` may be in the future — that is what lets players
-- be told "maintenance at 21:00" before it bites rather than being cut off mid-click.
create table if not exists maintenance (
  id int primary key default 1,
  active boolean not null default false,
  starts_at timestamptz,
  ends_at timestamptz,
  message text not null default '',
  updated_at timestamptz not null default now(),
  constraint maintenance_singleton check (id = 1)
);
insert into maintenance (id) values (1) on conflict (id) do nothing;
