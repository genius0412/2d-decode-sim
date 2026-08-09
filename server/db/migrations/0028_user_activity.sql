-- 0028 — PLAYTIME + GAMES PLAYED
--
-- How much a player has actually played, per game. Deliberately NOT derivable from the
-- tables that already exist: `matches` holds PvP only (a solo record run is not in it),
-- `records` holds scored runs only, and NEITHER stores a duration — so "how long have I
-- played" could not be answered by any query over what we already keep.
--
-- AGGREGATED, not an event log. The only questions asked of this are "how many" and "how
-- long", both per account; keeping a row per match to re-sum on every profile view would be
-- a table that grows forever to answer a question two integers already answer. The per-match
-- detail that IS wanted (what, when, against whom) lives in `matches` and `records` already.
--
-- Keyed per GAME because everything else here is: the profile panel shows one game at a
-- time, and a combined total is a SUM over these rows rather than a number that has to be
-- kept in step with them.
--
-- Purely ADDITIVE (create-if-not-exists), so rolling the server back leaves it unread.

create table if not exists user_activity (
  user_id    text        not null references profiles(user_id) on delete cascade,
  -- 'decode' | 'chain' — text, not an enum, so a third game is a code change
  game       text        not null default 'decode',
  -- matches the server ran with this player in them: ranked, custom rooms and record runs
  games      integer     not null default 0,
  -- SECONDS of live match time, summed from each match's real tick count (ticks × SIM_DT).
  -- Integer: this is a total measured in hours, and fractions of a second in a sum of
  -- 2-minute matches are noise nobody will ever look at.
  seconds    integer     not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, game)
);

-- the profile read: one account's rows (at most one per game)
create index if not exists user_activity_user_idx on user_activity (user_id);
