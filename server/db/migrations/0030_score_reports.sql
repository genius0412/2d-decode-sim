-- MISSCORE REPORTS — a claim about a MATCH, not about a player.
--
-- `player_reports` is the wrong table for this and not by a little: every row there is a
-- complaint about a PERSON (`reported_id` is NOT NULL and references a profile), and a
-- misscore is a complaint about a RESULT. Filing one against an opponent would name a
-- culprit the reporter has no way of knowing exists — the score is the server's arithmetic,
-- and if it is wrong the fault is the sim's, not the other alliance's.
--
-- So the row points at the MATCH. A moderator opens it with the replay the match already
-- stored, which is the only evidence that can settle "the score was wrong": the alternative
-- is taking a losing player's word for it, and that is exactly what the smite below exists
-- to make expensive.
create table if not exists score_reports (
  id          bigserial   primary key,
  reporter_id text        not null references profiles(user_id) on delete cascade,
  -- the match, when there is one on record. Nullable because a player can be looking at a
  -- result that never finished writing (a crash, a server restart mid-finalise) and that is
  -- exactly the case worth hearing about.
  match_id    uuid        references matches(id) on delete set null,
  room_code   text        not null default '',
  game        text        not null default 'decode',
  -- what they say went wrong, free text, length-capped at the API boundary
  detail      text        not null,
  -- open | upheld | rejected. `rejected` is what a smite is issued against, and the two are
  -- deliberately separate columns: a moderator can reject a claim without smiting someone
  -- who was merely mistaken, and the ledger should say which of those happened.
  status      text        not null default 'open',
  created_at  timestamptz not null default now(),
  reviewed_by text,
  reviewed_at timestamptz,
  -- standing points taken off the REPORTER when the claim was found malicious (0 = none)
  smite       integer     not null default 0
);

-- ONE open claim per reporter per match: a second look at the same result is the same claim,
-- and letting it stack would let one player fill the queue with a single grievance.
create unique index if not exists score_reports_unique_idx
  on score_reports (reporter_id, room_code, coalesce(match_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- the queue reads newest-first, and the per-user view reads everything one person has filed
-- (which is how a pattern of false claims becomes visible before a moderator has to notice)
create index if not exists score_reports_recent_idx on score_reports (created_at desc);
create index if not exists score_reports_reporter_idx on score_reports (reporter_id, created_at desc);
