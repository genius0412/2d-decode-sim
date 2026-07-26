-- "Play a friend", finished: turn a room invite into a real CHALLENGE.
--
-- `room_invites` started as "come join my room" — a one-way pointer at a room
-- code that the recipient either joined or ignored. The challenge flow needs two
-- more things, both of which the sender has to be able to see:
--
--  * FORMAT — a challenge now carries what was actually offered ('casual1v1',
--    'rated1v1', 'ranked2v2', 'duorecord'). The rated formats do NOT resolve to a
--    joinable room at all: `room` holds the party token both clients hand the
--    matchmaker, which pairs them and stages a ranked match (server/matchmaking.ts).
--    Nullable, and null reads as the historical casual-versus meaning, so invites
--    already in flight during the deploy keep working.
--
--  * DECLINED — declining used to be indistinguishable from ignoring, because it
--    deleted the row and the sender only ever saw the challenge silently vanish.
--    Marking it instead lets the sender be told once ("@x declined"), after which
--    their client cancels the row for real. A decline the sender never collects is
--    swept by the same read-time TTL as everything else here.
--
-- Additive (add column if not exists), so rollback is "deploy the previous
-- server" — it simply stops reading these two columns.
alter table room_invites add column if not exists format text;
alter table room_invites add column if not exists declined boolean not null default false;

-- The sender's own outgoing-challenge list is a new read path (previously nothing
-- ever queried this table by sender), and it runs on every friends poll.
create index if not exists room_invites_from_idx on room_invites(from_user_id);
