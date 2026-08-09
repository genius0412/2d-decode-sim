-- 0029 — WHICH MACHINE THE ROOM IS ON
--
-- One Fly app runs in several regions, and a CUSTOM room code is bare: unlike a
-- matchmaker-staged room (`iad-abc123`), there is no region in it for the proxy to route a
-- socket on. So a friend accepting an invite connected to whichever machine was nearest to
-- THEM — and if the two players had picked different servers, each one created a room with
-- that code on their own machine and sat in it alone. Two lobbies, one code, no error
-- anywhere; the only defence was a line of UI text asking both people to pick the same
-- region by hand.
--
-- The invite now carries the host's region, so the recipient is routed to the machine the
-- room is actually on. Nullable on purpose: invites from older clients (and rows already in
-- flight) simply have no region, and the client falls back to the old behaviour for them.

alter table room_invites add column if not exists region text;
