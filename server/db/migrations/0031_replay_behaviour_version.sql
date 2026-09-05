-- REPLAYS WERE UNWATCHABLE — every single one, not just the old ones.
--
-- `config.ts` carries TWO version numbers on purpose (see SIM_VERSION there): BALANCE_VERSION
-- keys the competitive season, and SIM_VERSION says which sim BEHAVIOUR produced a given log.
-- A replay is an input log re-simulated by the viewing build, so the gate that decides "will
-- this reproduce the match that was played" has to compare SIM_VERSION.
--
-- This table never had a column for it. `replays.balance_version` is the SEASON (the purge key,
-- see 0004) and `replays.sim_version` — despite the name — holds the recording build's
-- BALANCE_VERSION (see 0012). So `getReplay` could not populate `Replay.sim`, it came back
-- `undefined`, and `replayPlayable` reads an absent `sim` as 0. Nothing ever matched, so EVERY
-- DB-served replay was refused as stale on every build. The bug was invisible because replays
-- were only ever exercised through in-memory containers in tests, which carry the field.
--
-- `behaviour_version` is that missing number. NULL means "recorded before this column existed",
-- which is honestly unknown rather than zero, and the reader keeps it undefined so the viewer
-- can say so instead of claiming a specific mismatch.
alter table replays add column if not exists behaviour_version int;

-- No backfill, deliberately. Every pre-existing row was recorded by a build that did not stamp
-- SIM_VERSION, and there is no way to recover which behaviour it ran — guessing a number here
-- would assert that an old log re-simulates exactly on some specific build, which is the one
-- claim this column exists to stop us making. They stay NULL and play with a warning.

comment on column replays.behaviour_version is
  'config.SIM_VERSION of the build that RECORDED this replay. NULL = recorded before the column existed (unknown). Distinct from sim_version, which holds the recording build''s BALANCE_VERSION, and from balance_version, which is the SEASON.';
