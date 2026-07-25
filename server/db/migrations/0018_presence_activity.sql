-- Rich presence: WHAT a friend is doing, not just online/offline.
--
-- `activity` is coarse and behavioural ('menu' | 'lobby' | 'match'), reported by
-- the caller's own heartbeat (the GET /api/friends read, plus a lighter beat from
-- the full-screen match/lobby surfaces). `activity_game` names which game it's in
-- ('decode' | 'chain') so a friend row can read "In a match · DECODE".
--
-- Both live in `user_presence` — the same skinny, structurally-private table that
-- already holds last_seen/status — so they never leak through a public profile
-- read (see 0016's note). They are only ever surfaced through the caller's own
-- friendship rows, and are BLANKED for an 'invisible' friend in listFriends just
-- like last_seen already is.
alter table user_presence add column if not exists activity text;
alter table user_presence add column if not exists activity_game text;
