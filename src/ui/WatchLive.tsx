import { useEffect, useState } from 'react';
import type { LiveRoom } from '../net/protocol';
import { fetchLiveRooms } from '../net/api';
import { gameServerConfigured } from '../net/env';
import { APP_NAME, seasonFor } from '../seasons';

/**
 * "Watch Live" — the list of matches currently in progress on the game server. Polls
 * `GET /api/live` every few seconds; clicking a card spectates that room (read-only,
 * via `onWatch(room.room)` → App opens a spectator session). Empty/looping-friendly:
 * shows a friendly empty state when nobody is playing.
 */
export function WatchLive({
  onWatch,
  onBack,
}: {
  onWatch: (roomCode: string) => void;
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
            <div className="big">No live matches right now</div>
            Check back when a match is in progress, or start one yourself.
          </div>
        </div>
      ) : (
        <div className="ds-opts" style={{ gap: 12 }}>
          {rooms.map((r) => (
            <button key={r.room} className="ds-opt" onClick={() => onWatch(r.room)}>
              <span className="ot">
                {teamLabel(r, 'red')} <span className="ds-muted">vs</span> {teamLabel(r, 'blue')}
              </span>
              <span className="od">
                {seasonFor(r.game).name} · {r.ranked ? 'Ranked' : 'Custom'} {r.mode} ·{' '}
                {phaseLabel(r.phase)} {r.timeLeft > 0 ? `· ${r.timeLeft}s` : ''} ·{' '}
                {r.score.red}–{r.score.blue}
                {r.spectators > 0 ? ` · 👁 ${r.spectators}` : ''}
              </span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

/** the drivers on one alliance, "Name (Team)", joined — or the alliance colour if empty */
function teamLabel(r: LiveRoom, alliance: 'red' | 'blue'): string {
  const names = r.players
    .filter((p) => p.alliance === alliance)
    .map((p) => (p.teamNumber ? `${p.name} #${p.teamNumber}` : p.name));
  return names.length ? names.join(' + ') : alliance.toUpperCase();
}

function phaseLabel(phase: string): string {
  switch (phase) {
    case 'auto': return 'Autonomous';
    case 'transition': return 'Transition';
    case 'teleop': return 'Driver-Controlled';
    case 'post': return 'Final';
    default: return phase;
  }
}
