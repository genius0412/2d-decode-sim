-- SOLO PRACTICE RUNS — the player's own offline matches, kept so they can watch them back.
--
-- Solo practice runs on the LOCAL sim with no server in the loop, so nothing authoritative
-- witnessed it and its score is a claim the client makes about itself. That is precisely why
-- this is its own table and not a `records` row: `record_leaderboard` is a view over `records`,
-- and every board, PB and rank query reads that view. A run that cannot reach the view cannot
-- reach a leaderboard by accident, by a later refactor, or by a mistaken `union all` — the
-- separation is the enforcement, not a `where` clause somebody has to remember.
--
-- Purely ADDITIVE (create table / create index if not exists), so rolling back the server is
-- safe: an older build simply never selects from it.
create table if not exists practice_runs (
  id              uuid        primary key default gen_random_uuid(),
  user_id         text        not null references profiles(user_id) on delete cascade,
  game            text        not null default 'decode',
  -- the SEASON, matching `records.balance_version` (see 0004/0012) so the season replay purge
  -- can sweep these with everything else rather than leaving orphaned logs behind forever
  balance_version integer     not null,
  -- the run's own alliance total as the LOCAL sim computed it. Unverified by construction;
  -- shown only on the owner's own Career list, never on a board and never beside a real score.
  score           integer     not null,
  ticks           integer     not null,
  replay_id       uuid        references replays(id) on delete set null,
  created_at      timestamptz not null default now()
);

-- the only read path there is: one player's own runs, newest first, per game
create index if not exists practice_user_idx
  on practice_runs (user_id, game, created_at desc);

-- ...and the purge path, which deletes by the replay a run points at
create index if not exists practice_replay_idx on practice_runs (replay_id);

comment on table practice_runs is
  'Offline solo-practice runs, uploaded by the client so a player can rewatch their own matches. NOT a leaderboard table: scores here are client-reported and deliberately unreachable from record_leaderboard. Capped per user by the server (see PRACTICE_KEEP in repo.ts), oldest pruned on insert.';
