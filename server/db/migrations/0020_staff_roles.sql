-- Staff roles: the owner and the admins, as a badge and as an entitlement.
--
-- WHY A COLUMN when `ADMIN_USER_IDS` already exists as an env var. That env is
-- the source of truth and stays that way — this column is a PROJECTION of it,
-- reconciled at boot (`syncStaffRoles`). The difference matters because of where
-- the two get read:
--
--   * The admin GATE is a per-request check against one caller's id, which an
--     in-memory Set answers perfectly.
--   * The BADGE has to appear next to a name on a 100-row leaderboard, in a lobby
--     roster, and on a public profile — all of which are single SQL statements
--     that already join `profiles`. Answering "is this row staff?" from a Node
--     Set would mean either post-processing every row set by hand at each call
--     site, or leaking the admin list to the client. A column joins for free.
--
-- It also makes the PERK one edit instead of many: the supporter predicate is
-- shared by every read (badge, ad gating, entitlements, cosmetics), so folding
-- staff into that one expression grants admins everything a supporter has,
-- everywhere, without a second code path that could drift out of agreement.
--
-- Values: 'owner' (exactly one) | 'admin' | null. Deliberately NOT an enum type —
-- a text column with a check keeps a future role addition to a migration rather
-- than an ALTER TYPE that Postgres cannot run inside a transaction with other
-- statements.
--
-- Purely ADDITIVE, so rolling back to a server without this migration is safe:
-- the older code simply never selects the column, and admins revert to being
-- admins-without-a-badge.
alter table profiles add column if not exists role text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_role_chk') then
    alter table profiles add constraint profiles_role_chk
      check (role is null or role in ('owner', 'admin'));
  end if;
end $$;

-- Staff are a handful of rows in a table of thousands, and every leaderboard read
-- now asks about them. A partial index costs almost nothing and keeps the
-- reconcile-at-boot sweep (which deletes roles no longer in the env) from
-- scanning the whole table on all five machines at once.
create index if not exists profiles_role_idx on profiles (role) where role is not null;
