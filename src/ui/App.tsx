import { useCallback, useEffect, useRef, useState } from 'react';
import type { GameSettings } from '../game';
import { loadSettings, saveSettings, switchGame, syncAudioMirrors } from '../settings';
import {
  saveAccountSettings,
  fetchAdminStatus,
  fetchProfile,
  fetchFriends,
  type Activity,
  type RoomInvite,
} from '../net/api';
import { uploadPracticeRun } from '../net/api';
import { FriendsProvider } from './friendsContext';
import { challengeOf, type PendingChallenge } from './challenge';
import type { RoomConfig, RoomKind } from '../net/protocol';
import { useNewVersion } from '../net/version';
import { useServerNotice } from '../net/notice';
import { Admin } from './Admin';
import { Announcements } from './Announcements';
import { AccountSync } from './AccountSync';
import { GameView } from './GameView';
import { Lobby } from './Lobby';
import { WatchLive } from './WatchLive';
import { LobbyClient } from '../net/lobbyClient';
import { AppShell, type ShellNav } from './AppShell';
import { HomeMenu } from './HomeMenu';
import { ModeSelect } from './ModeSelect';
import { Configure, isConfigureSection, type ConfigureSection } from './Configure';
import { Records, isRecordsTab, type RecordsTab } from './Records';
import { RecordRun } from './RecordRun';
import { Matchmaking } from './Matchmaking';
import { QueueBar, useParkedQueue } from './QueueBar';
import { usePresence } from './usePresence';
import { maintenanceLine } from './MaintenanceBanner';
import { peekQueue } from './queueKeeper';
import { ReplayView } from './ReplayView';
import { ProfileMenu } from './ProfileMenu';
import { Download } from './Download';
import { Contributors } from './Contributors';
import { Privacy, Terms } from './Legal';
import { Donate } from './Donate';
import { Changelog } from './Changelog';
import { Profile } from './Profile';
import { UsernameGate } from './UsernameGate';
import { Account } from './Account';
import { authEnabled } from '../lib/authClient';
import { gameServerConfigured, setSelectedServer, selectedServer, selectedServerId, gameServerUrlWith } from '../net/env';
import { ServerMenu } from './ServerMenu';
import type { NetSession } from '../net/session';
import { ServerSession } from '../net/serverSession';
import { WebSocketTransport } from '../net/transport';
import { encodeMsg } from '../net/protocol';
import { loadActiveGame, saveActiveGame, clearActiveGame, type ActiveGameRef } from '../net/activeGame';
import { recordScore, type Replay, type ReplayResult } from '../sim/replay';
import {
  savePracticeRun,
  markPracticeUploaded,
  pendingPracticeUploads,
  loadPracticeReplay,
} from '../net/practiceRuns';
import { applyRouteMeta } from '../seo';
import type { GameId } from '../games/types';
import { chainDisclaimerSeen, markChainDisclaimerSeen } from '../chainDisclaimer';
import { startSelectionLegal } from './startPositions';

type Screen =
  | 'home'
  | 'modes'
  | 'configure'
  | 'records'
  | 'lobby'
  | 'record'
  | 'duorecord'
  | 'matchmaking'
  | 'watch'
  | 'replay'
  | 'game'
  | 'download'
  | 'contributors'
  | 'privacy'
  | 'terms'
  | 'donate'
  | 'changelogs'
  | 'profile'
  | 'account'
  | 'admin';

/** everything a route needs beyond the screen itself */
interface RouteArgs {
  /** `/replay/<id>` */
  replayId: string | null;
  /** `/profile/<username>` */
  username: string | null;
  /** the section/tab of a screen that has them: `/configure/<sub>`, `/records/<sub>` */
  sub: string | null;
}
const NO_ARGS: RouteArgs = { replayId: null, username: null, sub: null };

/**
 * Tiny path router (no dependency). Each screen is a real URL, and every URL is
 * PREFIXED by the selected game — /decode/modes, /chain/configure/robot,
 * /chain/records/career, … — via the History API, so links are shareable, the
 * game is always visible in the address bar, and back/forward switch both the
 * screen AND the game. DECODE and Chain Reaction never share a URL. The web build
 * uses an absolute base + a vercel.json SPA rewrite so a deep load/refresh
 * resolves. Under Electron (file://) there is no History to push, so we route by
 * state only (isWebHistory === false).
 *
 * Back-compat: an OLD unprefixed link (/modes, /leaderboard) still resolves — the
 * game falls back to the last-selected game and the URL is canonicalized to
 * include the prefix on load.
 */
const isWebHistory = typeof window !== 'undefined' && window.location.protocol !== 'file:';

/**
 * Did this document OPEN on a game-prefixed URL? Captured at module load, before
 * the mount effect canonicalizes `/` to `/decode` in the address bar.
 *
 * It decides the home route's canonical. `/` and `/decode` render the same
 * screen, so one has to point at the other, and which one depends on the URL
 * that was actually requested: arrive at `/` and the canonical is `/`, arrive at
 * `/decode` and it is `/decode`. Reading `location.pathname` from the effect
 * can't tell the two apart (the rewrite has already run), so every visit would
 * canonicalize to `/decode` and quietly deindex the homepage.
 *
 * A crawler renders exactly one URL and never navigates, so a value fixed at
 * load is right for the only consumer that reads canonicals; in-app navigation
 * back to home just keeps whichever form the tab was opened with.
 */
const ENTRY_HAS_GAME =
  isWebHistory && /^\/(decode|chain)(?=\/|$)/.test(window.location.pathname);

/** the screen part of a path (no game prefix); '' for home. */
function screenSuffix(screen: Screen, a: RouteArgs): string {
  switch (screen) {
    case 'home':
      return '';
    case 'modes':
      return '/modes';
    case 'configure':
      return `/configure/${isConfigureSection(a.sub) ? a.sub : 'robot'}`;
    case 'records':
      return a.sub === 'career' ? '/records/career' : '/records';
    case 'profile':
      return a.username ? `/profile/${encodeURIComponent(a.username)}` : '/records';
    case 'lobby':
      return '/lobby';
    case 'record':
      return '/record';
    case 'duorecord':
      return '/duo-record';
    case 'matchmaking':
      return '/ranked';
    case 'watch':
      return '/watch';
    case 'replay':
      return a.replayId ? `/replay/${encodeURIComponent(a.replayId)}` : '/replay';
    case 'game':
      return '/play';
    case 'download':
      return '/download';
    case 'contributors':
      return '/contributors';
    case 'privacy':
      return '/privacy';
    case 'terms':
      return '/terms';
    case 'donate':
      return '/donate';
    case 'changelogs':
      return '/changelogs';
    case 'account':
      return '/account';
    case 'admin':
      return '/admin';
  }
}

/** the full path for a screen under a given game — always game-prefixed. */
function pathFor(screen: Screen, a: RouteArgs, game: GameId): string {
  return `/${game}${screenSuffix(screen, a)}`;
}

/** parse the screen (no game prefix) from a game-stripped path. */
function parseScreen(rest: string): { screen: Screen } & RouteArgs {
  const at = (screen: Screen, extra: Partial<RouteArgs> = {}) => ({
    screen,
    ...NO_ARGS,
    ...extra,
  });

  const replay = rest.match(/^\/replay\/(.+)$/);
  if (replay) return at('replay', { replayId: decodeURIComponent(replay[1]) });
  const profile = rest.match(/^\/profile\/(.+)$/);
  if (profile) return at('profile', { username: decodeURIComponent(profile[1]) });

  const configure = rest.match(/^\/configure(?:\/([^/]+))?/);
  if (configure) return at('configure', { sub: configure[1] ?? 'robot' });
  const records = rest.match(/^\/records(?:\/([^/]+))?/);
  if (records) return at('records', { sub: records[1] ?? 'leaderboard' });

  // legacy paths kept alive so old links (and anything a player bookmarked
  // before the nav restructure) still resolve to their new home
  if (rest.startsWith('/my-robot')) return at('configure', { sub: 'robot' });
  if (rest.startsWith('/leaderboard')) return at('records', { sub: 'leaderboard' });
  if (rest.startsWith('/stats')) return at('records', { sub: 'career' });

  if (rest.startsWith('/modes')) return at('modes');
  if (rest.startsWith('/lobby')) return at('lobby');
  if (rest.startsWith('/duo-record')) return at('duorecord');
  if (rest.startsWith('/record')) return at('record');
  if (rest.startsWith('/ranked')) return at('matchmaking');
  if (rest.startsWith('/watch')) return at('watch');
  if (rest.startsWith('/download')) return at('download');
  if (rest.startsWith('/contributors')) return at('contributors');
  if (rest.startsWith('/privacy')) return at('privacy');
  if (rest.startsWith('/terms')) return at('terms');
  if (rest.startsWith('/donate')) return at('donate');
  if (rest.startsWith('/changelogs')) return at('changelogs');
  if (rest.startsWith('/account')) return at('account');
  if (rest.startsWith('/admin')) return at('admin');
  // /play (a live game) can't be restored without a session ⇒ home
  return at('home');
}

/**
 * Parse a full URL into the game + screen. A leading /decode or /chain segment
 * selects the game; an unprefixed (legacy) path falls back to `fallbackGame`.
 */
function parsePath(pathname: string, fallbackGame: GameId): { game: GameId; screen: Screen } & RouteArgs {
  const gm = pathname.match(/^\/(decode|chain)(?=\/|$)/);
  const game: GameId = gm ? (gm[1] as GameId) : fallbackGame;
  const rest = gm ? pathname.slice(gm[0].length) || '/' : pathname;
  return { game, ...parseScreen(rest) };
}

/** which rail/menu entry lights up for a given screen */
function navFor(screen: Screen): ShellNav {
  switch (screen) {
    case 'modes':
    case 'game':
    case 'lobby':
    case 'record':
    case 'duorecord':
    case 'matchmaking':
    case 'watch':
      return 'play';
    case 'configure':
      return 'configure';
    case 'records':
      return 'records';
    case 'account':
      return 'profile';
    case 'admin':
      return 'admin';
    default:
      return 'home';
  }
}

/** the landing route for each top-level destination */
function screenForNav(n: ShellNav): Screen {
  switch (n) {
    case 'home':
      return 'home';
    case 'play':
      return 'modes';
    case 'configure':
      return 'configure';
    case 'records':
      return 'records';
    case 'profile':
      return 'account';
    case 'admin':
      return 'admin';
  }
}

export function App() {
  // the URL is game-prefixed, so a deep load/refresh onto /chain/... must select
  // that game up front (switchGame swaps in its saved loadout) — do it in the
  // initializer so the very first render is already on the right game.
  const [settings, setSettings] = useState<GameSettings>(() => {
    const s = loadSettings();
    if (isWebHistory) {
      const g = parsePath(window.location.pathname, s.game).game;
      if (g !== s.game) return switchGame(s, g);
    }
    return s;
  });
  const start = isWebHistory
    ? parsePath(window.location.pathname, settings.game)
    : { screen: 'home' as Screen, game: settings.game, ...NO_ARGS };
  const [screen, setScreen] = useState<Screen>(start.screen);
  const [route, setRoute] = useState<RouteArgs>(start);
  const [session, setSession] = useState<NetSession | null>(null);
  // read by the match-found takeover, which must fire on `found` alone — depending on
  // `screen`/`session` directly would re-run it on every navigation instead
  const sessionRef = useRef<NetSession | null>(null);
  const screenRef = useRef<Screen>('home');
  // which flow opened the live session — only 'record' offers an in-game NEW RUN
  const [sessionKind, setSessionKind] = useState<ActiveGameRef['kind'] | null>(null);
  /**
   * Is the live session a CO-OP (duo record) run?
   *
   * Kept apart from `sessionKind`, which is 'record' for both solo and duo — and
   * the two want opposite things from the restart control. A solo run tears itself
   * down and opens a fresh room; a duo run belongs to BOTH drivers, so restarting
   * is a vote and one player must never be able to take it away from the other. Duo
   * previously fell through to the solo path, which sent the presser off to a SOLO
   * record screen and left their partner alone in the run.
   */
  const [sessionCoop, setSessionCoop] = useState(false);
  // a just-played replay to watch in-memory (not yet persisted, so no URL id)
  const [replayObj, setReplayObj] = useState<Replay | null>(null);
  // which robot the WATCHER drove in that replay, so the viewer puts them behind
  // their own driver station instead of whichever alliance is first on the roster
  // (the camera flips a full 180° between alliances — see `replayViewpoint`).
  const [replayRobot, setReplayRobot] = useState<number | null>(null);
  // one-time "this simulation isn't realistic" disclaimer (shown the first time CR is
  // the selected game, on this device; dismissal persists in localStorage)
  const [showChainDisclaimer, setShowChainDisclaimer] = useState(false);
  // launched from Controls: enter Free Drive with the mobile-layout editor already open
  const [editMobileLayout, setEditMobileLayout] = useState(false);

  // kept current every render so the []-deps effects (popstate) read live settings
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // on first load, persist the possibly-URL-switched game and canonicalize the URL
  // so an old unprefixed / cross-game link becomes a proper /<game>/... path.
  useEffect(() => {
    if (!isWebHistory) return;
    saveSettings(settingsRef.current);
    const canonical = pathFor(start.screen, start, settingsRef.current.game);
    if (window.location.pathname !== canonical) window.history.replaceState(null, '', canonical);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // reflect back/forward into state (no push — the URL already changed). A game
  // prefix change (…/decode/… ↔ …/chain/…) swaps the game too.
  useEffect(() => {
    if (!isWebHistory) return;
    const onPop = (): void => {
      const cur = settingsRef.current;
      const s = parsePath(window.location.pathname, cur.game);
      if (s.game !== cur.game) {
        const ns = switchGame(cur, s.game);
        setSettings(ns);
        saveSettings(ns);
      }
      setScreen(s.screen);
      setRoute({ replayId: s.replayId, username: s.username, sub: s.sub });
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // keep <title>/description/canonical/og:url pointed at the CURRENT route. The
  // static tags in index.html describe the homepage (all a social scraper ever
  // gets); this is the rendering-crawler + browser-tab half of the same job.
  useEffect(() => {
    applyRouteMeta(screen, pathFor(screen, route, settings.game), settings.game, ENTRY_HAS_GAME);
  }, [screen, route, settings.game]);

  // surface the one-time Chain Reaction disclaimer the first time CR is selected
  useEffect(() => {
    setShowChainDisclaimer(settings.game === 'chain' && !chainDisclaimerSeen());
  }, [settings.game]);

  /** the single way screens change — updates state AND the URL */
  const navigate = (next: Screen, args: Partial<RouteArgs> = {}): void => {
    const a: RouteArgs = { ...NO_ARGS, ...args };
    setScreen(next);
    setRoute(a);
    if (next !== 'replay') setReplayObj(null); // leaving the viewer drops the in-memory replay
    if (isWebHistory) {
      const path = pathFor(next, a, settingsRef.current.game);
      if (window.location.pathname !== path) window.history.pushState(null, '', path);
    }
  };

  /** open a player's public profile page (/profile/<username>) */
  const openProfile = (username: string): void => navigate('profile', { username });
  const watchReplay = (replayId: string): void => navigate('replay', { replayId });

  // a friend's room invite, waiting to be auto-joined by the Lobby screen it
  // navigates to. One-shot: Lobby clears it once its mount effect consumes it
  // (see `onAutoJoinConsumed`), so a later NORMAL visit to the same screen never
  // re-triggers the join.
  const [pendingAutoJoin, setPendingAutoJoin] = useState<
    { room: string; config: RoomConfig; region?: string } | null
  >(null);
  // a RATED challenge waiting to be queued under its party token. Same one-shot
  // shape as pendingAutoJoin and for the same reason: the Matchmaking screen
  // consumes it on mount, so a later ordinary visit to /ranked is an ordinary
  // ranked queue rather than a resurrected challenge.
  const [pendingChallenge, setPendingChallenge] = useState<PendingChallenge | null>(null);
  const startChallenge = (c: PendingChallenge): void => {
    // A challenge names its own GAME, and the recipient accepts it from wherever
    // they already were — which is not necessarily the same game. Switch before
    // queueing: the matchmaker buckets by game, so a challenge queued under the
    // wrong one can never pair with its other half, and the pair simply waits for
    // each other until they give up.
    selectGame(c.game);
    setPendingChallenge(c);
    navigate('matchmaking');
  };

  /**
   * ACCEPT a challenge. The two rated formats have no room to join — they resolve
   * through the matchmaker — so this is the fork between "open a lobby" and "go
   * wait in the ranked queue under this token". `challengeOf` owns that decision,
   * so the sender's path and this one can't drift into disagreeing about what a
   * format means.
   */
  const onJoinInvite = (invite: RoomInvite): void => {
    const challenge = challengeOf(invite, invite.from.username ?? invite.from.handle ?? '');
    if (challenge) {
      startChallenge(challenge);
      return;
    }
    // Same rule as a rated challenge: the INVITE names the game, and accepting it
    // from the other one would leave the app configured for a game the room isn't
    // playing — right room, wrong robot, wrong field.
    selectGame(invite.game);
    const config: RoomConfig = { kind: invite.kind, game: invite.game };
    if (invite.kind === 'record' && invite.record) config.record = invite.record;
    // GO WHERE THE ROOM IS. A custom code is bare, so a socket opened without the host's
    // region lands on whichever machine is nearest to US — and if the two of us picked
    // different servers, that machine has no such room and cheerfully makes an empty one
    // with the same code. Older invites carry no region and fall back to the old behaviour.
    setPendingAutoJoin({ room: invite.room, config, region: invite.region ?? undefined });
    navigate(invite.kind === 'record' ? 'duorecord' : 'lobby');
  };

  // "Challenge a friend": the invite has already gone out (FriendsProvider) — drop
  // the challenger into the freshly-created room as host, waiting for them to join.
  // Same one-shot pendingAutoJoin the invite-recipient path uses. `kind` picks the
  // destination: a `record` challenge is a duo co-op run, everything else is a
  // custom versus match — mirroring `onJoinInvite`'s routing for the recipient.
  const hostForChallenge = (code: string, game: GameId, kind: RoomKind): void => {
    // the HOST's own region — the same one stamped on the invite that just went out, so
    // both sides are aimed at one machine by construction rather than by agreement
    const region = selectedServer()?.region || undefined;
    if (kind === 'record') {
      setPendingAutoJoin({ room: code, config: { kind: 'record', record: 'duo', game }, region });
      navigate('duorecord');
    } else {
      setPendingAutoJoin({ room: code, config: { kind: 'versus', game }, region });
      navigate('lobby');
    }
  };

  // when signed in, mirror settings to the account (debounced) as well as local
  const [accountUserId, setAccountUserId] = useState<string | null>(null);
  /** sign-in state for the practice-upload flush, which is async and outlives a render */
  const signedInRef = useRef(false);
  /** one flush at a time — a sign-in and a finished run can land together */
  const flushingPractice = useRef(false);
  // the account's PUBLIC display name (the mutable `handle` behind leaderboards and
  // /profile), which is NOT `user.name` — that's the immutable Neon Auth sign-up name.
  // Lifted here so the header pill and the Profile page read the same source; before
  // this, the pill showed the stale auth name forever after a rename.
  // `undefined` = not resolved yet (render nothing rather than flashing the auth name,
  // which would show the very bug this fixes on every page load); `null` = no handle set.
  const [handle, setHandle] = useState<string | null | undefined>(undefined);
  // the signed-in account's own username (for Profile to hide friend/block actions
  // on your own page) — fetched alongside `handle`, same call, just also kept.
  const [viewerUsername, setViewerUsername] = useState<string | null>(null);
  // is this account an admin? (server-authorized against ADMIN_USER_IDS) — gates the
  // Admin entry; the server independently enforces every admin action
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    if (!accountUserId) {
      setIsAdmin(false);
      return;
    }
    let cancelled = false;
    fetchAdminStatus().then((s) => {
      if (!cancelled) setIsAdmin(s.isAdmin);
    });
    return () => {
      cancelled = true;
    };
  }, [accountUserId]);

  // load the account's display handle once per sign-in. Kept out of AccountSync's
  // effect on purpose: that one is guarded by a module-level `syncedUser` so settings
  // are fetched at most once per session (it prevents a remount clobbering unsaved
  // edits), and the handle shouldn't inherit that guard's retry semantics.
  useEffect(() => {
    if (!accountUserId) {
      setHandle(undefined);
      setViewerUsername(null);
      return;
    }
    let cancelled = false;
    fetchProfile(accountUserId)
      .then((p) => {
        if (!cancelled) {
          setHandle(p.handle);
          setViewerUsername(p.username);
        }
      })
      // no game server (or it's asleep) — fall back to the auth name in the pill
      .catch(() => {
        if (!cancelled) setHandle(null);
      });
    return () => {
      cancelled = true;
    };
  }, [accountUserId]);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // restore the player's preferred server region (from local settings, or synced
  // from the account once AccountSync applies it) so every connect uses it
  useEffect(() => {
    if (settings.preferredServerId) setSelectedServer(settings.preferredServerId);
  }, [settings.preferredServerId]);

  const update = (next: GameSettings): void => {
    // keep the legacy audio booleans in step with the volume sliders before this
    // blob reaches localStorage or the account (old clients read only those two)
    const s = syncAudioMirrors(next);
    setSettings(s);
    saveSettings(s);
    if (accountUserId) {
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => void saveAccountSettings(s), 700);
    }
  };

  /**
   * Switch the ACTIVE game (and its saved loadout), safely for a caller that is
   * about to `navigate` in the same tick.
   *
   * `settingsRef.current` is assigned BEFORE `update`, because `update` is a
   * setState that will not have landed by the synchronous `navigate` that follows
   * — and `navigate` builds its URL from the ref. Without it the app switched to
   * Chain Reaction while the address bar still read /decode/…, and since the URL is
   * authoritative for the game on load, a refresh from there landed back in the
   * wrong one. Both callers (the parked-queue takeover and an accepted challenge)
   * are exactly that shape.
   */
  const selectGame = (g: GameId): void => {
    const s = settingsRef.current;
    if (s.game === g) return;
    const next = switchGame(s, g);
    settingsRef.current = next;
    update(next);
  };

  const onSyncUser = useCallback((id: string | null) => setAccountUserId(id), []);
  const onSyncLoad = useCallback((s: GameSettings) => {
    // the URL is authoritative for the ACTIVE game — keep the currently-selected
    // game when the account's saved settings load in, so a /chain deep-link isn't
    // reverted to whatever game the account last saved.
    const g = settingsRef.current.game;
    const next = s.game !== g ? switchGame(s, g) : s;
    setSettings(next);
    saveSettings(next);
  }, []);
  const onSyncSeed = useCallback(() => void saveAccountSettings(settingsRef.current), []);

  // the multiplayer game this browser is currently in (persisted to localStorage), so
  // the player can REJOIN it after navigating away and is stopped from starting a 2nd.
  const [activeGame, setActiveGame] = useState<ActiveGameRef | null>(() => loadActiveGame());
  // A backgrounded ranked search that PAIRED. The match will not wait — the server
  // holds the slot for RANKED_JOIN_GRACE_MS and then forfeits it — so this takes the
  // screen back rather than offering a choice, and a solo run in flight is discarded
  // (deliberate: a practice run is worth less than the rated match it would cost).
  const parkedQueue = useParkedQueue();

  /** enter a networked game: remember it (for rejoin + the single-game guard), then
   * show the game screen. Solo play never calls this (it has no session). */
  const beginSession = (s: NetSession, kind: ActiveGameRef['kind'], coop = false): void => {
    if (s.room && s.clientId) {
      const ref: ActiveGameRef = {
        room: s.room,
        region: s.region,
        clientId: s.clientId,
        start: {
          seed: s.seed,
          setups: s.setups,
          yourRobotId: s.localRobotId,
          game: s.game,
          ranked: s.ranked,
          intros: s.intros,
          region: s.region,
        },
        ranked: s.ranked,
        kind,
        savedAt: Date.now(),
      };
      saveActiveGame(ref);
      setActiveGame(ref);
    }
    setSession(s);
    setSessionKind(kind);
    setSessionCoop(coop);
    navigate('game');
  };

  /** reconnect to and re-enter the match this browser last left (reclaims our held
   * server slot within its reconnect grace; fails cleanly to the "connection lost"
   * panel if the slot is already gone). */
  const rejoinGame = (ref: ActiveGameRef): void => {
    const params: Record<string, string> = { room: ref.room };
    if (ref.region) params.region = ref.region;
    let transport: WebSocketTransport;
    try {
      transport = new WebSocketTransport(gameServerUrlWith(params));
    } catch {
      clearActiveGame();
      setActiveGame(null);
      return;
    }
    // send `rejoin` on the FIRST open (ServerSession only re-sends it on reconnects);
    // the server reattaches our held slot and a snapshot resyncs us
    transport.onOpen(() => transport.send(encodeMsg({ t: 'rejoin', room: ref.room, clientId: ref.clientId })));
    const s = new ServerSession(transport, false, ref.start, ref.clientId, ref.room);
    // A rejoin the server REFUSES (the match ended, the grace lapsed) leaves a record that
    // would keep offering the same dead match every time Home is opened. Forget it as soon
    // as the refusal lands — the session itself already fails hard, and the controller
    // freezes rather than predicting on (see `stepServer`).
    const watch = window.setInterval(() => {
      if (s.status().failed) {
        window.clearInterval(watch);
        clearActiveGame();
        setActiveGame(null);
      }
    }, 400);
    window.setTimeout(() => window.clearInterval(watch), 30_000);
    setSession(s);
    setSessionKind(ref.kind);
    // a duo run rejoined has more than one robot on the roster; a solo one does not
    setSessionCoop(ref.kind === 'record' && (ref.start.setups?.length ?? 1) > 1);
    navigate('game');
  };

  /**
   * SPECTATE a live match read-only. Opens a socket to the room, sends `spectate`,
   * and builds a spectator ServerSession from the `matchStart` the server returns.
   * Never saved as an "active game" (it isn't yours to rejoin).
   *
   * `region` matters for CUSTOM rooms: their codes are bare (no `<region>-` prefix
   * for the proxy to route on), so a socket opened without it lands on whichever
   * machine is nearest to the WATCHER and reports no such room. Callers that
   * already know the host region (the Watch Live cards, a friend's match, the
   * admin list) pass it; the code box looks it up first.
   */
  const spectateRoom = (code: string, region?: string): void => {
    let transport: WebSocketTransport;
    try {
      transport = new WebSocketTransport(
        gameServerUrlWith(region ? { room: code, region } : { room: code }),
      );
    } catch {
      return;
    }
    const lobby = new LobbyClient(transport);
    lobby.on('matchStart', (m) => {
      const s = new ServerSession(transport, false, m, lobby.clientId, code, true);
      setSession(s);
      setSessionKind(null); // spectating — no run of our own to restart
      navigate('game');
    });
    lobby.spectate(code);
  };

  /** Controls → "Customize touch controls": drop into Free Drive with the on-screen
   * layout editor already open, so you position controls on the real field. */
  const editTouchControls = (): void => {
    update({ ...settings, mode: 'free' });
    setEditMobileLayout(true);
    navigate('game');
  };

  /**
   * A SOLO PRACTICE run finished — keep it.
   *
   * DEVICE FIRST, account second, and the order is the point: solo practice is the primary
   * OFFLINE mode and works signed out, so a run that only survived when an upload succeeded
   * would make the offline mode depend on being online. The local copy is what the player
   * watches; the upload is what follows them to another device.
   *
   * The score stored is the NET one — earned minus the fouls this robot itself committed —
   * because that is what a solo run means everywhere else in the app (`recordScore`), and a
   * practice figure that flattered you relative to a record run would be worse than useless
   * for the one thing practice is for.
   */
  const keepPracticeRun = (replay: Replay, result: ReplayResult): void => {
    const alliance = replay.setups[0]?.alliance ?? 'blue';
    const score = recordScore(result, alliance);
    savePracticeRun(replay, { ...result, score: { ...result.score, [alliance]: score } });
    // Do not upload THIS run directly — flush the whole backlog instead, which includes it.
    // One path to the server means a run that failed on its own attempt is retried by the
    // next flush rather than being lost, and it is the same code either way.
    void flushPracticeRuns();
  };

  /**
   * Send every practice run the account does not yet have.
   *
   * The upload is the half that can fail, and for reasons that have nothing to do with the
   * run: signed out when it was played, offline, or — routinely, since the game server is a
   * Fly app that auto-stops when idle — a machine still cold-booting when the match ended.
   * So uploading is not a step in finishing a run, it is a backlog that gets drained whenever
   * draining is possible: after a run, and whenever a session appears.
   *
   * SEQUENTIAL, and it STOPS on the first failure. Ten parallel POSTs at a server that is not
   * answering is ten timeouts and no more information than one; the rest keep their place in
   * the backlog for next time.
   */
  const flushPracticeRuns = async (): Promise<void> => {
    if (!signedInRef.current || flushingPractice.current) return;
    flushingPractice.current = true;
    try {
      for (const meta of pendingPracticeUploads()) {
        const replay = loadPracticeReplay(meta.id);
        if (!replay) continue; // body evicted by the local cap — nothing left to send
        const run = await uploadPracticeRun(replay, meta.score, meta.game);
        if (!run) break;
        markPracticeUploaded(meta.id, run.id);
      }
    } finally {
      flushingPractice.current = false;
    }
  };

  /** RECORD runs: abandon this run and immediately start a fresh one.
   *
   * Deliberately a full teardown + re-entry, NOT an in-place world rebuild. A
   * record run is hosted on the server, so resetting the world client-side leaves
   * the server running the old match: snapshots snap the world back, reconcile
   * replays stale pre-reset inputs, and the robot fights its own prediction —
   * the stuck/jittery drivetrain this feature was pulled for. Re-entering makes a
   * NEW room, which is the same path a first run takes and carries no such risk.
   * RecordRun connects on mount, so this costs one reconnect, not a menu trip.
   */
  const restartRun = (): void => {
    session?.dispose();
    setSession(null);
    setSessionKind(null);
    navigate('record');
  };

  /**
   * TAKEOVER. A parked search paired while the player was elsewhere: pull them onto
   * the matchmaking screen, which adopts the socket and carries on into the
   * pre-match strategy window.
   *
   * It does NOT ask. The server holds the slot for RANKED_JOIN_GRACE_MS and then
   * forfeits it, so a dialog would just be a way to lose the match slowly. Anything
   * in progress is discarded — per the product call, a solo run in flight is worth
   * less than the rated match it would otherwise cost.
   */
  /**
   * Open the matchmaking screen FOR THE PARKED SEARCH, restoring its game first.
   *
   * The parked queue is the authority on which game the match is for, not
   * `settings.game` — the player is free to wander into the other game while
   * waiting, and that is the entire point of parking. Adopting the queue without
   * this switched the app to the CURRENT game: queue Chain Reaction, start a DECODE
   * run, and the takeover came up as DECODE for a Chain Reaction match (wrong
   * ready-up, wrong robot, wrong field). Both ways into the queue screen — the
   * automatic takeover and the bar's View button — go through here.
   */
  const openParkedQueue = (): void => {
    const q = peekQueue();
    if (q) selectGame(q.game);
    navigate('matchmaking');
  };

  useEffect(() => {
    if (!parkedQueue?.found) return;
    if (screenRef.current === 'matchmaking') return; // already there; it will adopt
    sessionRef.current?.dispose();
    setSession(null);
    setSessionKind(null);
    // ABANDON whatever was in flight, for real. A record run is server-hosted, so
    // it leaves behind a rejoin record AND a held server slot; keeping either would
    // have this ranked match refused as a "second game" by the very guards that
    // exist to stop you starting one. The run is discarded by design here — it is
    // worth less than the rated match it would otherwise cost.
    clearActiveGame();
    setActiveGame(null);
    openParkedQueue();
    // `navigate` and the setters are stable for this component's life
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parkedQueue?.found]);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);
  useEffect(() => {
    screenRef.current = screen;
  }, [screen]);

  const exitGame = (): void => {
    setEditMobileLayout(false);
    session?.dispose();
    setSession(null);
    setSessionKind(null);
    setSessionCoop(false);
    // a match that FINISHED (or whose slot is gone) clears its rejoin record in
    // GameView; a mid-match exit keeps it so Home can offer "rejoin your match".
    setActiveGame(loadActiveGame());
    navigate('home');
  };

  // a newer client build shipped while this tab stayed open: prompt to refresh when
  // the player STARTS a run (never mid-run), so they aren't stuck on a stale version
  const newVersion = useNewVersion();
  const [pendingStart, setPendingStart] = useState<(() => void) | null>(null);
  // a scheduled server restart is live (admin notice): don't let anyone START a new
  // game / queue — they'd just get dropped by the restart. People already in a game
  // are untouched (this only guards the start actions). Info notices don't block.
  const notice = useServerNotice();
  // MAINTENANCE LOCKDOWN. The server refuses regardless (that is what makes it a
  // lockdown rather than a suggestion); this stops a player from clicking into an
  // error they could have been told about first. Admins are exempt on both sides.
  const maintenance = usePresence()?.maintenance ?? null;
  const lockedOut = !!maintenance?.biting && !isAdmin;
  const restartPending =
    !!notice && notice.kind === 'restart' && (notice.until === undefined || notice.until > Date.now());
  const [startBlocked, setStartBlocked] = useState(false);
  // set when the player tries to start a new game while one is already in progress —
  // drives the "you have a game in progress" overlay (rejoin or abandon)
  const [blockedByActive, setBlockedByActive] = useState(false);
  // set when a game start is refused because the active custom start pose is illegal
  // for the current chassis (block-and-warn instead of silently snapping at spawn)
  const [badStart, setBadStart] = useState(false);
  // Guards EVERY game entry — local (free/solo) AND server-provided (record, duo,
  // ranked, custom room). Even though the server snaps an illegal pose legal at
  // spawn, the player configured it for a DIFFERENT chassis, so we refuse to start
  // anywhere and send them to fix it rather than relocating their robot silently.
  const guardStart = (go: () => void): void => {
    // start-pose legality, per game: DECODE's G304 setup rules / CR's G04 Lab Area
    const startOk = startSelectionLegal(settings.game, settings.spec, settings.alliance, settings.startPose);
    if (loadActiveGame()) setBlockedByActive(true);
    else if (lockedOut) setStartBlocked(true);
    else if (restartPending) setStartBlocked(true);
    else if (!startOk) setBadStart(true);
    else if (newVersion) setPendingStart(() => go);
    else go();
  };

  /** abandon the in-progress game: forget it locally (its server slot then coasts +
   * drops after the grace) so the player is free to start something new. */
  const abandonActiveGame = (): void => {
    clearActiveGame();
    setActiveGame(null);
    setBlockedByActive(false);
  };

  const multiplayer = gameServerConfigured();
  // ranked needs a real account (ELO/leaderboard). accountUserId is set by
  // AccountSync on sign-in and stays null when auth is off, so signed-out and
  // no-auth builds both lock ranked — custom rooms stay open to everyone.
  const signedIn = accountUserId !== null;
  /**
   * Sign-in resolves ASYNCHRONOUSLY, and practice runs are kept whether or not anyone was
   * signed in when they were played. So the moment an account appears is exactly when the
   * backlog can move — runs from before the session resolved, from a signed-out session, and
   * from any attempt that hit a cold or unreachable server.
   */
  useEffect(() => {
    signedInRef.current = signedIn;
    if (signedIn) void flushPracticeRuns();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn]);

  // Rich-presence heartbeat for the FULL-SCREEN surfaces (game / solo record /
  // ranked queue) that render outside AppShell's FriendsProvider — so friends see
  // "In a match" instead of the caller silently dropping to offline mid-game. The
  // shell screens are heartbeated by the provider's own poll; lobby/duo-record by
  // InviteFlyout. Fire-and-forget: it only records presence, never renders.
  useEffect(() => {
    if (!signedIn) return;
    const full = screen === 'game' || screen === 'record' || screen === 'matchmaking';
    if (!full) return;
    const act: Activity = screen === 'matchmaking' ? 'lobby' : 'match';
    const beat = (): void => {
      if (document.visibilityState === 'visible') void fetchFriends(act, settingsRef.current.game).catch(() => {});
    };
    beat();
    const iv = window.setInterval(beat, 30_000);
    return () => window.clearInterval(iv);
  }, [signedIn, screen]);

  /**
   * Wrap a FULL-SCREEN surface so the "you are still queued" indicator survives it.
   *
   * The bar itself is mounted inside the menu shell, which these screens replace
   * outright — so the moment you started a practice match or a record run, the one
   * thing telling you a ranked search was still live disappeared. That is precisely
   * the situation the background queue exists to create, which made it the worst
   * possible place to hide it. `overlay` renders the compact top chip instead of
   * the bottom bar (see QueueBar).
   */
  const fullScreen = (node: JSX.Element): JSX.Element => (
    <>
      <QueueBar onOpen={openParkedQueue} overlay />
      {node}
    </>
  );

  // full-screen surfaces (outside the shell)
  if (screen === 'game') {
    return fullScreen(
      <GameView
        settings={settings}
        session={session}
        signedIn={signedIn}
        onExit={exitGame}
        onSettingsChange={update}
        editLayout={editMobileLayout}
        onRestartRun={sessionKind === 'record' && !sessionCoop ? restartRun : undefined}
        onWatchReplay={(r) => {
          setReplayObj(r);
          // capture the seat NOW: `session` is torn down on the way out of the game
          setReplayRobot(session?.localRobotId ?? null);
          navigate('replay');
        }}
        onPracticeRun={keepPracticeRun}
      />
    );
  }
  if (screen === 'lobby') {
    const auto = pendingAutoJoin?.config.kind === 'versus' ? pendingAutoJoin : undefined;
    return fullScreen(
      <Lobby
        settings={settings}
        onSettingsChange={update}
        onStart={(s) => beginSession(s, 'custom')}
        onCancel={() => navigate('modes')}
        config={auto?.config}
        signedIn={signedIn}
        autoJoin={auto?.room}
        autoJoinRegion={auto?.region}
        onAutoJoinConsumed={() => setPendingAutoJoin(null)}
        onAcceptChallenge={onJoinInvite}
      />
    );
  }
  if (screen === 'record') {
    return fullScreen(
      <RecordRun
        settings={settings}
        mode="solo"
        onStart={(s) => beginSession(s, 'record')}
        onCancel={() => navigate('modes')}
      />
    );
  }
  if (screen === 'duorecord') {
    const auto = pendingAutoJoin?.config.kind === 'record' ? pendingAutoJoin : undefined;
    return fullScreen(
      <Lobby
        settings={settings}
        onSettingsChange={update}
        config={auto?.config ?? { kind: 'record', record: 'duo' }}
        onStart={(s) => beginSession(s, 'record', true)}
        onCancel={() => navigate('modes')}
        signedIn={signedIn}
        autoJoin={auto?.room}
        autoJoinRegion={auto?.region}
        onAutoJoinConsumed={() => setPendingAutoJoin(null)}
        onAcceptChallenge={onJoinInvite}
      />
    );
  }
  if (screen === 'matchmaking') {
    return (
      <Matchmaking
        settings={settings}
        signedIn={signedIn}
        onStart={(s) => beginSession(s, 'ranked')}
        onCancel={() => navigate('modes')}
        onSignIn={() => navigate('account')}
        onSettingsChange={update}
        challenge={pendingChallenge ?? undefined}
        onChallengeConsumed={() => setPendingChallenge(null)}
      />
    );
  }
  if (screen === 'replay' && (route.replayId || replayObj)) {
    return fullScreen(
      <ReplayView
        replayId={route.replayId ?? undefined}
        preloadReplay={replayObj ?? undefined}
        viewerRobotId={replayObj ? replayRobot : null}
        onClose={() => (replayObj ? navigate('home') : navigate('records'))}
      />
    );
  }

  // shell screens. Signed-in builds fold the region menu INTO the profile
  // avatar's popover (one control, not two) — switching server is still one
  // click away, just behind the avatar instead of permanently taking up bar
  // width. Without auth there's no avatar to hang it on, so it stays a bar-level
  // control next to the plain Settings button, as before.
  const right = authEnabled ? (
    <ProfileMenu
      handle={handle}
      preferredServerId={settings.preferredServerId ?? selectedServerId()}
      onChangeServer={(id) => update({ ...settings, preferredServerId: id })}
      onAccount={() => navigate('account')}
    />
  ) : (
    <>
      <ServerMenu
        value={settings.preferredServerId ?? selectedServerId()}
        onChange={(id) => update({ ...settings, preferredServerId: id })}
      />
      <button className="ds-btn" onClick={() => navigate('account')}>
        Profile
      </button>
    </>
  );

  const configureSection: ConfigureSection = isConfigureSection(route.sub) ? route.sub : 'robot';
  const recordsTab: RecordsTab = isRecordsTab(route.sub) ? route.sub : 'leaderboard';

  return (
    <FriendsProvider
      signedIn={signedIn}
      activity="menu"
      game={settings.game}
      sound={settings.audio.volume.master > 0}
      onHostRoom={hostForChallenge}
      onQueueChallenge={startChallenge}
    >
      {/* the standing "still queued" bar — only appears when a search is PARKED,
          i.e. the player queued and then went somewhere else */}
      <QueueBar onOpen={openParkedQueue} />
      <AppShell
        active={navFor(screen)}
        onNav={(n) => navigate(screenForNav(n))}
        right={right}
        showAdmin={isAdmin}
        showRail={screen !== 'home'}
        onDownload={() => navigate('download')}
        onContributors={() => navigate('contributors')}
        onChangelog={() => navigate('changelogs')}
        onPrivacy={() => navigate('privacy')}
        onTerms={() => navigate('terms')}
        onDonate={() => navigate('donate')}
        signedIn={signedIn}
        onOpenProfile={openProfile}
        onJoinInvite={onJoinInvite}
        onSpectate={spectateRoom}
        myUserId={accountUserId}
        game={settings.game}
      >
      {authEnabled && <AccountSync onUser={onSyncUser} onLoad={onSyncLoad} seed={onSyncSeed} />}
      {authEnabled && <UsernameGate />}

      {screen === 'home' && (
        <HomeMenu
          settings={settings}
          multiplayer={multiplayer}
          onNav={(n) => navigate(screenForNav(n))}
          onGame={(g) => {
            update(switchGame(settings, g));
            if (isWebHistory) {
              const path = pathFor(screen, route, g);
              if (window.location.pathname !== path) window.history.pushState(null, '', path);
            }
          }}
        />
      )}

      {screen === 'modes' && (
        <ModeSelect
          multiplayer={multiplayer}
          signedIn={signedIn}
          activeGame={activeGame ? { kind: activeGame.kind } : null}
          onRejoin={() => {
            const ref = loadActiveGame();
            if (ref) rejoinGame(ref);
            else setActiveGame(null);
          }}
          onFreeDrive={() =>
            guardStart(() => {
              update({ ...settings, mode: 'free' });
              navigate('game');
            })
          }
          onSoloMatch={() =>
            guardStart(() => {
              update({ ...settings, mode: 'match' });
              navigate('game');
            })
          }
          onRecordRun={() => guardStart(() => navigate('record'))}
          onDuoRecord={() => guardStart(() => navigate('duorecord'))}
          onRanked={() => guardStart(() => navigate('matchmaking'))}
          onCustomRoom={() => guardStart(() => navigate('lobby'))}
          onWatch={() => navigate('watch')}
        />
      )}
      {/* one-time "this sim isn't realistic" disclaimer for Chain Reaction */}
      {showChainDisclaimer && (
        <div className="overlay">
          <div className="overlay-panel">
            <h2>About this simulation</h2>
            <p className="ds-sub overlay-sub">
              Chain Reaction is a game for the <b>Unofficial FTC Discord’s CAD Competition</b>.
              This simulator is a rough, for-fun approximation of it. <b>The simulation is
              not realistic</b>, so how robots drive, shoot, and score here shouldn’t drive your
              CAD-competition design decisions. Build for the real game, not for this sim.
            </p>
            {/* SENTENCE CASE, and `.ds-dialog-actions` to drop the all-caps
                tracking with it. These five are SHELL dialogs — the same surface
                as Announcements' "Got it" and every `.ds-btn` around them — not
                the match overlays in GameView, whose caps match the HUD they sit
                on. Shipping `GOT IT` here beside `Got it` there was one word in
                two casings in one shell. */}
            <div className="overlay-buttons ds-dialog-actions">
              <button
                onClick={() => {
                  markChainDisclaimerSeen();
                  setShowChainDisclaimer(false);
                }}
              >
                Got it
              </button>
            </div>
          </div>
        </div>
      )}
      {/* the start guards live here, not on `modes`, because a start can also be
          triggered from a lobby/queue screen that this shell doesn't render */}
      {blockedByActive && (
        <div className="overlay">
          <div className="overlay-panel">
            <h2>You’re already in a game</h2>
            <p className="ds-sub overlay-sub">
              You can only be in one game at a time.
            </p>
            <div className="overlay-buttons ds-dialog-actions">
              <button
                onClick={() => {
                  const ref = loadActiveGame();
                  setBlockedByActive(false);
                  if (ref) rejoinGame(ref);
                  else setActiveGame(null);
                }}
              >
                Rejoin
              </button>
              <button className="ghost" onClick={abandonActiveGame}>
                Abandon
              </button>
            </div>
          </div>
        </div>
      )}
      {badStart && (
        <div className="overlay">
          <div className="overlay-panel">
            <h2>Start position invalid</h2>
            <p className="ds-sub overlay-sub">
              Your saved start position isn’t legal for the selected chassis. Fix it (or pick a
              preset) before starting.
            </p>
            <div className="overlay-buttons ds-dialog-actions">
              <button
                onClick={() => {
                  setBadStart(false);
                  navigate('configure', { sub: 'match' });
                }}
              >
                Fix start position
              </button>
              <button className="ghost" onClick={() => setBadStart(false)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
      {startBlocked && (
        <div className="overlay">
          <div className="overlay-panel">
            <h2>{lockedOut ? 'Down for maintenance' : 'Server restarting soon'}</h2>
            <p className="ds-sub overlay-sub">
              {lockedOut
                ? maintenanceLine(maintenance) ??
                  'DSIM is down for maintenance. New games are paused.'
                : 'Server is restarting shortly. New games are paused for a moment.'}
            </p>
            <div className="overlay-buttons ds-dialog-actions">
              <button onClick={() => setStartBlocked(false)}>OK</button>
            </div>
          </div>
        </div>
      )}
      {pendingStart && (
        <div className="overlay">
          <div className="overlay-panel">
            <h2>Update required</h2>
            <p className="ds-sub overlay-sub">
              A newer version has shipped. Refresh to update before starting.
            </p>
            <div className="overlay-buttons ds-dialog-actions">
              <button onClick={() => window.location.reload()}>Refresh &amp; update</button>
              <button className="ghost" onClick={() => setPendingStart(null)}>
                Not now
              </button>
            </div>
          </div>
        </div>
      )}

      {screen === 'configure' && (
        <Configure
          settings={settings}
          onChange={update}
          section={configureSection}
          onSection={(s) => navigate('configure', { sub: s })}
          onEditTouchControls={editTouchControls}
        />
      )}

      {screen === 'records' && (
        <Records
          tab={recordsTab}
          onTab={(t) => navigate('records', { sub: t })}
          myUserId={accountUserId}
          game={settings.game}
          onWatch={watchReplay}
          onWatchLocal={(r) => {
            // a local practice log has no server id — hand the container straight to the
            // viewer, the same path the just-played run takes off the results screen
            setReplayObj(r);
            setReplayRobot(r.setups[0]?.id ?? null);
            navigate('replay');
          }}
          onOpenProfile={openProfile}
        />
      )}

      {screen === 'profile' && route.username && (
        <Profile
          username={route.username}
          signedIn={signedIn}
          viewerUsername={viewerUsername}
          nav={{ onWatch: watchReplay, onOpenProfile: openProfile }}
        />
      )}
      {screen === 'watch' && <WatchLive onWatch={spectateRoom} onBack={() => navigate('modes')} />}
      {screen === 'download' && <Download />}
      {screen === 'contributors' && <Contributors onOpenProfile={openProfile} />}
      {/* legal pages are public and must stay reachable without an account —
          AdSense review fetches /privacy directly */}
      {screen === 'privacy' && <Privacy />}
      {screen === 'terms' && <Terms />}
      {screen === 'donate' && <Donate signedIn={signedIn} />}
      {screen === 'changelogs' && <Changelog />}
      {screen === 'account' && (
        <Account
          settings={settings}
          onChange={update}
          onHandleSaved={setHandle}
          onDonate={() => navigate('donate')}
        />
      )}
      {screen === 'admin' && isAdmin && <Admin onWatch={spectateRoom} onWatchReplay={watchReplay} />}

      {/* Patch notes / new-season + new-act reveals — shown once on the menu shell,
          never over a live match (the game screen returns before this). Mounted
          LAST on purpose: it renders an overlay, so its position in the tree is
          cosmetically irrelevant but semantically load-bearing — first-in-DOM is
          what a crawler reads as the page's main content, and patch notes were
          winning that slot over the homepage itself. (Fresh visitors never see
          it at all now — see `useAnnouncements`.) */}
      <Announcements muted={settings.audio.volume.master <= 0} />
      </AppShell>
    </FriendsProvider>
  );
}
