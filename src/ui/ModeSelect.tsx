import { APP_NAME } from '../seasons';
import { QueueCounts } from './QueueCounts';

/**
 * Game-mode select — reached from PLAY. These are the tiles that used to live on
 * Home. Every start action is still wrapped in App's `guardStart()` (stale-build
 * refresh + scheduled-restart block) by the caller, so nothing here bypasses it.
 */
export function ModeSelect({
  multiplayer,
  signedIn,
  activeGame,
  onRejoin,
  onFreeDrive,
  onSoloMatch,
  onRecordRun,
  onDuoRecord,
  onRanked,
  onCustomRoom,
  onWatch,
}: {
  multiplayer: boolean;
  signedIn: boolean;
  /** a multiplayer game this browser is mid-way through (offer to rejoin it), or null */
  activeGame: { kind: 'ranked' | 'custom' | 'record' } | null;
  onRejoin: () => void;
  onFreeDrive: () => void;
  onSoloMatch: () => void;
  onRecordRun: () => void;
  onDuoRecord: () => void;
  onRanked: () => void;
  onCustomRoom: () => void;
  onWatch: () => void;
}) {
  return (
    <>
      <p className="ds-eyebrow">{APP_NAME} · Play</p>
      <h1 className="ds-h1">Pick a mode</h1>

      {activeGame && (
        <div className="ds-rejoin" role="alert">
          <b>You’re already in a game.</b>
          <button className="ds-btn primary" onClick={onRejoin}>
            Rejoin match →
          </button>
        </div>
      )}

      {/* Offline, always available — the safe default (Solo Practice is primary) */}
      <section className="ds-tileset">
        <p className="ds-tileset-label">Practice · offline</p>
        <div className="ds-tiles">
          <button className="ds-tile primary" onClick={onSoloMatch}>
            <span className="k">Solo</span>
            <span>
              <span className="t">Solo Practice</span>
            </span>
          </button>

          <button className="ds-tile" onClick={onFreeDrive}>
            <span className="k">Practice</span>
            <span>
              <span className="t">Free Drive</span>
            </span>
          </button>
        </div>
      </section>

      {/* Online — ranked + score-attack records (need the game server / sign-in) */}
      <section className="ds-tileset">
        <p className="ds-tileset-label">Compete · online</p>
        <div className="ds-tiles">
          <button className="ds-tile" onClick={onRanked} disabled={!multiplayer || !signedIn}>
            <span className="k">Ranked</span>
            <span>
              <span className="t">
                Find Match
                <QueueCounts className="tile" />
              </span>
              {/* ⚠️ CONDITIONAL, and it must stay that way. A previous pass rendered
                  this line ALWAYS, with a non-breaking space when there was nothing to
                  say, to stop the tile growing when `signedIn` resolves asynchronously.
                  That trade is backwards: `.ds-tiles` is a grid, so the reserved line
                  made Find Match, Solo Record AND Duo Record permanently a line taller
                  for everyone, to spare signed-in users one shrink at first paint —
                  and most visitors are signed out, where the line is there from the
                  start and never moves at all. If the shift is worth fixing, thread an
                  `authReady` flag down from AccountSync; do not reserve the line. */}
              {(!multiplayer || !signedIn) && (
                <span className="d">
                  {!multiplayer ? 'Needs the game server' : 'Sign in to play ranked'}
                </span>
              )}
            </span>
          </button>

          <button className="ds-tile" onClick={onRecordRun} disabled={!multiplayer}>
            <span className="k">Records</span>
            <span>
              <span className="t">Solo Record</span>
              {!multiplayer && <span className="d">Needs the game server</span>}
            </span>
          </button>

          <button className="ds-tile" onClick={onDuoRecord} disabled={!multiplayer}>
            <span className="k">Records</span>
            <span>
              <span className="t">Duo Record</span>
              {!multiplayer && <span className="d">Needs the game server</span>}
            </span>
          </button>
        </div>
      </section>

      {/* Custom room — last, per its niche use */}
      <section className="ds-tileset">
        <p className="ds-tileset-label">Custom · online</p>
        <div className="ds-tiles">
          <button className="ds-tile" onClick={onCustomRoom} disabled={!multiplayer}>
            <span className="k">Custom</span>
            <span>
              <span className="t">Custom Room</span>
              {!multiplayer && <span className="d">Needs the game server</span>}
            </span>
          </button>
          <button className="ds-tile" onClick={onWatch} disabled={!multiplayer}>
            <span className="k">Live</span>
            <span>
              <span className="t">Watch Live</span>
              {!multiplayer && <span className="d">Needs the game server</span>}
            </span>
          </button>
        </div>
      </section>
    </>
  );
}
