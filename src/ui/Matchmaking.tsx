import { useEffect, useRef, useState } from 'react';
import type { GameSettings } from '../game';
import { gameServerUrl, gameServerUrlWith, gameServerHttpUrl, multiServer } from '../net/env';
import { probeHome } from '../net/ping';
import { WebSocketTransport } from '../net/transport';
import { LobbyClient, type MatchStart } from '../net/lobbyClient';
import { ServerSession } from '../net/serverSession';
import type { NetSession } from '../net/session';
import type { LobbyPlayer, PlayerIntro, QueueMode } from '../net/protocol';
import { MatchStrategy } from './MatchStrategy';
import { MatchAudio } from '../audio';
import { DODGE_REASON, type DodgeVerdict } from '../dodge';
import { STANDING_MAX, STANDING_WINDOW_HOURS, lockRemaining, tierOf } from '../standing';
import { expandLabel, widenHint, queuesFor } from './queueDepth';
import { parkQueue, takeQueue, updateQueue, dropQueue, elapsedSeconds, type ParkedQueue } from './queueKeeper';
import { usePresence } from './usePresence';
import { useServerNotice } from '../net/notice';
import { APP_NAME } from '../seasons';
import { Logo } from './Logo';
import { useEscape } from './useEscape';
import { formatLabel, type PendingChallenge } from './challenge';

/**
 * Region-aware ranked matchmaking. We connect to the DESIGNATED matchmaker (a
 * `?mm=1` connection Fly routes to one region), report our home region + access
 * latency, and queue. Matchmaking is region-local first and WIDENS over time (or on
 * "Expand search"). On a match the server sends `matchAssigned` with a region-coded
 * room; we drop this socket and reconnect to `?room=…` (routed to the fair host
 * region) to actually play. On a single-region / no-DB dev server the server instead
 * sends `matchStart` straight back on this socket (handled too). ELO is applied
 * server-side on match end.
 */
/** the pre-match strategy window state, once a paired match opens one */
interface StrategyState {
  lobby: LobbyClient;
  players: LobbyPlayer[];
  myClientId: string;
  deadline: number;
  mode: QueueMode;
  intros: PlayerIntro[];
}

export function Matchmaking({
  settings,
  signedIn,
  onStart,
  onCancel,
  onSignIn,
  onSettingsChange,
  challenge,
  onChallengeConsumed,
}: {
  settings: GameSettings;
  signedIn: boolean;
  onStart: (s: NetSession) => void;
  onCancel: () => void;
  onSignIn: () => void;
  onSettingsChange: (s: GameSettings) => void;
  /** arrived here from a RATED "play a friend" challenge: queue under its token
   * immediately instead of showing the mode picker */
  challenge?: PendingChallenge;
  /** one-shot: clear it so a later ordinary visit to /ranked is an ordinary queue */
  onChallengeConsumed?: () => void;
}) {
  // a challenge dictates the bucket — you agreed on a format, there is nothing
  // left to pick
  const [mode, setMode] = useState<QueueMode>(challenge?.mode ?? '1v1');
  const [noWiden, setNoWiden] = useState(false);
  // Live queue depths, refreshed while on this screen. `full` because THIS is the
  // screen where the number decides something: you read "3 waiting in 1v1" and
  // queue on the strength of it, so it gets an uncached read rather than the
  // ambient chip's up-to-a-minute-old one.
  const presence = usePresence(8000, true);
  // depth for THIS game only — see the note where it renders
  const depth = queuesFor(presence, settings.game) ?? { '1v1': 0, '2v2': 0 };
  // block queueing while a server restart is scheduled (you'd only get dropped)
  const notice = useServerNotice();
  const restartPending =
    !!notice && notice.kind === 'restart' && (notice.until === undefined || notice.until > Date.now());
  const [searching, setSearching] = useState(false);
  const [queue, setQueue] = useState({ size: 0, need: 2 });
  /** manual EXPAND SEARCH presses this search — shown so the button visibly does
   *  something. The server keeps its own count (`expandBumps`); this is only the
   *  local echo of it, and it is reset with every new search. */
  const [bumps, setBumps] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');
  /** what a cancelled ranked pairing cost — shown next to the cancellation itself, because
   *  a rating drop the player is not told about is the thing that makes a penalty feel
   *  arbitrary. `null` for a player who was NOT at fault, which is worth saying out loud. */
  const [dodge, setDodge] = useState<{ yours: DodgeVerdict | null; others: DodgeVerdict[] } | null>(null);
  // the ranked queue refused us on ACCOUNT STANDING (a live clock, so `tick` re-renders it)
  const [lock, setLock] = useState<{ until: number; score: number } | null>(null);
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    if (!lock || lock.until <= tick) return;
    const id = window.setInterval(() => setTick(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [lock, tick]);
  // set once a paired match opens its pre-match strategy window (see MatchStrategy)
  const [strategy, setStrategy] = useState<StrategyState | null>(null);

  const lobbyRef = useRef<LobbyClient | null>(null);
  // The unmount cleanup runs with the closure from the FIRST render, so anything it
  // needs has to be a ref rather than state — these mirror `searching`/`mode`/`queue`
  // purely so `teardown` reads what is true NOW instead of what was true on mount.
  const searchingRef = useRef(false);
  const modeRef = useRef<QueueMode>(challenge?.mode ?? '1v1');
  const queueRef = useRef({ size: 0, need: 2 });
  const gameRef = useRef(settings.game);
  const startedAtRef = useRef(0);
  const startedRef = useRef(false);
  const assigningRef = useRef(false); // reconnecting from matchmaker → host
  // The challenge is captured ONCE, in a ref. App clears its copy the moment this
  // screen consumes it (so /ranked doesn't resurrect it on a later visit), and a
  // prop that vanishes mid-search would otherwise silently turn a private
  // challenge into an open queue entry on any reconnect.
  const challengeRef = useRef<PendingChallenge | null>(challenge ?? null);

  // Esc backs out, same as ← Back — but NOT once a match has paired: MatchStrategy
  // owns the screen then, and its ← Leave forfeits. A stray Esc must not do that.
  useEscape(onCancel, !strategy);

  const teardown = (): void => {
    const lobby = lobbyRef.current;
    lobbyRef.current = null;
    if (startedRef.current || !lobby) return;
    // BACKGROUND QUEUE: a search in flight is handed to the keeper instead of being
    // dropped, so leaving this screen no longer cancels it. Only the LIFETIME
    // changes here — the socket, the queue message and the match hand-off are all
    // untouched, which is what keeps the blast radius small on a path that costs
    // real ELO when it goes wrong.
    //
    // Two cases still tear down for real rather than park: a match that has already
    // STARTED (the session owns the transport now) and a reconnect to the assigned
    // host region already in flight (`assigning`) — parking either would leave a
    // socket nobody is going to come back for.
    if (searchingRef.current && !assigningRef.current) {
      const parkedState: ParkedQueue = {
        lobby,
        mode: challengeRef.current?.mode ?? modeRef.current,
        // the game this search was QUEUED for, not the one the player wanders into
        game: challengeRef.current?.game ?? gameRef.current,
        // a private challenge stays a private challenge across a park/adopt
        challenge: challengeRef.current,
        since: startedAtRef.current,
        size: queueRef.current.size,
        need: queueRef.current.need,
        assignedRoom: null,
        start: null,
        strategy: null,
        found: false,
        error: null,
      };
      // REBIND to keeper-owned handlers: the ones registered below close over this
      // component's state, and calling them after unmount would write into a tree
      // that is gone. `on()` replaces, so this is a straight hand-over.
      //
      // Each "found" handler RECORDS ITS PAYLOAD, not just the fact of it. These
      // events fire exactly once; the screen that adopts the socket arrives after
      // they are gone, so anything dropped here is unrecoverable and the player
      // waits forever on a match that has already started.
      lobby.on('queued', (_m, size, need) => updateQueue({ size, need }));
      lobby.on('matchAssigned', (room) => {
        matchFound();
        updateQueue({ assignedRoom: room, found: true });
      });
      lobby.on('matchStart', (m) => {
        matchFound();
        updateQueue({ start: m, found: true });
      });
      lobby.on('strategyStart', (deadline, yourRobotId, m, intros) => {
        matchFound();
        updateQueue({
          strategy: { deadline, yourRobotId, mode: m, intros, players: lobby.players, myClientId: lobby.clientId },
          found: true,
        });
      });
      lobby.on('error', (msg) => updateQueue({ error: msg }));
      lobby.on('closed', () => updateQueue({ error: 'Lost connection to the game server.' }));
      parkQueue(parkedState);
      return;
    }
    lobby.leaveQueue();
    lobby.dispose();
  };
  useEffect(() => teardown, []); // cleanup on unmount

  useEffect(() => {
    searchingRef.current = searching;
  }, [searching]);
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);
  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);
  useEffect(() => {
    gameRef.current = settings.game;
  }, [settings.game]);

  // The stopwatch is DERIVED from when the search actually began, never counted up
  // from when this screen mounted. Adopting a parked queue re-enters this effect,
  // and a local counter restarted at 0 there — so leaving and coming back reset a
  // wait the player had genuinely been sitting through. `startedAtRef` is the
  // keeper's `since` on that path, so the two agree by construction.
  useEffect(() => {
    if (!searching) return;
    // 0 is the ref's "no search has started" value, not a 1970 timestamp
    const paint = (): void =>
      setElapsed(startedAtRef.current ? elapsedSeconds(startedAtRef.current) : 0);
    paint(); // show the real figure now, not a second from now
    const iv = window.setInterval(paint, 1000);
    return () => window.clearInterval(iv);
  }, [searching]);

  /**
   * ADOPT a search that was running while this screen was away.
   *
   * Runs BEFORE the challenge auto-queue below, and returning true suppresses it:
   * a parked queue means we are already in the bucket, and queueing again would put
   * a second entry in for the same player.
   */
  const adoptParked = (): boolean => {
    const p = takeQueue();
    if (!p) return false;
    const lobby = p.lobby;
    lobbyRef.current = lobby;
    setMode(p.mode);
    modeRef.current = p.mode;
    // a parked private challenge is still a private challenge on the way back in
    challengeRef.current = p.challenge;
    setQueue({ size: p.size, need: p.need });
    queueRef.current = { size: p.size, need: p.need };
    startedAtRef.current = p.since;
    setSearching(true);
    searchingRef.current = true;
    if (p.error) setError(p.error);
    // take the handlers back off the keeper
    lobby.on('queued', (_m, size, need) => setQueue({ size, need }));
    wireStrategy(lobby);
    lobby.on('matchStart', (m: MatchStart) => {
      startedRef.current = true;
      matchFound();
      onStart(new ServerSession(lobby.transport, lobby.isHost(), m, lobby.clientId, 'ranked'));
    });
    lobby.on('matchAssigned', (room) => {
      matchFound();
      joinAssignedMatch(room);
    });
    lobby.on('dodgeVerdict', (yours, others) => setDodge({ yours, others }));
    lobby.on('standingLock', (until, score) => { setLock({ until, score }); setSearching(false); });
    lobby.on('error', (msg) => strategyCancelled(msg));
    lobby.on('closed', () => {
      if (!startedRef.current && !assigningRef.current)
        setError('Lost connection to the game server.');
    });
    // REPLAY whatever landed WHILE PARKED. These events have already fired and will
    // not fire again for the handlers just registered above, so acting on the
    // recorded payload is the only way the adopted screen ever learns about them.
    // Ordered most-progressed first: a match that has actually STARTED supersedes
    // the strategy window that preceded it, which supersedes a bare assignment.
    if (p.start) {
      startedRef.current = true;
      onStart(new ServerSession(lobby.transport, lobby.isHost(), p.start, lobby.clientId, 'ranked'));
    } else if (p.strategy) {
      const s = p.strategy;
      setStrategy({
        lobby,
        players: s.players.length ? s.players : lobby.players,
        myClientId: s.myClientId || lobby.clientId,
        deadline: s.deadline,
        mode: s.mode,
        intros: s.intros,
      });
    } else if (p.assignedRoom) {
      joinAssignedMatch(p.assignedRoom);
    }
    return true;
  };

  // Arriving from a challenge, there is nothing to choose and nothing to confirm —
  // both sides already agreed on the format, and whoever gets here first is
  // waiting on the other. So queue on mount rather than showing a FIND MATCH
  // button they'd have to press to start waiting.
  useEffect(() => {
    if (adoptParked()) return; // already in the queue — do not enter it twice
    if (!challengeRef.current || !signedIn) return;
    onChallengeConsumed?.();
    void find();
    // mount only: `find` closes over state that is stable for this screen's life,
    // and re-running would double-queue
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** "your match is ready" chime. Its own MatchAudio because the game controller is
   *  not up yet on this screen, and a ref-guard so a search fires it exactly once —
   *  `matchAssigned` and `strategyStart` are both "found" signals and on the
   *  single-region path both can arrive. */
  const alertRef = useRef<MatchAudio | null>(null);
  const alertedRef = useRef(false);
  const matchFound = (): void => {
    if (alertedRef.current) return;
    alertedRef.current = true;
    alertRef.current ??= new MatchAudio();
    const a = alertRef.current;
    a.masterVolume = settings.audio.volume.master;
    a.alertVolume = settings.audio.volume.alert;
    a.sfxMatchFound();
  };

  const playerInfo = () => ({
    name: settings.spec.teamName || 'Player',
    teamName: settings.spec.teamName,
    teamNumber: settings.spec.teamNumber,
    alliance: 'red' as const, // matchmaking assigns the real alliance
    startIndex: settings.startIndex,
    startPose: settings.startPose ?? null,
    ready: false, // the pre-match strategy screen owns readiness now
    spec: settings.spec,
    assists: settings.assists,
  });

  /** attach the pre-match strategy handlers to a lobby socket (dev mm-socket path
   * AND the production reconnected host-room path both open a strategy window). */
  const wireStrategy = (lobby: LobbyClient): void => {
    lobby.on('roster', (players) =>
      setStrategy((s) => (s ? { ...s, players, myClientId: lobby.clientId } : s)),
    );
    lobby.on('strategyStart', (deadline, _yourRobotId, m, intros) =>
      setStrategy({
        lobby,
        players: lobby.players,
        myClientId: lobby.clientId,
        deadline,
        mode: m,
        intros,
      }),
    );
  };

  /** a cancel/close arrived (deadline lapsed, opponent left): drop the strategy
   * screen back to the queue with the reason shown. */
  const strategyCancelled = (msg: string): void => {
    setStrategy(null);
    setSearching(false);
    setError(msg);
  };

  /** the cancellation notice: WHY it died and what it cost you. Rendered next to every
   *  error slot, so it appears wherever the cancel surfaces. */
  const dodgeNote = (): JSX.Element | null => {
    if (!dodge) return null;
    const y = dodge.yours;
    if (y?.kind) {
      const st = y.standing;
      const nth = y.count === 1 ? 'first' : y.count === 2 ? 'second' : `${y.count}th`;
      return (
        <div className="ds-dodge charged">
          {/* STANDING, not rating — and the number is the headline because it is the thing
              that actually changed. A dodge only ever reaches the rating after a warning and
              two cooldowns have been ignored, and when it does, it is said plainly. */}
          <b>
            {st ? `−${st.points} standing · ${st.scoreBefore} → ${st.scoreAfter}` : 'Match cancelled'}
            {st && st.ratingCharge > 0 && ` · −${st.ratingCharge} rating`}
          </b>
          <span>
            You {DODGE_REASON[y.kind]}. That is your {nth} in {STANDING_WINDOW_HOURS} hours
            {st && st.cooldownMin > 0
              ? ` — ranked is locked for ${st.cooldownMin >= 60 ? `${Math.round(st.cooldownMin / 60)}h` : `${st.cooldownMin} minutes`}.`
              : ' — repeats cost more, and enough of them start locking the queue.'}
          </span>
          {st && (
            <span className="ds-muted">
              Account standing: {tierOf(st.scoreAfter).name.toLowerCase()}. Finishing matches earns it back.
            </span>
          )}
        </div>
      );
    }
    const who = dodge.others.filter((o) => o.kind).length;
    return (
      <div className="ds-dodge clear">
        <b>Nothing was charged to you</b>
        <span>
          {who > 0
            ? `${who === 1 ? 'A player' : `${who} players`} didn’t make it to the match. You were ready — this one is on them.`
            : 'The match was cancelled before it started.'}
        </span>
      </div>
    );
  };

  /** RANKED IS LOCKED: the queue refused this account because its standing carries a
   *  cooldown. Its own notice rather than an error string — a lock has a clock, so it counts
   *  down and the button comes back on its own. */
  const lockNote = (): JSX.Element | null => {
    if (!lock || lock.until <= tick) return null;
    return (
      <div className="ds-dodge charged">
        <b>Ranked is locked for {lockRemaining(lock.until, tick)}</b>
        <span>
          Your account standing is {tierOf(lock.score).name.toLowerCase()} ({lock.score}/{STANDING_MAX}).{' '}
          {tierOf(lock.score).blurb}
        </span>
        <span className="ds-muted">
          Custom rooms and solo practice are unaffected — and finishing matches you start is what earns it back.
        </span>
      </div>
    );
  };

  const find = async (): Promise<void> => {
    if (!gameServerUrl()) {
      setError('The game server isn’t configured.');
      return;
    }
    if (restartPending) {
      setError('Server is restarting shortly - try again in a minute.');
      return;
    }
    setError('');
    setElapsed(0);
    setBumps(0);
    alertedRef.current = false;
    startedAtRef.current = Date.now();
    setSearching(true);
    searchingRef.current = true;
    // measure our home region + access latency (best-effort — the matchmaker falls
    // back to its own region if we can't report one)
    const home = await probeHome(gameServerHttpUrl());
    let transport: WebSocketTransport;
    try {
      transport = new WebSocketTransport(gameServerUrlWith({ mm: '1' }));
    } catch {
      setError('Could not reach the game server.');
      setSearching(false);
      return;
    }
    const lobby = new LobbyClient(transport);
    lobbyRef.current = lobby;
    lobby.on('queued', (_m, size, need) => setQueue({ size, need }));
    // dev / single-region / no-DB: the strategy window + match run on this same socket
    wireStrategy(lobby);
    lobby.on('matchStart', (m: MatchStart) => {
      startedRef.current = true;
      matchFound();
      onStart(new ServerSession(transport, lobby.isHost(), m, lobby.clientId, 'ranked'));
    });
    // normal path: reconnect to the assigned host region to play
    lobby.on('matchAssigned', (room) => {
      matchFound();
      joinAssignedMatch(room);
    });
    lobby.on('dodgeVerdict', (yours, others) => setDodge({ yours, others }));
    lobby.on('standingLock', (until, score) => { setLock({ until, score }); setSearching(false); });
    lobby.on('error', (msg) => strategyCancelled(msg));
    lobby.on('closed', () => {
      if (!startedRef.current && !assigningRef.current)
        setError('Lost connection to the game server.');
    });
    lobby.queue(
      // a challenge fixes the bucket, and it must win over `mode` state: the auto-
      // start below fires from a mount effect, where a setState in the same tick
      // would not have landed yet
      challengeRef.current?.mode ?? mode,
      playerInfo(),
      home?.region ?? '',
      home?.accessMs ?? 0,
      noWiden,
      // THE CHALLENGE'S GAME, not the one this client happens to be sitting in.
      // The matchmaker buckets by game (a CR queuer must never pair into a DECODE
      // room), and a challenge is accepted from wherever the recipient already is
      // — so queueing under `settings.game` put the two halves of one challenge in
      // two different buckets whenever the friends were on different games. The
      // closed pair then waits for each other forever: `findMatch` requires a
      // single bucket, so it can never stage, and neither side is ever told why.
      challengeRef.current?.game ?? settings.game,
      challengeRef.current
        ? {
            token: challengeRef.current.token,
            format: challengeRef.current.format,
            partyOnly: challengeRef.current.partyOnly,
          }
        : undefined,
    );
  };

  /** a ranked match was assigned: drop the matchmaker socket and open a fresh one to
   * the region-coded room (fly-replay routes it to the fair host region). */
  const joinAssignedMatch = (room: string): void => {
    assigningRef.current = true;
    lobbyRef.current?.dispose();
    let transport: WebSocketTransport;
    try {
      transport = new WebSocketTransport(gameServerUrlWith({ room }));
    } catch {
      setError('Could not reach the match server.');
      return;
    }
    const lobby = new LobbyClient(transport);
    lobbyRef.current = lobby;
    wireStrategy(lobby);
    lobby.on('matchStart', (m: MatchStart) => {
      startedRef.current = true;
      onStart(new ServerSession(transport, lobby.isHost(), m, lobby.clientId, room));
    });
    lobby.on('dodgeVerdict', (yours, others) => setDodge({ yours, others }));
    lobby.on('standingLock', (until, score) => { setLock({ until, score }); setSearching(false); });
    lobby.on('error', (msg) => strategyCancelled(msg));
    lobby.on('closed', () => {
      if (!startedRef.current) strategyCancelled('Lost connection to the match server.');
    });
    lobby.join(room, playerInfo());
  };

  /**
   * Widen one step NOW rather than waiting for the next automatic one.
   *
   * The server call was already here; what was missing was any sign it happened.
   * The button fired `expandSearch()` and nothing on screen moved — no counter, no
   * text change — so it read as dead, and the natural response is to press it
   * repeatedly. Tracking the presses locally is enough to say so out loud.
   */
  const expand = (): void => {
    if (!lobbyRef.current) return;
    lobbyRef.current.expandSearch();
    setBumps((n) => n + 1);
  };

  const cancel = (): void => {
    // explicit cancel is NOT a park: pressing cancel means leave the queue, so drop
    // the search here rather than letting `teardown` hand it to the keeper
    searchingRef.current = false;
    teardown();
    dropQueue();
    setSearching(false);
    // dropping out of a challenge leaves you on the ordinary ranked screen, not in
    // a state where FIND MATCH would silently re-enter the private queue
    challengeRef.current = null;
  };

  /** the console scaffold every full-screen setup surface shares (Lobby, Record
   * Run, MatchStrategy) — back control + brand mark, then a titled panel. */
  const page = (title: JSX.Element, sub: string, body: JSX.Element): JSX.Element => (
    <div className="ds-console">
      <div className="ds-console-in" style={{ maxWidth: 520 }}>
        <div className="ds-head">
          <button className="ds-back" onClick={onCancel}>
            ← Back
          </button>
          <span className="ds-mark">
            <Logo size={24} />
            {APP_NAME}
          </span>
        </div>
        <div className="ds-title">
          <h1>{title}</h1>
        </div>
        {sub && (
          <p className="ds-sub" style={{ marginTop: -10 }}>
            {sub}
          </p>
        )}
        <div className="ds-panelbox">{body}</div>
      </div>
    </div>
  );

  // ranked requires an account (ELO / leaderboard). Custom rooms stay open to
  // everyone — the server also rejects an anonymous queue as a backstop.
  if (!signedIn) {
    return page(
      <>
        Ranked <span className="accent">Match</span>
      </>,
      '',
      <>
        <p className="ds-hint">
          Ranked needs an account. Custom Rooms are open to everyone.
        </p>
        <div className="ds-actions">
          <button className="ds-cta" onClick={onSignIn}>
            SIGN IN ▶
          </button>
        </div>
      </>,
    );
  }

  // a paired match opened its pre-match strategy window: take over the whole screen
  if (strategy) {
    return (
      <MatchStrategy
        lobby={strategy.lobby}
        players={strategy.players}
        myClientId={strategy.myClientId}
        deadline={strategy.deadline}
        mode={strategy.mode}
        intros={strategy.intros}
        settings={settings}
        onSettingsChange={onSettingsChange}
        onLeave={() => {
          teardown();
          setStrategy(null);
          setSearching(false);
        }}
      />
    );
  }

  if (searching) {
    const ch = challengeRef.current;
    // A challenge is not a search — you are waiting for one named person, and the
    // region-widening controls have nothing to widen toward (a closed party skips
    // the radius entirely, server-side). Saying "finding a match" here would
    // describe something that isn't happening.
    if (ch) {
      return page(
        <>
          Waiting for <span className="accent">@{ch.opponent}</span>
        </>,
        // a closed pair has no queue to report a depth for; a premade genuinely is
        // in the open 2v2 pool once both have accepted, so show it
        ch.partyOnly
          ? `${formatLabel(ch.format)} · ${elapsed}s`
          : `${formatLabel(ch.format)} · ${queue.size}/${queue.need} in queue · ${elapsed}s`,
        <>
          <p className="ds-hint">
            {ch.partyOnly
              ? 'They start the moment they accept. This match counts for ELO.'
              : 'Once they accept, you queue together as a team.'}
          </p>
          {/* the wait here is somebody else's response time, so it is the screen
              MOST worth telling people they can leave */}
          <p className="ds-tip">
            <b>Tip:</b> press <b>← Back</b> and keep playing — you stay in the queue, and
            we’ll pull you in the moment they accept.
          </p>
          {error && <p className="ds-form-err">⚠ {error}</p>}
          {dodgeNote()}
          {lockNote()}
          <div className="ds-actions">
            <button className="ds-cta ghost" onClick={cancel}>
              CANCEL
            </button>
          </div>
        </>,
      );
    }
    return page(
      <>
        Finding a <span className="accent">match…</span>
      </>,
      `${mode.toUpperCase()} · ${queue.size}/${queue.need} in queue · ${elapsed}s`,
      <>
        {/* region-local first; widen automatically as you wait, or on demand */}
        {!noWiden && multiServer() && (
          <p className="ds-hint">
            {widenHint(bumps, elapsed)}
          </p>
        )}
        <p className="ds-tip">
          <b>Tip:</b> press <b>← Back</b> and keep playing — your place in the queue is
          kept, and we’ll pull you into the match the moment it’s found.
        </p>
        {error && <p className="ds-form-err">⚠ {error}</p>}
          {dodgeNote()}
          {lockNote()}
        <div className="ds-actions">
          {!noWiden && multiServer() && (
            <button className="ds-cta ghost" onClick={expand}>
              {expandLabel(bumps)}
            </button>
          )}
          <button className="ds-cta ghost" onClick={cancel}>
            CANCEL
          </button>
        </div>
      </>,
    );
  }

  return page(
    <>
      Ranked <span className="accent">Match</span>
    </>,
    '',
    <>
      <div className="ds-opts two">
        <button className={`ds-opt ${mode === '1v1' ? 'on' : ''}`} onClick={() => setMode('1v1')}>
          <span className="ot">1v1</span>
        </button>
        <button className={`ds-opt ${mode === '2v2' ? 'on' : ''}`} onClick={() => setMode('2v2')}>
          <span className="ot">2v2</span>
        </button>
      </div>
      <p className="ds-hint">
        {presence ? (
          <>
            {/* THIS GAME's depth. A combined count named people you cannot be paired
                with — the matchmaker buckets by game — which made the number an
                argument for queueing into a pool that, for you, was empty. */}
            <b style={{ color: 'var(--ds-ink)' }}>{depth[mode]}</b> waiting in{' '}
            {mode.toUpperCase()} · {depth[mode === '1v1' ? '2v2' : '1v1']} in{' '}
            {(mode === '1v1' ? '2v2' : '1v1').toUpperCase()} · {presence.online} online
          </>
        ) : (
          'Checking who’s online…'
        )}
      </p>
      {multiServer() && (
        <div className="ds-opts">
          <button className={`ds-opt ${noWiden ? 'on' : ''}`} onClick={() => setNoWiden(!noWiden)}>
            <span className="ot">Only my region {noWiden ? 'ON' : 'OFF'}</span>
          </button>
        </div>
      )}
      {error && <p className="ds-form-err">⚠ {error}</p>}
          {dodgeNote()}
          {lockNote()}
      {restartPending && (
        <p className="ds-form-err">⚠ Server is restarting shortly - queueing is paused for a moment.</p>
      )}
      <div className="ds-actions">
        <button className="ds-cta" disabled={restartPending} onClick={() => void find()}>
          FIND MATCH ▶
        </button>
      </div>
    </>,
  );
}
