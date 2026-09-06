import { useEffect, useState } from 'react';
import type { LiveRoom } from '../net/protocol';
import { fetchLiveRoom, fetchLiveRooms } from '../net/api';
import { gameServerConfigured } from '../net/env';
import { normalizeRoomCode, isValidRoomCode, ROOM_CODE_LENGTH } from '../net/roomCode';
import { APP_NAME, seasonFor } from '../seasons';

/**
 * "Watch Live" — the games currently in progress on the game server.
 *
 * The LIST is everything live EXCEPT custom rooms (the server decides that; see
 * `isPublicLive`) — ranked matches and record runs both appear. A custom room is
 * somebody's private game reached by a code they chose to hand out, so publishing
 * it here would hand that code to every visitor. They are still fully spectatable
 * — by CODE, in the box below, which is the same key that lets you join one.
 * Friends' custom games are reachable from the friends list without typing anything.
 *
 * Polls `GET /api/live` every few seconds; clicking a card spectates that room
 * (read-only, via `onWatch`). The card's region is passed along because a match may
 * be hosted anywhere in the fleet.
 */
export function WatchLive({
  onWatch,
  onBack,
}: {
  onWatch: (roomCode: string, region?: string) => void;
  /** return to the mode-select screen */
  onBack: () => void;
}) {
  const [rooms, setRooms] = useState<LiveRoom[] | null>(null);
  const [error, setError] = useState('');
  const configured = gameServerConfigured();

  useEffect(() => {
    if (!configured) return;
    let alive = true;
    const load = (): void => {
      fetchLiveRooms()
        .then((r) => {
          if (!alive) return;
          setRooms(r.rooms);
          setError('');
        })
        .catch((e: unknown) => {
          if (!alive) return;
          setError(e instanceof Error ? e.message : String(e));
        });
    };
    load();
    const t = window.setInterval(load, 4000); // live matches change fast — refresh often
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [configured]);

  return (
    <>
      <button className="ds-back" onClick={onBack}>
        ← Back
      </button>
      <p className="ds-eyebrow">{APP_NAME} · Live</p>
      <h1 className="ds-h1">Watch Live</h1>

      {!configured ? (
        <div className="ds-panel">
          <div className="ds-empty">
            <div className="big">Spectating needs the game server</div>
            Set <code>VITE_GAME_SERVER_URL</code> - live matches run on the match server.
          </div>
        </div>
      ) : error ? (
        <div className="ds-panel">
          <div className="ds-empty">
            <div className="big">Couldn’t reach the game server</div>
            {error}
          </div>
        </div>
      ) : rooms === null ? (
        <div className="ds-panel">
          <div className="ds-loading">Loading live matches…</div>
        </div>
      ) : rooms.length === 0 ? (
        <div className="ds-panel">
          <div className="ds-empty">
            <div className="big">Nothing live right now</div>
            Check back when a match or record run is in progress, or start one yourself. Playing a
            custom game with friends? Watch it with its room code below.
          </div>
        </div>
      ) : (
        <div className="ds-opts">
          {rooms.map((r) => (
            <button key={r.room} className="ds-opt" onClick={() => onWatch(r.room, r.region)}>
              <span className="ot">{title(r)}</span>
              <span className="od">
                {seasonFor(r.game).name} · {r.kind === 'record' ? 'Record' : 'Ranked'} {r.mode} ·{' '}
                {phaseLabel(r.phase)} {r.timeLeft > 0 ? `· ${r.timeLeft}s` : ''} · {score(r)}
                {r.spectators > 0 ? ` · 👁 ${r.spectators}` : ''}
              </span>
            </button>
          ))}
        </div>
      )}

      {configured && <WatchByCode onWatch={onWatch} />}
    </>
  );
}

/**
 * Spectate a CUSTOM game by its room code.
 *
 * Resolves the code before opening a socket, for two reasons. It tells the player
 * WHY nothing happened when the match has already finished (the alternative is a
 * connection that opens and then silently reports an unknown room), and it returns
 * the hosting region — which a bare custom code cannot encode and the spectate
 * socket cannot do without.
 */
function WatchByCode({ onWatch }: { onWatch: (roomCode: string, region?: string) => void }) {
  const [code, setCode] = useState('');
  const [status, setStatus] = useState<'idle' | 'looking' | 'missing'>('idle');
  const ready = isValidRoomCode(code);

  const go = (): void => {
    if (!ready || status === 'looking') return;
    setStatus('looking');
    void fetchLiveRoom(code).then((room) => {
      if (!room) {
        setStatus('missing');
        return;
      }
      setStatus('idle');
      onWatch(room.room, room.region);
    });
  };

  return (
    <div className="ds-panel">
      <h2 className="ds-h2">Watch a custom game</h2>
      <p className="ds-hint">
        Custom rooms aren’t listed publicly. Enter the room code to watch one.
      </p>
      <div className="ds-watchcode">
        <input
          className="ds-input"
          value={code}
          onChange={(e) => {
            setCode(normalizeRoomCode(e.target.value));
            setStatus('idle');
          }}
          onKeyDown={(e) => e.key === 'Enter' && go()}
          placeholder={'X'.repeat(ROOM_CODE_LENGTH)}
          maxLength={ROOM_CODE_LENGTH}
          spellCheck={false}
          autoCapitalize="characters"
          aria-label="Room code"
        />
        <button className="ds-btn" disabled={!ready || status === 'looking'} onClick={go}>
          {status === 'looking' ? 'LOOKING…' : 'WATCH'}
        </button>
      </div>
      {status === 'missing' && (
        <p className="ds-hint">
          No live match under that code. It may have finished, or the match hasn’t started yet —
          a room is only watchable once the drivers are playing.
        </p>
      )}
    </div>
  );
}

/** the card's headline: "red vs blue" for a match, just the runners for a record
 *  run — a solo attempt has no opponent, and "… vs BLUE" would invent one. */
function title(r: LiveRoom): React.ReactNode {
  if (r.kind === 'record') return r.players.map(driverLabel).join(' + ') || 'Record run';
  return (
    <>
      {teamLabel(r, 'red')} <span className="ds-muted">vs</span> {teamLabel(r, 'blue')}
    </>
  );
}

/** a record run scores one number; a match has two sides */
function score(r: LiveRoom): string {
  if (r.kind !== 'record') return `${r.score.red}–${r.score.blue}`;
  // the runner's robot sits on ONE alliance, so the other side is a constant 0
  return `${Math.max(r.score.red, r.score.blue)} pts`;
}

function driverLabel(p: LiveRoom['players'][number]): string {
  return p.teamNumber ? `${p.name} #${p.teamNumber}` : p.name;
}

/** the drivers on one alliance, "Name (Team)", joined — or the alliance colour if empty */
function teamLabel(r: LiveRoom, alliance: 'red' | 'blue'): string {
  const names = r.players.filter((p) => p.alliance === alliance).map(driverLabel);
  return names.length ? names.join(' + ') : alliance.toUpperCase();
}

function phaseLabel(phase: string): string {
  switch (phase) {
    case 'auto': return 'Autonomous';
    case 'transition': return 'Transition';
    case 'teleop': return 'Driver-Controlled';
    case 'post': return 'Final';
    case 'pre': return 'Pre-match';
    case 'freeplay': return 'Free Drive';
    default: return phase;
  }
}
