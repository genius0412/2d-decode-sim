import { useEffect, useRef, useState } from 'react';
import type { GameSettings } from '../game';
import { gameServerUrl, gameServerUrlWith, multiServer, selectedServer } from '../net/env';
import { WebSocketTransport } from '../net/transport';
import { LobbyClient, type MatchStart } from '../net/lobbyClient';
import { ServerSession } from '../net/serverSession';
import type { NetSession } from '../net/session';
import type { RecordKind } from '../net/protocol';
import { APP_NAME } from '../seasons';
import { Logo } from './Logo';
import { useEscape } from './useEscape';

/**
 * Record-chasing launcher (opponent-free score attack). Unlike the custom-room
 * lobby, this is streamlined: connect → create a PRIVATE record room → auto-start
 * (the solo player is the room's host), then hand a ServerSession to the game.
 * The whole run executes on the authoritative server, so it's recorded + (if the
 * player is signed in) persisted to the leaderboard. Retries `start` while the
 * server's Rapier WASM is still loading after an auto-stop cold boot.
 */
export function RecordRun({
  settings,
  mode,
  onStart,
  onCancel,
}: {
  settings: GameSettings;
  mode: RecordKind;
  onStart: (s: NetSession) => void;
  onCancel: () => void;
}) {
  const [status, setStatus] = useState('Connecting to the record server…');
  const [error, setError] = useState('');
  const startedRef = useRef(false);

  useEscape(onCancel); // Esc backs out, same as ← Back

  // Connect straight away. The region picker used to gate this screen on EVERY
  // run, which made a one-time preference into a per-run prompt; it now lives in
  // the top bar (`ServerMenu`) and the run just uses the current selection.
  useEffect(() => {
    if (!gameServerUrl()) {
      setError('The game server isn’t configured.');
      return;
    }
    const room = 'rec-' + Math.random().toString(36).slice(2, 9); // private, ephemeral
    // route to the picked region (one-app multi-region); solo, so no cross-region concern
    const region = selectedServer()?.region ?? '';
    const url = multiServer() && region ? gameServerUrlWith({ region }) : gameServerUrl();
    let transport: WebSocketTransport;
    try {
      transport = new WebSocketTransport(url);
    } catch {
      setError('Could not reach the game server.');
      return;
    }
    const lobby = new LobbyClient(transport);
    let tries = 0;
    let timer: number | undefined;

    const tryStart = (): void => {
      if (startedRef.current) return;
      lobby.start();
      // keep nudging: a cold-booted server refuses 'start' until physics is ready
      if (++tries < 25) timer = window.setTimeout(tryStart, 700);
      else setError('The server took too long to start. Try again.');
    };

    lobby.on('roster', () => {
      if (!startedRef.current && tries === 0) {
        setStatus('Starting your run…');
        tryStart();
      }
    });
    lobby.on('matchStart', (m: MatchStart) => {
      startedRef.current = true;
      if (timer) window.clearTimeout(timer);
      onStart(new ServerSession(transport, lobby.isHost(), m, lobby.clientId, room));
    });
    lobby.on('error', (msg) => {
      if (!/starting up/i.test(msg)) setError(msg); // startup ⇒ the retry loop handles it
    });
    lobby.on('closed', () => {
      if (!startedRef.current) setError('Lost connection to the game server.');
    });

    lobby.join(
      room,
      {
        name: settings.spec.teamName || 'Player',
        teamName: settings.spec.teamName,
        teamNumber: settings.spec.teamNumber,
        alliance: 'blue', // record runs are forced to one alliance server-side
        startIndex: settings.startIndex,
        startPose: settings.startPose ?? null,
        ready: true,
        spec: settings.spec,
        assists: settings.assists,
      },
      { kind: 'record', record: mode, game: settings.game },
    );

    return () => {
      if (timer) window.clearTimeout(timer);
      if (!startedRef.current) lobby.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** the console scaffold every full-screen setup surface shares (Lobby,
   * Matchmaking, MatchStrategy) — back control + brand mark, then a titled panel. */
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
        <p className="ds-sub" style={{ marginTop: -10 }}>
          {sub}
        </p>
        <div className="ds-panelbox">{body}</div>
      </div>
    </div>
  );

  const kind = mode === 'duo' ? 'Duo 2v0' : 'Solo 1v0';

  if (error) {
    return page(
      <>
        Couldn’t <span className="accent">start</span>
      </>,
      kind,
      <>
        <p className="ds-form-err">⚠ {error}</p>
        <div className="ds-actions">
          <button className="ds-cta ghost" onClick={onCancel}>
            BACK TO HOME
          </button>
        </div>
      </>,
    );
  }

  return page(
    <>
      Record <span className="accent">Run</span>
    </>,
    `${kind} · ${status}`,
    <>
      <p className="ds-hint">
        First run after a quiet spell waits a few seconds for the server to wake.
      </p>
      <div className="ds-actions">
        <button className="ds-cta ghost" onClick={onCancel}>
          BACK TO HOME
        </button>
      </div>
    </>,
  );
}
