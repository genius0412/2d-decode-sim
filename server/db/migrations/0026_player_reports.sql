-- 0026 — PLAYER REPORTS
--
-- One row per report. Purely ADDITIVE (create-if-not-exists), so rolling the server back
-- leaves the table sitting unread, same discipline as every migration here.
--
-- WHAT IS AND IS NOT STORED. A report names the reported player, the reporter, a category
-- and (optionally) a short note. It records the ROOM the report came from rather than a
-- match id: the match row is written at phase 'post' by the persistence layer, and a report
-- filed from the results screen races that write. Moderation does not need the binding
-- anyway — it looks up the reported player's recent matches (which carry their own
-- replay_id) and offers those, which is both more robust and more useful than a single
-- pinned match.
--
-- The reporter IS recorded. Reports are only as useful as they are accountable: without a
-- reporter a brigade is indistinguishable from a pattern, and a moderator cannot tell four
-- reports from four people apart from four reports from one.

create table if not exists player_reports (
  id          bigserial   primary key,
  reported_id text        not null references profiles(user_id) on delete cascade,
  reporter_id text        not null references profiles(user_id) on delete cascade,
  -- category key; validated against REPORT_REASONS in src/report.ts before it lands here
  reason      text        not null,
  -- optional free text from the reporter, length-capped at the API boundary
  detail      text,
  -- the room the report came from ('' for a profile report, which has no match context)
  room_code   text        not null default '',
  game        text        not null default 'decode',
  -- open | reviewed | dismissed — a moderator's working state, not a punishment record
  status      text        not null default 'open',
  created_at  timestamptz not null default now(),
  reviewed_by text,
  reviewed_at timestamptz
);

-- ONE report per reporter per target per room. Stops a single angry player from filing the
-- same complaint ten times and inflating a count the moderation view sorts on; a genuine
-- second incident in a different match still lands.
create unique index if not exists player_reports_unique_idx
  on player_reports (reporter_id, reported_id, room_code, reason);

-- the moderation queue reads "most recently reported first", and the per-user drill-down
-- reads "everything about this user"
create index if not exists player_reports_reported_idx on player_reports (reported_id, created_at desc);
create index if not exists player_reports_recent_idx on player_reports (created_at desc);
