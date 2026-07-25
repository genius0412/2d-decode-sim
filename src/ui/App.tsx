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
import { FriendsProvider } from './friendsContext';
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
import { gameServerConfigured, setSelectedServer, selectedServerId, gameServerUrlWith } from '../net/env';
import { ServerMenu } from './ServerMenu';
import type { NetSession } from '../net/session';
import { ServerSession } from '../net/serverSession';
import { WebSocketTransport } from '../net/transport';
import { encodeMsg } from '../net/protocol';
import { activeStartLegal } from '../sim/field';
import { loadActiveGame, saveActiveGame, clearActiveGame, type ActiveGameRef } from '../net/activeGame';
import type { Replay } from '../sim/replay';
import { seasonFor, APP_NAME } from '../seasons';
import type { GameId } from '../games/types';
import { chainDisclaimerSeen, markChainDisclaimerSeen } from '../chainDisclaimer';

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
  // which flow opened the live session — only 'record' offers an in-game NEW RUN
  const [sessionKind, setSessionKind] = useState<ActiveGameRef['kind'] | null>(null);
  // a just-played replay to watch in-memory (not yet persisted, so no URL id)
  const [replayObj, setReplayObj] = useState<Replay | null>(null);
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

  // the tab title names the selected game so the two games read as separate apps
  useEffect(() => {
    if (typeof document !== 'undefined') document.title = `${seasonFor(settings.game).name} · ${APP_NAME}`;
  }, [settings.game]);

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
  const [pendingAutoJoin, setPendingAutoJoin] = useState<{ room: string; config: RoomConfig } | null>(
    null,
  );
  const onJoinInvite = (invite: RoomInvite): void => {
    const config: RoomConfig = { kind: invite.kind, game: invite.game };
    if (invite.kind === 'record' && invite.record) config.record = invite.record;
    setPendingAutoJoin({ room: invite.room, config });
    navigate(invite.kind === 'record' ? 'duorecord' : 'lobby');
  };

  // "Challenge a friend": the invite has already gone out (FriendsProvider) — drop
  // the challenger into the freshly-created room as host, waiting for them to join.
  // Same one-shot pendingAutoJoin the invite-recipient path uses. `kind` picks the
  // destination: a `record` challenge is a duo co-op run, everything else is a
  // custom versus match — mirroring `onJoinInvite`'s routing for the recipient.
  const hostForChallenge = (code: string, game: GameId, kind: RoomKind): void => {
    if (kind === 'record') {
      setPendingAutoJoin({ room: code, config: { kind: 'record', record: 'duo', game } });
      navigate('duorecord');
    } else {
      setPendingAutoJoin({ room: code, config: { kind: 'versus', game } });
      navigate('lobby');
    }
  };

  // when signed in, mirror settings to the account (debounced) as well as local
  const [accountUserId, setAccountUserId] = useState<string | null>(null);
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

  /** enter a networked game: remember it (for rejoin + the single-game guard), then
   * show the game screen. Solo play never calls this (it has no session). */
  const beginSession = (s: NetSession, kind: ActiveGameRef['kind']): void => {
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
    setSession(s);
    setSessionKind(ref.kind);
    navigate('game');
  };

  /** SPECTATE a live match read-only. Opens a socket to the room, sends `spectate`,
   * and builds a spectator ServerSession from the `matchStart` the server returns.
   * Never saved as an "active game" (it isn't yours to rejoin). */
  const spectateRoom = (code: string): void => {
    let transport: WebSocketTransport;
    try {
      transport = new WebSocketTransport(gameServerUrlWith({ room: code }));
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

  const exitGame = (): void => {
    setEditMobileLayout(false);
    session?.dispose();
    setSession(null);
    setSessionKind(null);
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
    // start-pose legality is a DECODE (G304) check; other games have no legality yet
    const startOk = settings.game !== 'decode' || activeStartLegal(settings.spec, settings.alliance, settings.startPose);
    if (loadActiveGame()) setBlockedByActive(true);
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

  // full-screen surfaces (outside the shell)
  if (screen === 'game') {
    return (
      <GameView
        settings={settings}
        session={session}
        signedIn={signedIn}
        onExit={exitGame}
        onSettingsChange={update}
        editLayout={editMobileLayout}
        onRestartRun={sessionKind === 'record' ? restartRun : undefined}
        onWatchReplay={(r) => {
          setReplayObj(r);
          navigate('replay');
        }}
      />
    );
  }
  if (screen === 'lobby') {
    const auto = pendingAutoJoin?.config.kind === 'versus' ? pendingAutoJoin : undefined;
    return (
      <Lobby
        settings={settings}
        onSettingsChange={update}
        onStart={(s) => beginSession(s, 'custom')}
        onCancel={() => navigate('modes')}
        config={auto?.config}
        signedIn={signedIn}
        autoJoin={auto?.room}
        onAutoJoinConsumed={() => setPendingAutoJoin(null)}
      />
    );
  }
  if (screen === 'record') {
    return (
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
    return (
      <Lobby
        settings={settings}
        onSettingsChange={update}
        config={auto?.config ?? { kind: 'record', record: 'duo' }}
        onStart={(s) => beginSession(s, 'record')}
        onCancel={() => navigate('modes')}
        signedIn={signedIn}
        autoJoin={auto?.room}
        onAutoJoinConsumed={() => setPendingAutoJoin(null)}
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
      />
    );
  }
  if (screen === 'replay' && (route.replayId || replayObj)) {
    return (
      <ReplayView
        replayId={route.replayId ?? undefined}
        preloadReplay={replayObj ?? undefined}
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
        Settings
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
    >
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
        myUserId={accountUserId}
        game={settings.game}
      >
      {authEnabled && <AccountSync onUser={onSyncUser} onLoad={onSyncLoad} seed={onSyncSeed} />}
      {authEnabled && <UsernameGate />}
      {/* patch notes / new-season + new-act reveals — shown once on the menu shell,
          never over a live match (the game screen returns before this) */}
      <Announcements muted={settings.audio.volume.master <= 0} />

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
            <p className="ds-sub" style={{ margin: '4px auto 16px', maxWidth: 420 }}>
              Chain Reaction is a game for the <b>Unofficial FTC Discord’s CAD Competition</b>.
              This simulator is just a rough, for-fun approximation of it — <b>the simulation is
              not realistic</b>, so how robots drive, shoot, and score here shouldn’t drive your
              CAD-competition design decisions. Build for the real game, not for this sim.
            </p>
            <div className="overlay-buttons">
              <button
                onClick={() => {
                  markChainDisclaimerSeen();
                  setShowChainDisclaimer(false);
                }}
              >
                GOT IT
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
            <p className="ds-sub" style={{ margin: '4px auto 16px', maxWidth: 380 }}>
              You can only be in one game at a time.
            </p>
            <div className="overlay-buttons">
              <button
                onClick={() => {
                  const ref = loadActiveGame();
                  setBlockedByActive(false);
                  if (ref) rejoinGame(ref);
                  else setActiveGame(null);
                }}
              >
                REJOIN
              </button>
              <button className="ghost" onClick={abandonActiveGame}>
                ABANDON
              </button>
            </div>
          </div>
        </div>
      )}
      {badStart && (
        <div className="overlay">
          <div className="overlay-panel">
            <h2>Start position invalid</h2>
            <p className="ds-sub" style={{ margin: '4px auto 16px', maxWidth: 380 }}>
              Your saved start position isn’t legal for the selected chassis. Fix it (or pick a
              preset) before starting.
            </p>
            <div className="overlay-buttons">
              <button
                onClick={() => {
                  setBadStart(false);
                  navigate('configure', { sub: 'match' });
                }}
              >
                FIX START POSITION
              </button>
              <button className="ghost" onClick={() => setBadStart(false)}>
                CANCEL
              </button>
            </div>
          </div>
        </div>
      )}
      {startBlocked && (
        <div className="overlay">
          <div className="overlay-panel">
            <h2>Server restarting soon</h2>
            <p className="ds-sub" style={{ margin: '4px auto 16px', maxWidth: 380 }}>
              A scheduled server update is about to happen, so new games are paused for a moment.
            </p>
            <div className="overlay-buttons">
              <button onClick={() => setStartBlocked(false)}>OK</button>
            </div>
          </div>
        </div>
      )}
      {pendingStart && (
        <div className="overlay">
          <div className="overlay-panel">
            <h2>Update required</h2>
            <p className="ds-sub" style={{ margin: '4px auto 16px', maxWidth: 380 }}>
              A newer version has shipped. Refresh to update before starting.
            </p>
            <div className="overlay-buttons">
              <button onClick={() => window.location.reload()}>REFRESH &amp; UPDATE</button>
              <button className="ghost" onClick={() => setPendingStart(null)}>
                NOT NOW
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
      {screen === 'admin' && isAdmin && <Admin />}
      </AppShell>
    </FriendsProvider>
  );
}
