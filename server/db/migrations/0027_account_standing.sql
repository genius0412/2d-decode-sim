-- 0027 — ACCOUNT STANDING
--
-- Competitive integrity, kept OFF the rating. `elo_ratings` answers "how good is this
-- player"; nothing in it should ever move because of something they did to other people.
-- So behaviour lives here, on its own 0-100 score (see src/standing.ts) with its own
-- consequences: a warning, then queue cooldowns, and only at the bottom of the ladder does
-- it start charging rating.
--
-- TWO TABLES on purpose. `account_standing` is the CURRENT state and the only thing the
-- ranked queue reads on the hot path (one primary-key lookup per queue attempt).
-- `standing_events` is the LEDGER — every offence with what it cost — because a penalty a
-- player cannot see the reason for is the thing that makes a system feel arbitrary, and
-- because a moderator triaging a report needs the history, not just the number.
--
-- HEALING IS LAZY, not a cron. `healed_at` is the point the score has been healed THROUGH;
-- a read advances it in whole days and credits the difference (src/standing.ts `healed`).
-- That keeps recovery honest without a scheduled job, and it cannot double-credit: the
-- advance and the credit are written in the same statement.
--
-- Purely ADDITIVE (create-if-not-exists), so rolling the server back leaves both tables
-- sitting harmlessly unread — the discipline every migration here follows.

create table if not exists account_standing (
  user_id         text        primary key references profiles(user_id) on delete cascade,
  -- 0..100, everyone starts full. Spent only by doing something to other players.
  score           integer     not null default 100,
  -- when the ranked queue reopens for this account (null ⇒ open)
  restricted_until timestamptz,
  -- the instant the score has been time-healed through (see above)
  healed_at       timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table if not exists standing_events (
  id            bigserial   primary key,
  user_id       text        not null references profiles(user_id) on delete cascade,
  -- 'dodge' | 'afk' | 'leave' | 'report' | 'reportUpheld' — kept as text, not an enum, so
  -- adding a category is a code change and not a migration
  kind          text        not null,
  -- standing points actually deducted, and where that left them. Stored rather than
  -- recomputed, so the record still reads true after the cost table is retuned.
  points        integer     not null default 0,
  score_after   integer     not null,
  -- what was ENFORCED: queue cooldown in minutes, and rating charged (0 above probation)
  cooldown_min  integer     not null default 0,
  rating_charge integer     not null default 0,
  game          text,
  mode          text,
  room_code     text,
  at            timestamptz not null default now()
);

-- the ledger read: "what has this player done, newest first"
create index if not exists standing_events_user_at_idx on standing_events (user_id, at desc);
-- the escalation read: "how many of THIS kind inside the window"
create index if not exists standing_events_user_kind_at_idx on standing_events (user_id, kind, at desc);
-- the moderation read: everyone currently below good standing, worst first
create index if not exists account_standing_score_idx on account_standing (score);
