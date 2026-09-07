import { useEffect, useState } from 'react';
import type { GameId } from '../types';
import type { Replay } from '../sim/replay';
import { fetchPracticeRuns, type PracticeRun } from '../net/api';
import {
  listPracticeRuns,
  loadPracticeReplay,
  deletePracticeRun,
  MAX_LOCAL_RUNS,
  type PracticeRunMeta,
} from '../net/practiceRuns';
import { SIM_DT } from '../config';
import { fmtDay } from './fmtDate';

/**
 * SOLO PRACTICE REPLAYS — your own offline matches, on your own Career page.
 *
 * SELF-ONLY, and it hangs off `Stats` rather than the shared `CareerPanel` for the same reason
 * `StandingCard` does: `CareerView` also renders PUBLIC profiles, and these runs are offline
 * and unverified by construction. Beside somebody's real, server-witnessed results they would
 * read as competitive history, which is exactly what they are not.
 *
 * TWO SOURCES, ONE LIST. The account holds what was uploaded; this device holds everything
 * played on it, signed in or not. They are merged so a run appears once whether you were
 * signed in when you played it, whether the upload landed, and whether you are on the machine
 * you played it on.
 */

/** m:ss from a tick count — a practice run's length is its own match clock */
const runLength = (ticks: number): string => {
  const s = Math.max(0, Math.round(ticks * SIM_DT));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};


/** one row, from whichever side has it */
interface Row {
  key: string;
  at: number;
  score: number;
  ticks: number;
  /** the server's replay id, when the account has this run */
  replayId: string | null;
  /** the local id, when this device still holds the log */
  localId: string | null;
}

/** merge the account's runs with this device's, newest first, without double-counting one
 *  that is in both (the local copy records the id it was uploaded as) */
function mergeRuns(remote: PracticeRun[], local: PracticeRunMeta[]): Row[] {
  const rows: Row[] = [];
  const claimed = new Set<string>();
  for (const m of local) {
    if (m.remoteId) claimed.add(m.remoteId);
    const match = m.remoteId ? remote.find((r) => r.id === m.remoteId) : undefined;
    rows.push({
      key: m.id,
      at: m.at,
      score: m.score,
      ticks: m.ticks,
      replayId: match?.replayId ?? null,
      localId: m.id,
    });
  }
  for (const r of remote) {
    if (claimed.has(r.id)) continue;
    rows.push({
      key: r.id,
      at: new Date(r.createdAt).getTime(),
      score: r.score,
      ticks: r.ticks,
      replayId: r.replayId,
      localId: null,
    });
  }
  return rows.sort((a, b) => b.at - a.at);
}

export function PracticeReplays({
  signedIn,
  game,
  onWatchId,
  onWatchLocal,
}: {
  signedIn: boolean;
  game?: GameId;
  /** watch a run the ACCOUNT holds — opens the ordinary replay route by id */
  onWatchId?: (replayId: string) => void;
  /** watch a run only this DEVICE holds — the log is handed over directly, since there is
   *  no server id to fetch it by */
  onWatchLocal?: (replay: Replay) => void;
}) {
  const [remote, setRemote] = useState<PracticeRun[]>([]);
  const [local, setLocal] = useState<PracticeRunMeta[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = (): void => setLocal(listPracticeRuns());

  useEffect(() => {
    setLocal(listPracticeRuns());
    if (!signedIn) {
      setLoading(false);
      return;
    }
    let dead = false;
    fetchPracticeRuns(game)
      .then((runs) => {
        if (!dead) setRemote(runs ?? []);
      })
      .finally(() => {
        if (!dead) setLoading(false);
      });
    return () => {
      dead = true;
    };
  }, [signedIn, game]);

  const rows = mergeRuns(remote, local);

  return (
    <div className="ds-panel">
      <div className="ds-panel-h">
        <span className="ds-panel-title">Practice replays</span>
      </div>

      {loading && rows.length === 0 ? (
        <div className="ds-loading">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="ds-empty">
          <div className="big">No practice runs yet</div>
          Finish a Solo Practice match and it is kept here. Practice runs are never scored on a
          leaderboard.
        </div>
      ) : (
        <>
          {/* the same scroller the two sibling tables use. `.ds-panel` is
              `overflow: hidden` for its rounded corners, so a table wider than the
              panel is CUT rather than scrolled — this was the one list in the slice
              without it. */}
          <div className="mh-scroll">
            <table className="ds-table">
              <thead>
                <tr>
                  <th>Played</th>
                  <th className="num">Score</th>
                  <th className="num">Length</th>
                  <th className="r" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key}>
                    <td>{fmtDay(r.at)}</td>
                    <td className="num">{r.score}</td>
                    <td className="num">{runLength(r.ticks)}</td>
                    {/* NOT `.num` — this cell holds buttons, and `.ds-btn` is
                        inline-block, so JSX stripping the whitespace between the two
                        of them left them touching at 0px. The flex wrapper owns the
                        gap. */}
                    <td className="r">
                      <span className="pr-actions">
                        <button
                          className="ds-btn small"
                          onClick={() => {
                            // prefer the LOCAL log: it needs no round trip, and it is the copy
                            // that exists whether or not the upload ever landed
                            const body = r.localId ? loadPracticeReplay(r.localId) : null;
                            if (body && onWatchLocal) onWatchLocal(body);
                            else if (r.replayId && onWatchId) onWatchId(r.replayId);
                          }}
                          disabled={!(r.localId && loadPracticeReplay(r.localId)) && !r.replayId}
                        >
                          ▶ Watch
                        </button>
                        {r.localId && (
                          <button
                            className="ds-btn small ghost"
                            onClick={() => {
                              deletePracticeRun(r.localId!);
                              reload();
                            }}
                            title="Remove from this device"
                          >
                            ✕
                          </button>
                        )}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* a footer BAND, like `.mh-pager`: `.ds-hint` has `margin: 0` and
              `.ds-panel` has no padding, so this sentence sat flush in the panel's
              rounded bottom-left corner while the cell above it was inset 16. */}
          <p className="ds-panel-foot ds-hint">
            {signedIn
              ? `Last ${MAX_LOCAL_RUNS} runs are saved.`
              : `Last ${MAX_LOCAL_RUNS} runs are saved on this device. Sign in to keep them on your account.`}
          </p>
        </>
      )}
    </div>
  );
}
