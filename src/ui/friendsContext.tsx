import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { GameId } from '../types';
import type { RoomKind } from '../net/protocol';
import type { Activity, PublicProfile, RoomInvite } from '../net/api';
import { generateRoomCode } from '../net/roomCode';
import { useFriends, type FriendsApi } from './useFriends';
import { ChallengePicker, type ChallengeFormat } from './ChallengePicker';

/**
 * ONE shared friends store for the whole menu shell.
 *
 * Before this, `useFriends` was mounted separately by the panel, the profile
 * page, and the invite flyout — three timers, three caches, a double-poll whenever
 * two co-mounted. This provider mounts it ONCE (wrapping `AppShell`) so every
 * surface reads the same live data, and it's the natural home for the two things
 * that need app-level reach:
 *
 *  - **Challenge** (chess.com's core loop): create a room, invite a friend to it,
 *    and drop yourself into the lobby as host — reachable from a friend row, a
 *    profile, anywhere. Needs both the friends API (the invite) AND navigation
 *    (host the room), so it lives here where both are in scope.
 *  - **Notifications**: a new incoming request or invite should announce itself
 *    even when the panel is collapsed. The store sees every poll, so it diffs new
 *    arrivals into transient toasts.
 *
 * `Lobby`'s `InviteFlyout` is the ONE consumer that stays on its own `useFriends`
 * — it's a full-screen surface rendered OUTSIDE this provider.
 */
export interface FriendToast {
  id: number;
  kind: 'request' | 'invite';
  from: PublicProfile;
  invite?: RoomInvite;
}

export interface FriendsCtx extends FriendsApi {
  /** open the "Play a friend" format picker for this friend. The actual
   * invite+host happens when they pick a format (see `challenge`). */
  openChallenge: (username: string) => void;
  /** create a room in the chosen FORMAT + invite this friend + host it (they get
   * an invite to join). Called by the picker; navigates on success. */
  challenge: (username: string, format: ChallengeFormat) => Promise<void>;
  /** the game challenges are created for (the caller's selected game) */
  game: GameId;
  toasts: FriendToast[];
  dismissToast: (id: number) => void;
}

const Ctx = createContext<FriendsCtx | null>(null);

/** the number of toasts kept on screen at once — a challenge storm shouldn't
 * bury the page */
const MAX_TOASTS = 4;
const TOAST_MS = 9000;

/** a soft two-note chime for an incoming request/challenge. Self-contained
 * WebAudio (no asset), gated by the caller's master-sound setting, and wrapped so
 * a locked AudioContext (no user gesture yet) never throws into React. */
function chime(enabled: boolean): void {
  if (!enabled) return;
  try {
    const AC =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    const now = ctx.currentTime;
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.09, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.5);
    for (const [t, f] of [
      [0, 660],
      [0.12, 880],
    ] as const) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = f;
      osc.connect(gain);
      osc.start(now + t);
      osc.stop(now + t + 0.2);
    }
    window.setTimeout(() => void ctx.close().catch(() => {}), 800);
  } catch {
    /* audio unavailable — a missing chime is never worth a thrown render */
  }
}

export function FriendsProvider({
  signedIn,
  activity = 'menu',
  game,
  sound,
  onHostRoom,
  children,
}: {
  signedIn: boolean;
  activity?: Activity;
  game: GameId;
  /** play the arrival chime (master sound on) */
  sound: boolean;
  /** host a freshly-created room after a challenge invite is sent. `kind` picks
   * the destination: `versus` → the custom-match lobby, `record` → the duo record
   * lobby (a co-op run). */
  onHostRoom: (code: string, game: GameId, kind: RoomKind) => void;
  children: ReactNode;
}) {
  const api = useFriends({ signedIn, activity, game });

  // which friend the "Play a friend" picker is open for (null = closed)
  const [challengeTarget, setChallengeTarget] = useState<string | null>(null);
  const openChallenge = useCallback((username: string) => setChallengeTarget(username), []);

  const challenge = useCallback(
    async (username: string, format: ChallengeFormat): Promise<void> => {
      const code = generateRoomCode();
      // a co-op record run is a `record`/`duo` room; both casual formats are a
      // `versus` room (1v1 vs 2v2 is decided by who joins + alliance in the lobby)
      const record = format === 'duorecord';
      // send FIRST — only host the room if the invite actually went out (a
      // not-friends/blocked failure throws, and we never navigate on it)
      await api.inviteToRoom(username, code, game, record ? 'record' : 'versus', record ? 'duo' : null);
      onHostRoom(code, game, record ? 'record' : 'versus');
    },
    [api, game, onHostRoom],
  );

  // ---- notification toasts: diff each poll for genuinely new arrivals --------
  const [toasts, setToasts] = useState<FriendToast[]>([]);
  const nextId = useRef(0);
  const seenReq = useRef<Set<string>>(new Set());
  const seenInv = useRef<Set<string>>(new Set());
  const primed = useRef(false);
  const soundRef = useRef(sound);
  soundRef.current = sound;

  const dismissToast = useCallback(
    (id: number) => setToasts((t) => t.filter((x) => x.id !== id)),
    [],
  );

  useEffect(() => {
    // reset the baseline on sign-out so re-signing-in doesn't replay a backlog
    if (!api.ready) {
      primed.current = false;
      seenReq.current = new Set();
      seenInv.current = new Set();
      return;
    }
    const { incoming, invites } = api.data;
    const reqIds = new Set(incoming.map((p) => p.userId));
    const invIds = new Set(invites.map((i) => i.id));
    if (!primed.current) {
      // first real payload — adopt as the baseline, never toast what was already
      // waiting when the page opened
      primed.current = true;
      seenReq.current = reqIds;
      seenInv.current = invIds;
      return;
    }
    const fresh: FriendToast[] = [];
    for (const p of incoming) {
      if (!seenReq.current.has(p.userId)) {
        nextId.current += 1;
        fresh.push({ id: nextId.current, kind: 'request', from: p });
      }
    }
    for (const inv of invites) {
      if (!seenInv.current.has(inv.id)) {
        nextId.current += 1;
        fresh.push({ id: nextId.current, kind: 'invite', from: inv.from, invite: inv });
      }
    }
    seenReq.current = reqIds;
    seenInv.current = invIds;
    if (fresh.length) {
      setToasts((t) => [...t, ...fresh].slice(-MAX_TOASTS));
      chime(soundRef.current);
    }
  }, [api.ready, api.data]);

  // auto-expire toasts; a single timer scans the queue so we never leak per-toast
  // timeouts when a burst arrives
  useEffect(() => {
    if (toasts.length === 0) return;
    const t = window.setTimeout(() => {
      setToasts((cur) => cur.slice(1)); // drop the oldest
    }, TOAST_MS);
    return () => window.clearTimeout(t);
  }, [toasts]);

  const value: FriendsCtx = { ...api, openChallenge, challenge, game, toasts, dismissToast };
  return (
    <Ctx.Provider value={value}>
      {children}
      {challengeTarget && (
        <ChallengePicker
          username={challengeTarget}
          onPick={(format) => challenge(challengeTarget, format)}
          onClose={() => setChallengeTarget(null)}
        />
      )}
    </Ctx.Provider>
  );
}

/** read the shared friends store. Throws if used outside the provider — callers
 * inside the menu shell (panel, profile actions, toasts) are always inside it;
 * the Lobby flyout deliberately isn't and uses its own `useFriends`. */
export function useFriendsCtx(): FriendsCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useFriendsCtx must be used within <FriendsProvider>');
  return v;
}

/**
 * The floating notification stack. Rendered inside `AppShell` only, so it lives
 * on the menu shell and NEVER over a live match (product decision: no popup toasts
 * over the field). A request toast can be actioned inline (Accept/Decline); a
 * challenge/invite toast joins the room or dismisses.
 */
export function FriendToasts({
  onOpenProfile,
  onJoinInvite,
}: {
  onOpenProfile: (username: string) => void;
  onJoinInvite: (invite: RoomInvite) => void;
}) {
  const friends = useFriendsCtx();
  const { toasts, dismissToast } = friends;
  if (toasts.length === 0) return null;
  return (
    <div className="fr-toasts" role="region" aria-label="Friend notifications">
      {toasts.map((t) => (
        <div className="fr-toast" key={t.id}>
          <button
            className="fr-toast-who"
            onClick={() => t.from.username && onOpenProfile(t.from.username)}
            disabled={!t.from.username}
          >
            <span className="fr-toast-name">{t.from.handle}</span>
            <span className="fr-toast-sub">
              {t.kind === 'invite' ? 'wants to play' : 'sent you a friend request'}
            </span>
          </button>
          <span className="fr-actions">
            {t.kind === 'invite' && t.invite ? (
              <button
                className="ds-btn small primary"
                onClick={() => {
                  onJoinInvite(t.invite!);
                  dismissToast(t.id);
                }}
              >
                Join
              </button>
            ) : (
              t.from.username && (
                <button
                  className="ds-btn small primary"
                  onClick={() => {
                    void friends.accept(t.from.username!);
                    dismissToast(t.id);
                  }}
                >
                  Accept
                </button>
              )
            )}
            <button className="ds-btn small ghost" aria-label="Dismiss" onClick={() => dismissToast(t.id)}>
              ✕
            </button>
          </span>
        </div>
      ))}
    </div>
  );
}
