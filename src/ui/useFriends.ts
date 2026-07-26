import { useCallback, useEffect, useRef, useState } from 'react';
import type { GameId } from '../types';
import {
  acceptFriendRequest,
  blockUser,
  cancelFriendRequest,
  declineFriendRequest,
  dismissRoomInvite,
  fetchFriends,
  FriendsUnavailableError,
  inviteToRoom,
  removeFriend,
  sendFriendRequest,
  setPresenceStatus,
  unblockUser,
  type Activity,
  type FriendsPayload,
  type PresenceStatus,
} from '../net/api';
import { gameServerConfigured } from '../net/env';

/**
 * Adaptive poll cadence (only ever runs while the tab is VISIBLE — see below).
 * When something is pending a resolution — an incoming request/challenge, an
 * outgoing request, a live invite — we poll FAST so the interactive moment feels
 * near-instant (this is the low-lift stand-in for a real WebSocket push). When
 * nothing's in flight we back off to keep a scale-to-zero Fly machine cheap.
 */
const POLL_HOT_MS = 6_000;
const POLL_IDLE_MS = 20_000;

const EMPTY: FriendsPayload = {
  friends: [],
  incoming: [],
  outgoing: [],
  blocked: [],
  invites: [],
  status: null,
};

export interface FriendsApi {
  data: FriendsPayload;
  loading: boolean;
  /** true once the FIRST server payload has landed — so a consumer can tell the
   * real "no friends" from "not fetched yet" (the toast differ primes off this so
   * it never announces the whole backlog on load) */
  ready: boolean;
  /** the server has no friends API (older deploy than this client) — render the
   * unavailable state, never an error */
  unavailable: boolean;
  /** last mutation error, for inline display; cleared on the next attempt */
  error: string | null;
  refresh: () => void;
  add: (username: string) => Promise<'sent' | 'accepted'>;
  accept: (username: string) => Promise<void>;
  decline: (username: string) => Promise<void>;
  cancel: (username: string) => Promise<void>;
  unfriend: (username: string) => Promise<void>;
  block: (username: string) => Promise<void>;
  unblock: (username: string) => Promise<void>;
  setStatus: (status: PresenceStatus | null) => Promise<void>;
  /** invite a friend to a room by code (server checks the friendship) */
  inviteToRoom: (
    username: string,
    room: string,
    game: GameId,
    kind: 'versus' | 'record',
    record?: 'solo' | 'duo' | null,
  ) => Promise<void>;
  /** dismiss (or consume, on join) an invite addressed to me */
  dismissInvite: (id: string) => Promise<void>;
}

/**
 * The one owner of friends state: the poll timer, the cached payload, and every
 * mutation. Mounted once (in `AppShell`, beside the panel), so the expanded
 * list, the collapsed rail's badge, and anything added later all read one cache
 * instead of each starting a timer.
 *
 * Two things keep this cheap against a scale-to-zero Fly machine:
 *
 *  - **It only polls while the document is VISIBLE.** Otherwise every background
 *    tab someone leaves open would ping the server ~2,900 times a day and keep
 *    them eternally "online" while they're asleep — a cost problem and a wrong
 *    answer. An abandoned tab simply falls out of the freshness window and reads
 *    as offline, which is the truth.
 *  - **The read IS the heartbeat.** `GET /api/friends` records the caller's own
 *    presence server-side, so there's no second ping request.
 */
export function useFriends({
  signedIn,
  activity = 'menu',
  game,
}: {
  signedIn: boolean;
  /** what to report the caller is doing, for friends' activity lines */
  activity?: Activity;
  /** which game the caller is in (reported alongside `activity`) */
  game?: GameId;
}): FriendsApi {
  const [data, setData] = useState<FriendsPayload>(EMPTY);
  // mirrors `data` so an async mutation can read the pre-patch value for rollback
  // without re-creating its callback on every poll
  const dataRef = useRef<FriendsPayload>(EMPTY);
  dataRef.current = data;
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // `refresh()` is called from mutation handlers; a counter avoids threading the
  // fetch function through the effect's deps and re-arming the timer each render
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  const active = signedIn && gameServerConfigured();

  useEffect(() => {
    if (!active) {
      setData(EMPTY);
      setUnavailable(false);
      setReady(false);
      return;
    }
    let alive = true;
    let timer: number | undefined;
    const schedule = (ms: number): void => {
      timer = window.setTimeout(tick, ms);
    };
    // reschedule off the LATEST data (via the ref): fast while anything is
    // pending a resolution, slow when idle
    const nextDelay = (): number => {
      const d = dataRef.current;
      const hot = d.incoming.length > 0 || d.outgoing.length > 0 || d.invites.length > 0;
      return hot ? POLL_HOT_MS : POLL_IDLE_MS;
    };
    function tick(): void {
      if (!alive) return;
      // a hidden/backgrounded tab must not poll — it would keep the caller
      // eternally "online" while away and hammer a scale-to-zero machine. It
      // simply falls out of the freshness window, which reads as offline (the
      // truth). `focus`/`visibilitychange` below catch it up on return.
      if (document.visibilityState !== 'visible') {
        schedule(POLL_IDLE_MS);
        return;
      }
      setLoading(true);
      fetchFriends(activity, game)
        .then((d) => {
          if (!alive) return;
          setData(d);
          setUnavailable(false);
          setReady(true);
        })
        .catch((e: unknown) => {
          if (!alive) return;
          // an old server (no friends API) is a permanent state → show the
          // unavailable panel. Anything else is transient: keep the last good
          // data and let the next tick retry.
          if (e instanceof FriendsUnavailableError) setUnavailable(true);
        })
        .finally(() => {
          if (!alive) return;
          setLoading(false);
          schedule(nextDelay());
        });
    }

    tick();
    // catch up immediately when a backgrounded/blurred tab comes forward, rather
    // than showing stale presence until the next interval
    const wake = (): void => {
      if (document.visibilityState !== 'visible') return;
      window.clearTimeout(timer);
      tick();
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('focus', wake);
    return () => {
      alive = false;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('focus', wake);
    };
  }, [active, activity, game, nonce]);

  /**
   * Apply `patch` to the local cache immediately, then run `call`. A 30s poll is
   * far too long to wait for a row to disappear after clicking Accept, so the UI
   * moves first; on failure the previous state is restored and the message
   * surfaced, and either way the next poll reconciles against the server.
   */
  const mutate = useCallback(
    async (patch: (d: FriendsPayload) => FriendsPayload, call: () => Promise<unknown>) => {
      setError(null);
      // rollback state comes from the ref, NOT from smuggling it out of the
      // setData updater — an updater must be a pure function of its input, and
      // React may invoke it more than once per commit (it does in StrictMode).
      const previous = dataRef.current;
      setData(patch);
      try {
        await call();
      } catch (e) {
        setData(previous);
        setError(e instanceof Error ? e.message : 'Something went wrong.');
        throw e;
      } finally {
        refresh();
      }
    },
    [refresh],
  );

  /** drop one person from a list by username, PRESERVING the element type — a
   * non-generic version widens `friends` to the shared `{username}` shape and
   * loses the presence fields */
  const byName = <T extends { username: string | null }>(list: T[], username: string): T[] =>
    list.filter((p) => p.username !== username);

  const accept = useCallback(
    (username: string) =>
      mutate((d) => {
        const from = d.incoming.find((p) => p.username === username);
        return {
          ...d,
          incoming: byName(d.incoming, username),
          // show them immediately as an offline friend; the next poll fills in
          // their real presence
          friends: from
            ? [
                ...d.friends,
                {
                  userId: from.userId,
                  handle: from.handle ?? '',
                  username: from.username,
                  online: false,
                  status: null,
                  offlineSeconds: null,
                  activity: null,
                  game: null,
                },
              ]
            : d.friends,
        };
      }, () => acceptFriendRequest(username)).then(() => undefined),
    [mutate],
  );

  const decline = useCallback(
    (username: string) =>
      mutate((d) => ({ ...d, incoming: byName(d.incoming, username) }), () =>
        declineFriendRequest(username),
      ).then(() => undefined),
    [mutate],
  );

  const cancel = useCallback(
    (username: string) =>
      mutate((d) => ({ ...d, outgoing: byName(d.outgoing, username) }), () =>
        cancelFriendRequest(username),
      ).then(() => undefined),
    [mutate],
  );

  const unfriend = useCallback(
    (username: string) =>
      mutate((d) => ({ ...d, friends: byName(d.friends, username) }), () =>
        removeFriend(username),
      ).then(() => undefined),
    [mutate],
  );

  const block = useCallback(
    (username: string) =>
      mutate(
        (d) => ({
          ...d,
          // blocking tears down the friendship and both pending requests
          // server-side, so mirror all three locally
          friends: byName(d.friends, username),
          incoming: byName(d.incoming, username),
          outgoing: byName(d.outgoing, username),
        }),
        () => blockUser(username),
      ).then(() => undefined),
    [mutate],
  );

  const unblock = useCallback(
    (username: string) =>
      mutate((d) => ({ ...d, blocked: byName(d.blocked, username) }), () =>
        unblockUser(username),
      ).then(() => undefined),
    [mutate],
  );

  const setStatus = useCallback(
    (status: PresenceStatus | null) =>
      mutate((d) => ({ ...d, status }), () => setPresenceStatus(status)).then(() => undefined),
    [mutate],
  );

  const add = useCallback(
    async (username: string): Promise<'sent' | 'accepted'> => {
      setError(null);
      try {
        const outcome = await sendFriendRequest(username);
        return outcome;
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Something went wrong.');
        throw e;
      } finally {
        refresh();
      }
    },
    [refresh],
  );

  // no local mutation to apply — nothing in MY OWN data changes by inviting
  // someone else — but it still surfaces errors + reconciles on the next poll,
  // same as `add`.
  const inviteRoom = useCallback(
    async (
      username: string,
      room: string,
      game: GameId,
      kind: 'versus' | 'record',
      record?: 'solo' | 'duo' | null,
    ): Promise<void> => {
      setError(null);
      try {
        await inviteToRoom(username, room, game, kind, record);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Something went wrong.');
        throw e;
      } finally {
        refresh();
      }
    },
    [refresh],
  );

  const dismissInvite = useCallback(
    (id: string) =>
      mutate((d) => ({ ...d, invites: d.invites.filter((i) => i.id !== id) }), () =>
        dismissRoomInvite(id),
      ).then(() => undefined),
    [mutate],
  );

  return {
    data,
    loading,
    ready,
    unavailable,
    error,
    refresh,
    add,
    accept,
    decline,
    cancel,
    unfriend,
    block,
    unblock,
    setStatus,
    inviteToRoom: inviteRoom,
    dismissInvite,
  };
}
