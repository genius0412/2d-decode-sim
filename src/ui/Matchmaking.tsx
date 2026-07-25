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
import { usePresence } from './usePresence';
import { useServerNotice } from '../net/notice';
import { APP_NAME } from '../seasons';
import { Logo } from './Logo';
import { useEscape } from './useEscape';

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
}: {
  settings: GameSettings;
  signedIn: boolean;
  onStart: (s: NetSession) => void;
  onCancel: () => void;
  onSignIn: () => void;
  onSettingsChange: (s: GameSettings) => void;
}) {
  const [mode, setMode] = useState<QueueMode>('1v1');
  const [noWiden, setNoWiden] = useState(false);
  const presence = usePresence(); // live queue depths, refreshed while on this screen
  // block queueing while a server restart is scheduled (you'd only get dropped)
  const notice = useServerNotice();
  const restartPending =
    !!notice && notice.kind === 'restart' && (notice.until === undefined || notice.until > Date.now());
  const [searching, setSearching] = useState(false);
  const [queue, setQueue] = useState({ size: 0, need: 2 });
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');
  // set once a paired match opens its pre-match strategy window (see MatchStrategy)
  const [strategy, setStrategy] = useState<StrategyState | null>(null);

  const lobbyRef = useRef<LobbyClient | null>(null);
  const startedRef = useRef(false);
  const assigningRef = useRef(false); // reconnecting from matchmaker → host

  // Esc backs out, same as ← Back — but NOT once a match has paired: MatchStrategy
  // owns the screen then, and its ← Leave forfeits. A stray Esc must not do that.
  useEscape(onCancel, !strategy);

  const teardown = (): void => {
    if (!startedRef.current) {
      lobbyRef.current?.leaveQueue();
      lobbyRef.current?.dispose();
    }
    lobbyRef.current = null;
  };
  useEffect(() => teardown, []); // cleanup on unmount

  useEffect(() => {
    if (!searching) return;
    let t = 0;
    const iv = window.setInterval(() => setElapsed(++t), 1000);
    return () => window.clearInterval(iv);
  }, [searching]);

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

  const find = async (): Promise<void> => {
    if (!gameServerUrl()) {
      setError('The game server isn’t configured.');
      return;
    }
    if (restartPending) {
      setError('Server is restarting shortly — try again in a minute.');
      return;
    }
    setError('');
    setElapsed(0);
    setSearching(true);
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
      onStart(new ServerSession(transport, lobby.isHost(), m, lobby.clientId, 'ranked'));
    });
    // normal path: reconnect to the assigned host region to play
    lobby.on('matchAssigned', (room) => joinAssignedMatch(room));
    lobby.on('error', (msg) => strategyCancelled(msg));
    lobby.on('closed', () => {
      if (!startedRef.current && !assigningRef.current)
        setError('Lost connection to the game server.');
    });
    lobby.queue(mode, playerInfo(), home?.region ?? '', home?.accessMs ?? 0, noWiden, settings.game);
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
    lobby.on('error', (msg) => strategyCancelled(msg));
    lobby.on('closed', () => {
      if (!startedRef.current) strategyCancelled('Lost connection to the match server.');
    });
    lobby.join(room, playerInfo());
  };

  const expand = (): void => lobbyRef.current?.expandSearch();

  const cancel = (): void => {
    teardown();
    setSearching(false);
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
    return page(
      <>
        Finding a <span className="accent">match…</span>
      </>,
      `${mode.toUpperCase()} · ${queue.size}/${queue.need} in queue · ${elapsed}s`,
      <>
        {/* region-local first; widen automatically as you wait, or on demand */}
        {!noWiden && multiServer() && (
          <p className="ds-hint">
            {elapsed < 8 ? 'Searching your region…' : 'Widening search to nearby regions…'}
          </p>
        )}
        {error && <p className="ds-form-err">⚠ {error}</p>}
        <div className="ds-actions">
          {!noWiden && multiServer() && (
            <button className="ds-cta ghost" onClick={expand}>
              EXPAND SEARCH
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
            <b style={{ color: 'var(--ds-ink)' }}>{presence.queues[mode]}</b> waiting in{' '}
            {mode.toUpperCase()} · {presence.queues[mode === '1v1' ? '2v2' : '1v1']} in{' '}
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
      {restartPending && (
        <p className="ds-form-err">⚠ Server is restarting shortly — queueing is paused for a moment.</p>
      )}
      <div className="ds-actions">
        <button className="ds-cta" disabled={restartPending} onClick={() => void find()}>
          FIND MATCH ▶
        </button>
      </div>
    </>,
  );
}
