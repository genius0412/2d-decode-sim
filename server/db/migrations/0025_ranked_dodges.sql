-- 0025 — RANKED DODGES
--
-- One row per abandoned ranked pairing, per player at fault. Two jobs:
--   1. the rolling-window COUNT that drives the escalating penalty (see src/dodge.ts)
--   2. an honest record to show the player, so a penalty is never unexplained
--
-- Purely ADDITIVE (create-if-not-exists), so rolling back the server leaves the table
-- sitting harmlessly unread — the same discipline every migration here follows.
--
-- Deliberately NOT keyed to a season/act. The escalation window is hours long, so a season
-- boundary in the middle of it would silently forgive a player mid-pattern; `game` and `act`
-- are recorded for context and for the per-board penalty, but the COUNT is by time alone.

create table if not exists ranked_dodges (
  id       bigserial   primary key,
  user_id  text        not null references profiles(user_id) on delete cascade,
  game     text        not null default 'decode',
  mode     text        not null check (mode in ('1v1', '2v2')),
  act      integer     not null default 0,
  -- 'noshow' | 'bail' | 'unready' — which of the three ways to abandon a pairing this was
  kind     text        not null,
  -- rating actually deducted, and where it landed. Stored rather than recomputed so the
  -- record still reads true after the penalty scale is retuned.
  penalty  integer     not null default 0,
  rating_before integer,
  rating_after  integer,
  at       timestamptz not null default now()
);

-- the ONLY hot read: "how many dodges has this user had since <timestamp>"
create index if not exists ranked_dodges_user_at_idx on ranked_dodges (user_id, at desc);
